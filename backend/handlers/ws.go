package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	gws "github.com/gorilla/websocket"
	"gorm.io/gorm"

	"market/cache"
	"market/models"
	"market/services"
	ws "market/ws"
)

var upgrader = gws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type WSHandler struct {
	db         *gorm.DB
	hub        *ws.Hub
	auctionSvc *services.AuctionService
	viewers    *cache.ViewerCounter
	// chatLimiter caps each user's chat throughput to one message per
	// chatCooldown. Bare map + mutex is sufficient — chat is rare relative
	// to bid traffic and the rate-limiter implementations elsewhere are
	// designed for token-bucket-style HTTP throttling.
	chatLimiter   sync.Map
	chatCooldown  time.Duration
	chatMaxLen    int
}

func NewWSHandler(db *gorm.DB, hub *ws.Hub, svc *services.AuctionService, viewers *cache.ViewerCounter) *WSHandler {
	return &WSHandler{
		db: db, hub: hub, auctionSvc: svc, viewers: viewers,
		chatCooldown: 1500 * time.Millisecond,
		chatMaxLen:   200,
	}
}

func (h *WSHandler) ServeWS(c *gin.Context) {
	userID := c.GetUint("userID")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	client := &ws.Client{
		Hub:    h.hub,
		Conn:   conn,
		Send:   make(chan []byte, 256),
		UserID: userID,
	}

	h.hub.RegisterClient(client)

	go client.WritePump()
	client.ReadPump(h.handleMessage)
}

func (h *WSHandler) handleMessage(client *ws.Client, msg *ws.Message) {
	switch msg.Type {
	case ws.MsgJoinAuction:
		h.handleJoinAuction(client, msg)
	case ws.MsgLeaveAuction:
		h.hub.LeaveRoom(client, msg.AuctionID)

	case ws.MsgJoinRoom:
		h.handleJoinRoom(client, msg)
	case ws.MsgLeaveRoom:
		if msg.RoomID > 0 {
			h.hub.LeaveAuctionRoom(client, msg.RoomID)
		}
	case ws.MsgStreamStart:
		h.handleStreamToggle(client, msg, true)
	case ws.MsgStreamStop:
		h.handleStreamToggle(client, msg, false)
	case ws.MsgWebRTCSignal:
		h.handleWebRTCSignal(client, msg)
	case ws.MsgChatSend:
		h.handleChatSend(client, msg)
	}
}

func (h *WSHandler) handleJoinAuction(client *ws.Client, msg *ws.Message) {
	if msg.AuctionID == 0 {
		return
	}
	h.hub.JoinRoom(client, msg.AuctionID)

	var auction models.Auction
	if err := h.db.Preload("Product.Seller").Preload("Seller").Preload("Winner").
		First(&auction, msg.AuctionID).Error; err != nil {
		return
	}

	// Increment viewer count via Redis (lock-free) instead of MySQL UPDATE
	// (row-lock contention on hot rows). The flusher periodically reconciles
	// the Redis delta back into MySQL so existing reports keep working.
	if h.viewers != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		h.viewers.Inc(ctx, msg.AuctionID)
		cancel()
	} else {
		// Redis disabled fallback — original MySQL path.
		h.db.Model(&auction).UpdateColumn("view_count", gorm.Expr("view_count + 1"))
	}

	// Send a personal snapshot — bypasses the room broadcast so newly-joined
	// clients get state immediately without disturbing existing viewers.
	// The seq advances, so this client's "next expected seq" is now in sync
	// with the room's stream.
	h.auctionSvc.SendBidStateTo(client, &auction)
}

// handleJoinRoom subscribes the client to a host-owned auction room channel
// and, if the host is currently streaming, sends a personal stream_start
// snapshot so the new viewer can immediately request a WebRTC offer.
func (h *WSHandler) handleJoinRoom(client *ws.Client, msg *ws.Message) {
	if msg.RoomID == 0 {
		return
	}
	h.hub.JoinAuctionRoom(client, msg.RoomID)

	var room models.AuctionRoom
	if err := h.db.First(&room, msg.RoomID).Error; err != nil {
		return
	}
	if room.IsStreaming {
		// Personal snapshot — the room-wide broadcast already happened on
		// the original stream_start. Without this, viewers who join after
		// the broadcast would have no way to know to request the stream.
		client.SendMessage(ws.Message{
			Type:   ws.MsgStreamStart,
			RoomID: room.ID,
			Data:   mustMarshalAny(ws.StreamStateData{RoomID: room.ID, HostID: room.HostID, Streaming: true}),
		})
	}
}

// handleStreamToggle marks the room's IsStreaming flag and broadcasts the
// state change. Only the host can toggle. Idempotent — repeated start/stop
// events are safe (DB write is the same value, broadcast is harmless).
func (h *WSHandler) handleStreamToggle(client *ws.Client, msg *ws.Message, on bool) {
	if msg.RoomID == 0 {
		return
	}
	var room models.AuctionRoom
	if err := h.db.First(&room, msg.RoomID).Error; err != nil {
		return
	}
	if room.HostID != client.UserID {
		// Silently drop — UI shouldn't surface this button to non-hosts
		// anyway. Logging would be noise.
		return
	}
	h.db.Model(&room).Update("is_streaming", on)

	t := ws.MsgStreamStart
	if !on {
		t = ws.MsgStreamStop
	}
	h.hub.BroadcastToAuctionRoom(room.ID, ws.Message{
		Type:   t,
		RoomID: room.ID,
		Data:   mustMarshalAny(ws.StreamStateData{RoomID: room.ID, HostID: room.HostID, Streaming: on}),
	})

	// Push personal "host you follow just went live" alerts. Done as a
	// goroutine so the live-toggle response isn't blocked by the fan-out.
	if on {
		go h.auctionSvc.NotifyFollowersHostLive(room.HostID, room.ID)
	}
}

// handleWebRTCSignal forwards a signaling envelope to the targeted user.
// Server stamps the From field server-side from the authenticated client
// so peers can't spoof their identity. The Payload (SDP / ICE candidate)
// is delivered verbatim — server doesn't parse it, keeping the signaling
// path agnostic to WebRTC protocol changes.
func (h *WSHandler) handleWebRTCSignal(client *ws.Client, msg *ws.Message) {
	if len(msg.Data) == 0 {
		return
	}
	var sig ws.WebRTCSignalData
	if err := json.Unmarshal(msg.Data, &sig); err != nil {
		return
	}
	if sig.To == 0 || sig.RoomID == 0 {
		return
	}
	// Force authentic sender. Clients can lie about From in the payload;
	// stamping it here keeps the protocol trustworthy even with a malicious
	// peer.
	sig.From = client.UserID

	out, err := json.Marshal(sig)
	if err != nil {
		return
	}
	h.hub.PushToUser(sig.To, ws.Message{
		Type:   ws.MsgWebRTCSignal,
		RoomID: sig.RoomID,
		Data:   out,
	})
}

// mustMarshalAny is a tiny convenience for inline marshaling; on the rare
// chance of a marshal failure we fall back to an empty payload rather than
// panicking the entire WS pipeline.
func mustMarshalAny(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// handleChatSend validates a chat payload, stamps the sender's identity,
// and re-broadcasts it as MsgChatMessage to the room channel.
//
// Spam controls:
//   - Per-user 1.5s cooldown. Anything faster is silently dropped — we
//     don't return an error because the legit cause is double-tap, not
//     malice, and an error toast would be more annoying than the dropped
//     line.
//   - 200-char hard cap.
//   - Empty / whitespace-only is dropped.
//
// We DON'T persist chat to the DB. The history of an ephemeral live-room
// chat isn't valuable enough to justify the write throughput, and viewers
// who join late get to watch the live conversation from their join point.
func (h *WSHandler) handleChatSend(client *ws.Client, msg *ws.Message) {
	if msg.RoomID == 0 || len(msg.Data) == 0 {
		return
	}
	var req ws.ChatSendData
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return
	}
	if len(text) > h.chatMaxLen {
		// Truncate rather than drop — better to deliver a slightly cut
		// message than to silently lose the user's intent.
		text = text[:h.chatMaxLen]
	}

	// Per-user rate limit.
	now := time.Now()
	if last, ok := h.chatLimiter.Load(client.UserID); ok {
		if t, ok2 := last.(time.Time); ok2 && now.Sub(t) < h.chatCooldown {
			return
		}
	}
	h.chatLimiter.Store(client.UserID, now)

	// Look up display fields once. We could cache these, but a chat
	// message that already involves a network broadcast doesn't gain much
	// from skipping a single indexed lookup.
	var u models.User
	if err := h.db.Select("id, username, avatar").First(&u, client.UserID).Error; err != nil {
		return
	}

	// Was the sender the host of this room? Used for UI emphasis (host
	// messages render with a colored badge so viewers can spot them).
	var isHost bool
	var room models.AuctionRoom
	if err := h.db.Select("id, host_id").First(&room, msg.RoomID).Error; err == nil {
		isHost = room.HostID == client.UserID
	}

	out := ws.ChatMessageData{
		RoomID:    msg.RoomID,
		UserID:    u.ID,
		Username:  u.Username,
		Avatar:    u.Avatar,
		Text:      text,
		IsHost:    isHost,
		Timestamp: now.UnixMilli(),
	}
	h.hub.BroadcastToAuctionRoom(msg.RoomID, ws.Message{
		Type:   ws.MsgChatMessage,
		RoomID: msg.RoomID,
		Data:   mustMarshalAny(out),
	})
}
