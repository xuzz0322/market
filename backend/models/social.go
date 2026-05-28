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

// Block records a user→target block. Blocked users' auctions and rooms are
// hidden from the blocker in discovery feeds, and the blocked user cannot
// see the blocker's bids or profile information.
//
// We deliberately do NOT notify the blocked user — receiving a notification
// that you've been blocked is poor UX and serves no product goal.
//
// Composite uniqueIndex on (blocker_id, blocked_id) keeps it idempotent.
type Block struct {
	ID         uint      `json:"id" gorm:"primaryKey"`
	BlockerID  uint      `json:"-" gorm:"not null;index;uniqueIndex:idx_blocker_blocked"`
	BlockedID  uint      `json:"blocked_id" gorm:"not null;index;uniqueIndex:idx_blocker_blocked"`
	CreatedAt  time.Time `json:"created_at"`
}
