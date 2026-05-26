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
	MsgAuctionEnd    MessageType = "auction_end"
	MsgAuctionStart  MessageType = "auction_start"
	MsgAuctionCancel MessageType = "auction_cancel"
	MsgCountdown     MessageType = "countdown"
	MsgError         MessageType = "error"
	MsgViewUpdate    MessageType = "view_update"
)

// AuctionCancelData is the payload for auction_cancel messages
type AuctionCancelData struct {
	AuctionID uint   `json:"auction_id"`
	Reason    string `json:"reason"`
}

// Message is the standard WebSocket message envelope
type Message struct {
	Type      MessageType     `json:"type"`
	AuctionID uint            `json:"auction_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
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
		clients:    make(map[*Client]bool),
		rooms:      make(map[uint]map[*Client]bool),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
		broadcast:  make(chan *RoomMessage, 1024),
		seqMap:     make(map[uint]uint64),
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
			h.mu.Unlock()
			log.Printf("Client registered: user=%d, total=%d", client.UserID, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				// Remove from all rooms
				for auctionID, room := range h.rooms {
					if _, inRoom := room[client]; inRoom {
						delete(room, client)
						if len(room) == 0 {
							delete(h.rooms, auctionID)
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

func (h *Hub) RegisterClient(client *Client) {
	h.register <- client
}

func (h *Hub) UnregisterClient(client *Client) {
	h.unregister <- client
}
