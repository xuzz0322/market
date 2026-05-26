package models

import "time"

type BidStatus string

const (
	BidActive    BidStatus = "active"
	BidOutbid    BidStatus = "outbid"
	BidWon       BidStatus = "won"
	BidCancelled BidStatus = "cancelled"
)

type Bid struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	AuctionID   uint      `json:"auction_id" gorm:"not null;index;uniqueIndex:idx_auction_client"`
	Auction     *Auction  `json:"auction,omitempty" gorm:"foreignKey:AuctionID"`
	UserID      uint      `json:"user_id" gorm:"not null;index"`
	User        *User     `json:"user,omitempty" gorm:"foreignKey:UserID"`
	Amount      float64   `json:"amount" gorm:"type:decimal(12,2);not null"`
	Status      BidStatus `json:"status" gorm:"type:varchar(20);default:'active'"`
	ClientBidID string    `json:"client_bid_id,omitempty" gorm:"size:64;uniqueIndex:idx_auction_client;default:null;comment:'client-generated UUID for idempotency'"`
	CreatedAt   time.Time `json:"created_at"`
}

// BidRanking represents ranked bid in an auction
type BidRanking struct {
	Rank     int     `json:"rank"`
	UserID   uint    `json:"user_id"`
	Username string  `json:"username"`
	Avatar   string  `json:"avatar"`
	Amount   float64 `json:"amount"`
}
