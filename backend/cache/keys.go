package cache

import "fmt"

// Redis key naming conventions. Centralized here so we never have a typo
// in one place that silently misses cache hits forever.
//
// Naming rules:
//   - Colons separate namespaces.
//   - {id} placeholders are auction or user IDs.
//   - Avoid putting variable parts in unexpected positions — Redis Cluster
//     hash-tags use {} so we keep them out of our key syntax to keep
//     options open.

// AuctionMeta returns the hash key holding hot auction state.
//   Fields: current_price, bid_count, end_at_ms, status, version, has_buy_now,
//           buy_now_price, min_increment, start_price, seller_id, duration
func AuctionMeta(id uint) string { return fmt.Sprintf("auction:meta:%d", id) }

// AuctionRankings returns the ZSET key for an auction's bidder leaderboard.
//   Score:  highest bid amount by that user
//   Member: user_id (as string)
func AuctionRankings(id uint) string { return fmt.Sprintf("auction:rankings:%d", id) }

// AuctionViewers is a counter that's incremented every time a client joins
// the room. Periodically flushed to MySQL by ViewCounterFlusher.
func AuctionViewers(id uint) string { return fmt.Sprintf("auction:viewers:%d", id) }

// AuctionDirtyViewers is the SET of auction IDs whose viewer counter has
// been incremented since the last flush. The flusher reads this set, drains
// the matching counters, and writes the deltas to MySQL.
const AuctionDirtyViewers = "auction:dirty_viewers"

// UserCache holds frequently-read user fields (username, avatar) so that
// rendering rankings doesn't fan out to N user table lookups per broadcast.
//   Fields: username, avatar
func UserCache(id uint) string { return fmt.Sprintf("user:cache:%d", id) }

// WSBroadcast is the Pub/Sub channel used to fan out WS broadcasts across
// backend instances. Each pod publishes its broadcasts here AND subscribes
// to it; subscribers re-dispatch to their local hub rooms (skipping their
// own publishes via instance_id deduplication).
const WSBroadcastChannel = "ws:broadcast"

// RoomHeat is the sorted set ranking live auction rooms by heat score.
//   Score:  float64 heat value (higher = hotter)
//   Member: room_id (as string)
// Refreshed every 30s by the heat scanner; consumed by the room list
// endpoint and the global WS heat-update broadcast.
const RoomHeat = "room:heat"

// RoomLikesDelta tracks new favorites since the last heat cycle for a room.
// Incremented by the social handler on each new favorite; reset by the
// heat scanner after it reads the value.
func RoomLikesDelta(roomID uint) string { return fmt.Sprintf("room:likes_delta:%d", roomID) }

// AuctionBidsDelta tracks bids placed in the last heat window (1h) for a
// running auction. INCR on each bid; heat scanner reads all active-auction
// counters in a pipeline.
func AuctionBidsDelta(auctionID uint) string { return fmt.Sprintf("auction:bids_delta:%d", auctionID) }
