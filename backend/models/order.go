package models

import (
	"time"

	"gorm.io/gorm"
)

// OrderStatus tracks an auction order through its lifecycle.
//
// Lifecycle:
//   pending_address  → auction won; payment already deducted at end-of-auction;
//                      buyer needs to provide a shipping address before the
//                      seller can ship.
//   pending_shipment → buyer filled address; seller needs to ship.
//   shipped          → seller dispatched; tracking_no recorded.
//   completed        → buyer confirmed receipt; funds released to seller.
//   cancelled        → admin/seller cancellation (rare; primary cancel path
//                      is at the auction stage which never creates an order).
//
// Why payment is "already deducted" before the order exists: the end-of-
// auction routine atomically transfers the buyer's balance to a platform-
// held escrow on the same transaction that finalizes the auction. This
// avoids the classic "user wins but can't pay" race. Funds are released
// to the seller on receipt confirmation.
type OrderStatus string

const (
	OrderPendingAddress  OrderStatus = "pending_address"
	OrderPendingShipment OrderStatus = "pending_shipment"
	OrderShipped         OrderStatus = "shipped"
	OrderCompleted       OrderStatus = "completed"
	OrderCancelled       OrderStatus = "cancelled"
)

// ShippingAddress is stored as JSON in Order.ShippingAddress for portability
// (different countries have different address shapes; we don't want to
// schema-lock to one country's fields).
type ShippingAddress struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Province string `json:"province"`
	City     string `json:"city"`
	District string `json:"district"`
	Detail   string `json:"detail"`
	ZipCode  string `json:"zip_code,omitempty"`
}

type Order struct {
	ID        uint   `json:"id" gorm:"primaryKey"`
	// OrderNo is a human-friendly business code (e.g., "AC2024052612345678").
	// Used in URLs and customer-service conversations rather than the
	// auto-increment ID. Unique-indexed for direct lookup.
	OrderNo   string `json:"order_no" gorm:"uniqueIndex;size:32;not null"`

	AuctionID uint     `json:"auction_id" gorm:"not null;uniqueIndex;comment:'one order per auction'"`
	Auction   *Auction `json:"auction,omitempty" gorm:"foreignKey:AuctionID"`
	ProductID uint     `json:"product_id" gorm:"not null;index"`
	Product   *Product `json:"product,omitempty" gorm:"foreignKey:ProductID"`
	SellerID  uint     `json:"seller_id" gorm:"not null;index"`
	Seller    *User    `json:"seller,omitempty" gorm:"foreignKey:SellerID"`
	BuyerID   uint     `json:"buyer_id" gorm:"not null;index"`
	Buyer     *User    `json:"buyer,omitempty" gorm:"foreignKey:BuyerID"`

	Amount          float64     `json:"amount" gorm:"type:decimal(12,2);not null"`
	Status          OrderStatus `json:"status" gorm:"type:varchar(30);default:'pending_address';index"`
	ShippingAddress string      `json:"shipping_address" gorm:"type:json"`
	TrackingNo      string      `json:"tracking_no" gorm:"size:64"`
	ShipCarrier     string      `json:"ship_carrier" gorm:"size:50"`

	PaidAt      *time.Time `json:"paid_at"`      // set when balance is captured (= auction end)
	ShippedAt   *time.Time `json:"shipped_at"`
	CompletedAt *time.Time `json:"completed_at"`
	CancelReason string    `json:"cancel_reason,omitempty" gorm:"size:500"`

	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `json:"-" gorm:"index"`
}
