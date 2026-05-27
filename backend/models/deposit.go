package models

import "time"

// DepositStatus tracks where a held earnest payment ends up.
//
//   held     : user has paid, can bid; not yet settled.
//   refunded : credited back to the user (loss / cancel / reserve not met).
//   applied  : went toward the winner's final payment, NOT refunded.
type DepositStatus string

const (
	DepositHeld     DepositStatus = "held"
	DepositRefunded DepositStatus = "refunded"
	DepositApplied  DepositStatus = "applied"
)

// Deposit is the earnest payment a user puts down before they're allowed
// to bid on an auction whose seller required one.
//
// Composite uniqueIndex (user_id, auction_id) ensures one row per pair —
// re-paying is a no-op (handled at the API level, but the DB is the
// authoritative source).
type Deposit struct {
	ID        uint           `json:"id" gorm:"primaryKey"`
	UserID    uint           `json:"user_id" gorm:"not null;index;uniqueIndex:idx_deposit_user_auction"`
	AuctionID uint           `json:"auction_id" gorm:"not null;index;uniqueIndex:idx_deposit_user_auction"`
	Auction   *Auction       `json:"auction,omitempty" gorm:"foreignKey:AuctionID"`
	Amount    float64        `json:"amount" gorm:"type:decimal(12,2);not null"`
	Status    DepositStatus  `json:"status" gorm:"type:varchar(20);default:'held';index"`
	CreatedAt time.Time      `json:"created_at"`
	SettledAt *time.Time     `json:"settled_at,omitempty"`
}
