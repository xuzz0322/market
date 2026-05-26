package models

import (
	"time"

	"gorm.io/gorm"
)

type AuctionStatus string

const (
	AuctionPending   AuctionStatus = "pending"
	AuctionActive    AuctionStatus = "active"
	AuctionEnded     AuctionStatus = "ended"
	AuctionCancelled AuctionStatus = "cancelled"
)

type Auction struct {
	ID            uint          `json:"id" gorm:"primaryKey"`
	ProductID     uint          `json:"product_id" gorm:"not null;uniqueIndex"`
	Product       *Product      `json:"product,omitempty" gorm:"foreignKey:ProductID"`
	SellerID      uint          `json:"seller_id" gorm:"not null;index"`
	Seller        *User         `json:"seller,omitempty" gorm:"foreignKey:SellerID"`
	StartPrice    float64       `json:"start_price" gorm:"type:decimal(12,2);not null"`
	CurrentPrice  float64       `json:"current_price" gorm:"type:decimal(12,2);not null"`
	MinIncrement  float64       `json:"min_increment" gorm:"type:decimal(12,2);default:1"`
	HasReserve    bool          `json:"has_reserve" gorm:"default:false;comment:'whether reserve price gating is enabled'"`
	ReservePrice  float64       `json:"reserve_price" gorm:"type:decimal(12,2);comment:'auction does not transact below this'"`
	HasBuyNow     bool          `json:"has_buy_now" gorm:"default:false;comment:'whether buy-now/cap price is enabled'"`
	BuyNowPrice   float64       `json:"buy_now_price" gorm:"type:decimal(12,2)"`
	Duration      int           `json:"duration" gorm:"not null;comment:'seconds'"`
	StartTime     *time.Time    `json:"start_time"`
	EndTime       *time.Time    `json:"end_time"`
	Status        AuctionStatus `json:"status" gorm:"type:varchar(20);default:'pending'"`
	WinnerID      *uint         `json:"winner_id"`
	Winner        *User         `json:"winner,omitempty" gorm:"foreignKey:WinnerID"`
	BidCount      int           `json:"bid_count" gorm:"default:0"`
	ViewCount     int           `json:"view_count" gorm:"default:0"`
	Version       int           `json:"version" gorm:"default:0;comment:'optimistic lock version'"`
	CancelReason  string        `json:"cancel_reason,omitempty" gorm:"size:500;comment:'reason if cancelled'"`
	CancelledAt   *time.Time    `json:"cancelled_at,omitempty"`
	CreatedAt     time.Time     `json:"created_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
	DeletedAt     gorm.DeletedAt `json:"-" gorm:"index"`
}
