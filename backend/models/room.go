package models

import (
	"time"

	"gorm.io/gorm"
)

// RoomStatus is the lifecycle of an auction room. We deliberately keep this
// to two terminal states because the room's "interestingness" is derived from
// the auctions it hosts — when the host stops queuing items they close the
// room, otherwise it stays open and discoverable.
type RoomStatus string

const (
	RoomOpen   RoomStatus = "open"
	RoomClosed RoomStatus = "closed"
)

// AuctionRoom is a host-owned space that schedules auctions in sequence. At
// most one auction inside a room is `active` at any time. New auctions added
// to the room sit in `pending` until the previous one finishes — see
// AuctionService.advanceRoomQueue for the auto-advance hook.
type AuctionRoom struct {
	ID          uint           `json:"id" gorm:"primaryKey"`
	HostID      uint           `json:"host_id" gorm:"not null;index"`
	Host        *User          `json:"host,omitempty" gorm:"foreignKey:HostID"`
	Title       string         `json:"title" gorm:"size:100;not null"`
	Description string         `json:"description" gorm:"type:text"`
	CoverURL    string         `json:"cover_url" gorm:"size:500"`
	Status      RoomStatus     `json:"status" gorm:"type:varchar(20);default:'open';index"`
	// CurrentAuctionID points at the auction the room is broadcasting RIGHT
	// NOW. nil while the room is between auctions or has nothing queued.
	// Updated by advanceRoomQueue inside the same tx as the auction's
	// status change so a viewer never sees the room point at a settled
	// auction.
	CurrentAuctionID *uint     `json:"current_auction_id"`
	// IsStreaming flips when the host opens/closes live A/V commentary.
	// Persisted (not in-memory) so a viewer joining mid-broadcast can
	// immediately know to negotiate a WebRTC peer with the host. Best-
	// effort: if the host's tab crashes the flag stays true until the
	// host re-toggles it; viewers handle the no-response case gracefully.
	IsStreaming      bool      `json:"is_streaming" gorm:"default:false"`
	TotalAuctions    int       `json:"total_auctions" gorm:"default:0;comment:'lifetime count'"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
	DeletedAt        gorm.DeletedAt `json:"-" gorm:"index"`
}
