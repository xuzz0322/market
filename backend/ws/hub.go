package ws

import (
	"encoding/json"
	"log"
	"sync"
)

// MessageType defines WebSocket message types
type MessageType string

const (
	MsgJoinAuction   MessageType = "join_auction"
	MsgLeaveAuction  MessageType = "leave_auction"
	MsgPlaceBid      MessageType = "place_bid"
	MsgBidUpdate     MessageType = "bid_update"
	MsgBidOutbid     MessageType = "bid_outbid"   // personal: "you've been outbid"
	MsgAuctionEnd    MessageType = "auction_end"
	MsgAuctionStart  MessageType = "auction_start"
	MsgAuctionCancel MessageType = "auction_cancel"
	MsgCountdown     MessageType = "countdown"
	MsgError         MessageType = "error"
	MsgViewUpdate    MessageType = "view_update"

	// Auction-room (multi-auction host space) channel messages.
	MsgJoinRoom    MessageType = "join_room"
	MsgLeaveRoom   MessageType = "leave_room"
	// Host signals start/stop of live A/V commentary. Server broadcasts to
	// the room channel so all current viewers can negotiate WebRTC peers.
	MsgStreamStart MessageType = "stream_start"
	MsgStreamStop  MessageType = "stream_stop"
	// WebRTC signaling envelope (offer/answer/ice). Server is a pure
	// router — it forwards by user_id without inspecting the SDP/ICE
	// payload. Used between host ↔ each viewer in a mesh topology.
	MsgWebRTCSignal MessageType = "webrtc_signal"

	// Live chat in an auction room. Clients send chat_send; server
	// validates + rate-limits, then re-emits chat_message to every member
	// of the room channel.
	MsgChatSend    MessageType = "chat_send"
	MsgChatMessage MessageType = "chat_message"

	// Follow-system push: sent personally to a user when a host they
	// follow goes live or starts a new auction.
	MsgHostLive        MessageType = "host_live"
	MsgAuctionStarting MessageType = "auction_starting"
	// MsgHeatUpdate is a global broadcast sent every heat-scan cycle with
	// the current top-N ranked rooms. Clients use it to re-sort the feed
	// without polling.
	MsgHeatUpdate MessageType = "heat_update"
	// MsgDMReceived is pushed personally to a user when they receive a
	// private message. Contains sender info and message body so the client
	// can surface a toast without polling the inbox endpoint.
	MsgDMReceived MessageType = "dm_received"
)

// AuctionCancelData is the payload for auction_cancel messages
type AuctionCancelData struct {
	AuctionID uint   `json:"auction_id"`
	Reason    string `json:"reason"`
}

// BidOutbidData is the personal "you've been outbid" notification.
// Sent ONLY to the user who was just displaced by a higher bid — not to
// the room. The frontend uses this to surface a toast and a "bid again"
// CTA without needing to diff every bid_update against the user's
// previous standing.
type BidOutbidData struct {
	AuctionID    uint    `json:"auction_id"`
	ProductTitle string  `json:"product_title"`
	YourBid      float64 `json:"your_bid"`      // user's previous (now outbid) amount
	CurrentPrice float64 `json:"current_price"` // the price that beat them
	NewLeader    string  `json:"new_leader"`    // username of the user who outbid them
	SecondsLeft  int     `json:"seconds_left"`
}

// Message is the standard WebSocket message envelope
type Message struct {
	Type      MessageType     `json:"type"`
	AuctionID uint            `json:"auction_id,omitempty"`
	RoomID    uint            `json:"room_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// WebRTCSignalData carries opaque signaling between host and viewer. Server
// only inspects To/From; the rest is delivered verbatim. From is always
// stamped server-side from the authenticated client — clients cannot spoof.
type WebRTCSignalData struct {
	From       uint            `json:"from"`
	To         uint            `json:"to"`
	SignalType string          `json:"signal_type"` // "offer" | "answer" | "ice" | "request" | "bye"
	Payload    json.RawMessage `json:"payload"`
	RoomID     uint            `json:"room_id"`
}

// StreamStateData notifies room viewers of the current host stream status.
// Sent on stream_start / stream_stop and as a personal snapshot when a
// viewer joins a room that's already streaming.
type StreamStateData struct {
	RoomID    uint `json:"room_id"`
	HostID    uint `json:"host_id"`
	Streaming bool `json:"streaming"`
}

// ChatSendData is what the client sends. Server enriches it with sender
// identity (taken from the authenticated WS session) before re-broadcasting
// as MsgChatMessage.
type ChatSendData struct {
	Text string `json:"text"`
}

// ChatMessageData is the broadcast shape every viewer receives. ID is a
// monotonic per-message client-side disambiguator (so React can use it as
// a key without collisions if two messages share the same wall-clock ms).
type ChatMessageData struct {
	RoomID    uint   `json:"room_id"`
	UserID    uint   `json:"user_id"`
	Username  string `json:"username"`
	Avatar    string `json:"avatar"`
	Text      string `json:"text"`
	IsHost    bool   `json:"is_host"`
	Timestamp int64  `json:"timestamp"`
}

// HostLiveData is pushed personally to followers when a host they follow
// starts streaming. Carries enough info for a notification toast without
// the client needing a follow-up fetch.
type HostLiveData struct {
	HostID    uint   `json:"host_id"`
	Username  string `json:"username"`
	RoomID    uint   `json:"room_id"`
	RoomTitle string `json:"room_title"`
}

// AuctionStartingData notifies followers when a host starts a new auction
// (typically inside a room they care about).
type AuctionStartingData struct {
	HostID       uint   `json:"host_id"`
	Username     string `json:"username"`
	AuctionID    uint   `json:"auction_id"`
	ProductTitle string `json:"product_title"`
	RoomID       uint   `json:"room_id,omitempty"`
}

// BidUpdateData is the payload for bid_update messages.
//
// Reliability fields:
//   - Seq: per-auction monotonically increasing sequence. Clients detect
//     gaps (seq jumped from N to N+2) and recover by re-fetching the
//     auction over HTTP. This makes WS message loss self-healing — no
//     need to deliver every message, just every gap eventually heals.
//   - ServerTimeMs: server wall-clock at the moment of broadcast. Clients
//     use this to compute their clock skew vs server (delta = serverNow -
//     localNow), so countdowns stay accurate even with bad client clocks.
//   - EndAtMs: absolute end time as server-side ms timestamp. Clients
//     count down by `endAtMs - (Date.now() + delta)` instead of decrementing
//     a local int every second — robust against tab throttling, sleep, etc.
type BidUpdateData struct {
	AuctionID    uint        `json:"auction_id"`
	CurrentPrice float64     `json:"current_price"`
	BidCount     int         `json:"bid_count"`
	LastBidder   string      `json:"last_bidder"`
	Rankings     interface{} `json:"rankings"`
	ViewerCount  int         `json:"viewer_count"`  // live concurrent viewers in the room
	SecondsLeft  int         `json:"seconds_left"`  // kept for backward compat
	EndAtMs      int64       `json:"end_at_ms"`     // absolute end time (server time, ms)
	ServerTimeMs int64       `json:"server_time_ms"` // server's "now" at broadcast time
	Seq          uint64      `json:"seq"`           // per-auction monotonic sequence
}

// AuctionEndData is the payload for auction_end messages
type AuctionEndData struct {
	AuctionID    uint    `json:"auction_id"`
	WinnerID     *uint   `json:"winner_id"`
	WinnerName   string  `json:"winner_name"`
	FinalPrice   float64 `json:"final_price"`
}

// Hub maintains active clients and broadcasts messages
type Hub struct {
	mu       sync.RWMutex
	clients  map[*Client]bool
	rooms    map[uint]map[*Client]bool // auctionID -> clients
	// auctionRoomMembers indexes clients by AuctionRoom (host space) so we
	// can fan out room-scoped messages independently of any specific
	// auction. A client can be in both a room channel AND an auction room
	// at the same time when the room is live-streaming a current auction.
	auctionRoomMembers map[uint]map[*Client]bool
	// userClients indexes connections by user_id so we can push targeted
	// notifications (e.g., "you've been outbid") without scanning every
	// client. A single user can have multiple connections (mobile + web)
	// open at once, so the value is a set of clients, not one.
	userClients map[uint]map[*Client]bool
	register chan *Client
	unregister chan *Client
	broadcast  chan *RoomMessage

	// seqMu protects per-auction sequence counters. Each auction has its
	// own monotonic sequence; clients use it to detect dropped/reordered
	// updates. Atomic-per-key would be cleaner but the map needs a mutex
	// for the get-or-create path anyway.
	seqMu  sync.Mutex
	seqMap map[uint]uint64

	// remotePublish, if non-nil, is invoked for every BroadcastToRoom and
	// BroadcastAll call so the message is also sent to other backend
	// instances via Redis Pub/Sub. The local in-memory broadcast still
	// fires immediately — Pub/Sub is purely additive for multi-pod
	// deploys, never on the latency-critical path.
	remotePublish func(auctionID uint, globalAll bool, payload []byte)
}

type RoomMessage struct {
	AuctionID uint
	Message   []byte
	Broadcast bool // if true, send to all clients regardless of room
}

func NewHub() *Hub {
	return &Hub{
		clients:            make(map[*Client]bool),
		rooms:              make(map[uint]map[*Client]bool),
		auctionRoomMembers: make(map[uint]map[*Client]bool),
		userClients:        make(map[uint]map[*Client]bool),
		register:           make(chan *Client, 256),
		unregister:         make(chan *Client, 256),
		broadcast:          make(chan *RoomMessage, 1024),
		seqMap:             make(map[uint]uint64),
	}
}

// NextSeq returns the next monotonic sequence number for a given auction.
// Clients use this to detect gaps in the bid_update stream — when a gap
// is detected they fall back to a full HTTP fetch.
func (h *Hub) NextSeq(auctionID uint) uint64 {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	h.seqMap[auctionID]++
	return h.seqMap[auctionID]
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			// Index by user_id so pushUser can reach all of this user's
			// connections (e.g., they have phone + web open at once).
			if h.userClients[client.UserID] == nil {
				h.userClients[client.UserID] = make(map[*Client]bool)
			}
			h.userClients[client.UserID][client] = true
			h.mu.Unlock()
			log.Printf("Client registered: user=%d, total=%d", client.UserID, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				// Remove from user index. Drop the bucket entirely once
				// the user has no remaining connections so the map
				// doesn't grow without bound.
				if conns, ok := h.userClients[client.UserID]; ok {
					delete(conns, client)
					if len(conns) == 0 {
						delete(h.userClients, client.UserID)
					}
				}
				// Remove from all rooms
				for auctionID, room := range h.rooms {
					if _, inRoom := room[client]; inRoom {
						delete(room, client)
						if len(room) == 0 {
							delete(h.rooms, auctionID)
						}
					}
				}
				// Remove from all auction-room channels.
				for roomID, members := range h.auctionRoomMembers {
					if _, in := members[client]; in {
						delete(members, client)
						if len(members) == 0 {
							delete(h.auctionRoomMembers, roomID)
						}
					}
				}
				close(client.Send)
			}
			h.mu.Unlock()
			log.Printf("Client unregistered: user=%d, remaining=%d", client.UserID, len(h.clients))

		case msg := <-h.broadcast:
			// Fan out without holding any lock during channel sends —
			// slow clients must NEVER block other clients in the same room.
			//
			// Strategy: snapshot the recipient list under RLock, then send
			// outside the lock. For each client, try a non-blocking send;
			// on overflow, drop-oldest from that client's queue and retry.
			// We DO NOT close the connection on a single overflow — under
			// network jitter, transient buffer pressure is normal and
			// kicking the client only makes recovery harder. Only after
			// repeated overflows (tracked on the client) do we disconnect.
			recipients := h.snapshotRecipients(msg)
			for _, client := range recipients {
				h.deliver(client, msg.Message)
			}
		}
	}
}

// snapshotRecipients takes a quick read of who should receive this message,
// then releases the lock before any I/O. This is the key to scaling the hub
// to 10k+ concurrent rooms — we never hold the hub lock during sends.
func (h *Hub) snapshotRecipients(msg *RoomMessage) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*Client
	if msg.Broadcast {
		out = make([]*Client, 0, len(h.clients))
		for c := range h.clients {
			out = append(out, c)
		}
		return out
	}
	room := h.rooms[msg.AuctionID]
	out = make([]*Client, 0, len(room))
	for c := range room {
		out = append(out, c)
	}
	return out
}

// deliver tries to enqueue a message to a client. On overflow it drops the
// oldest queued message and retries — newest data is more relevant for
// auctions (a stale "current_price" event is useless once a fresher one
// exists). Counts overflows so a chronically slow client can be disconnected
// (handled in Client.WritePump or the hub idle sweeper).
func (h *Hub) deliver(client *Client, payload []byte) {
	select {
	case client.Send <- payload:
		return
	default:
	}
	// Channel full — drop oldest, push newest.
	select {
	case <-client.Send: // discard oldest
	default:
	}
	select {
	case client.Send <- payload:
	default:
		// Still full (extremely backed up). Note: we deliberately do NOT
		// close the conn here. The WritePump's write-deadline + ping
		// handler will cull genuinely dead clients within ~60s.
		client.dropCount.Add(1)
	}
}

func (h *Hub) JoinRoom(client *Client, auctionID uint) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[auctionID] == nil {
		h.rooms[auctionID] = make(map[*Client]bool)
	}
	h.rooms[auctionID][client] = true
	log.Printf("User %d joined auction room %d (room size: %d)", client.UserID, auctionID, len(h.rooms[auctionID]))
}

func (h *Hub) LeaveRoom(client *Client, auctionID uint) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[auctionID]; ok {
		delete(room, client)
		if len(room) == 0 {
			delete(h.rooms, auctionID)
		}
	}
}

// JoinAuctionRoom subscribes a client to a host-owned room channel. Distinct
// from JoinRoom (which keys on auction_id) — a viewer can be in both
// simultaneously when watching a live-auction inside a room.
func (h *Hub) JoinAuctionRoom(client *Client, roomID uint) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.auctionRoomMembers[roomID] == nil {
		h.auctionRoomMembers[roomID] = make(map[*Client]bool)
	}
	h.auctionRoomMembers[roomID][client] = true
}

func (h *Hub) LeaveAuctionRoom(client *Client, roomID uint) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if members, ok := h.auctionRoomMembers[roomID]; ok {
		delete(members, client)
		if len(members) == 0 {
			delete(h.auctionRoomMembers, roomID)
		}
	}
}

// BroadcastToAuctionRoom fans out a message to every client subscribed to a
// host-owned room channel. Used for stream_start/stream_stop notifications
// and any future room-level event (host announcements, item intro updates).
//
// Does NOT remote-publish via Pub/Sub: room signaling is per-pod for the v1
// WebRTC mesh implementation. Cross-pod relay can be added later if a host
// and a viewer ever land on different pods (today they'd both go through
// the load balancer's sticky session anyway).
func (h *Hub) BroadcastToAuctionRoom(roomID uint, msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling room broadcast: %v", err)
		return
	}
	h.mu.RLock()
	members := h.auctionRoomMembers[roomID]
	clients := make([]*Client, 0, len(members))
	for c := range members {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		h.deliver(c, data)
	}
}

// SetRemotePublisher wires the Pub/Sub bridge so every broadcast also
// reaches other instances. Pass nil to run single-instance.
func (h *Hub) SetRemotePublisher(fn func(auctionID uint, globalAll bool, payload []byte)) {
	h.remotePublish = fn
}

// DispatchLocal pushes a message into the local broadcast queue WITHOUT
// re-publishing to Redis. Used by the Pub/Sub subscriber when it receives
// a broadcast that originated on another instance — we just want to fan
// it out to local clients.
func (h *Hub) DispatchLocal(auctionID uint, globalAll bool, payload []byte) {
	if globalAll {
		h.broadcast <- &RoomMessage{Broadcast: true, Message: payload}
		return
	}
	h.broadcast <- &RoomMessage{AuctionID: auctionID, Message: payload}
}

func (h *Hub) BroadcastToRoom(auctionID uint, msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling broadcast message: %v", err)
		return
	}
	// Local first — same-pod clients see updates without round-tripping
	// through Redis (saves ~1ms vs publish-then-subscribe-then-dispatch).
	h.broadcast <- &RoomMessage{AuctionID: auctionID, Message: data}
	if h.remotePublish != nil {
		h.remotePublish(auctionID, false, data)
	}
}

func (h *Hub) BroadcastAll(msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling broadcast message: %v", err)
		return
	}
	h.broadcast <- &RoomMessage{Broadcast: true, Message: data}
	if h.remotePublish != nil {
		h.remotePublish(0, true, data)
	}
}

func (h *Hub) GetRoomSize(auctionID uint) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[auctionID])
}

// PushToUser fans a message out to all of one user's connected sockets.
//
// Use cases:
//   - "You've been outbid" — personal alert that wouldn't make sense to
//     room-broadcast (only one user cares).
//   - "Your auction was won" — for the seller, push to whichever device
//     they have open (web admin, phone) without spamming everyone else.
//
// If the user has no active connections (offline / different device),
// the message is silently dropped — call sites should NOT depend on
// PushToUser for durable delivery. For "must-deliver" notifications,
// pair this with a DB-backed inbox the user reads on next login.
func (h *Hub) PushToUser(userID uint, msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// Snapshot under lock then send outside, like our room broadcasts.
	h.mu.RLock()
	conns := h.userClients[userID]
	clients := make([]*Client, 0, len(conns))
	for c := range conns {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		h.deliver(c, data)
	}
}

func (h *Hub) RegisterClient(client *Client) {
	h.register <- client
}

func (h *Hub) UnregisterClient(client *Client) {
	h.unregister <- client
}
