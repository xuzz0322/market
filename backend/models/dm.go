package models

import "time"

// DirectMessage is a private 1-to-1 text message. Stored in MySQL for
// durability; the WS push is a best-effort delivery via Kafka → consumer.
//
// We keep the schema intentionally simple — no threads, no attachments —
// because the primary use case is buyer↔seller order coordination and
// quick clarifications during a live auction, not a full-featured chat.
//
// Deletion is soft (DeletedAt) so the other party still sees the
// conversation history even if the sender deletes their copy.
//
// Composite index (sender_id, receiver_id, created_at) covers the "my
// inbox" query; (receiver_id, created_at) covers the "messages to me"
// query. Both are cheap because conversations are narrow.
type DirectMessage struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	SenderID    uint      `json:"sender_id" gorm:"not null;index:idx_dm_sender"`
	Sender      *User     `json:"sender,omitempty" gorm:"foreignKey:SenderID"`
	ReceiverID  uint      `json:"receiver_id" gorm:"not null;index:idx_dm_receiver"`
	Receiver    *User     `json:"receiver,omitempty" gorm:"foreignKey:ReceiverID"`
	Body        string    `json:"body" gorm:"type:text;not null"`
	ReadAt      *time.Time `json:"read_at,omitempty"` // nil = unread
	CreatedAt   time.Time `json:"created_at"`
}
