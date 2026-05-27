package models

import "time"

// Favorite is a user's saved auction (the "heart" / wishlist). One row per
// (user, auction) pair — the composite uniqueIndex enforces the no-dupe
// guarantee at the DB level so the handler doesn't need a SELECT-then-INSERT.
type Favorite struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	UserID    uint      `json:"user_id" gorm:"not null;index;uniqueIndex:idx_user_auction"`
	AuctionID uint      `json:"auction_id" gorm:"not null;index;uniqueIndex:idx_user_auction"`
	CreatedAt time.Time `json:"created_at"`
}

// Follow is a viewer→host edge. Symmetric with Favorite: composite unique
// guarantees idempotent follow calls.
type Follow struct {
	ID         uint      `json:"id" gorm:"primaryKey"`
	FollowerID uint      `json:"follower_id" gorm:"not null;index;uniqueIndex:idx_follower_host"`
	HostID     uint      `json:"host_id" gorm:"not null;index;uniqueIndex:idx_follower_host"`
	CreatedAt  time.Time `json:"created_at"`
}
