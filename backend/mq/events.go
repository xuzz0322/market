package mq

// ─── Event payload types ─────────────────────────────────────────────────────
// Kept in the mq package so producers and consumers share the same structs
// without importing heavy model packages from cache/services.

// OutbidEvent is published to TopicNotifyOutbid after a bid commits.
type OutbidEvent struct {
	AuctionID    uint    `json:"auction_id"`
	ProductTitle string  `json:"product_title"`
	DisplacedUID uint    `json:"displaced_uid"`
	YourBid      float64 `json:"your_bid"`
	NewPrice     float64 `json:"new_price"`
	NewLeader    string  `json:"new_leader"`
	SecondsLeft  int     `json:"seconds_left"`
}

// CreditEvent is published to TopicCreditAdjust for deferred score changes.
type CreditEvent struct {
	UserID    uint   `json:"user_id"`
	Delta     int    `json:"delta"`
	Reason    string `json:"reason"`   // models.CreditEventReason
	RefType   string `json:"ref_type"`
	RefID     uint   `json:"ref_id"`
	Note      string `json:"note"`
}

// HeatIncrEvent is published to TopicHeatIncr by bid/favorite handlers.
type HeatIncrEvent struct {
	Kind      string `json:"kind"`       // "bid" | "like"
	AuctionID uint   `json:"auction_id,omitempty"`
	RoomID    uint   `json:"room_id,omitempty"`
}

// DMEvent is published to TopicDM when a message is sent. The consumer
// writes the DB row and pushes the WS notification.
type DMEvent struct {
	SenderID   uint   `json:"sender_id"`
	ReceiverID uint   `json:"receiver_id"`
	Body       string `json:"body"`
	MsgID      uint   `json:"msg_id"` // already-inserted DB row id for dedup
}
