package cache

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"market/models"
)

// RankingStore wraps the Redis ZSET-based bidder leaderboard.
//
// Why ZSET vs SQL GROUP BY:
//   - Old: every broadcast ran "SELECT user_id, MAX(amount) ... GROUP BY
//     user_id ORDER BY ... LIMIT 10" — O(N) on the bid count, plus a
//     temporary table. With 10 active rooms × 5 bids/sec the DB groans.
//   - New: ZADD on bid is O(log N). Top-10 read is O(10 + log N). Both
//     are independent of total bid count, so a hot auction with 10K bids
//     costs the same per query as a fresh one.
//
// The ZSET stores user_id → max_bid_amount. We keep usernames/avatars in
// a separate user cache so we don't have to update them when the user
// changes their profile.
type RankingStore struct {
	c *Client
}

func NewRankingStore(c *Client) *RankingStore { return &RankingStore{c: c} }

// AddBid records a bid in the leaderboard. Uses ZADD with GT (greater-than)
// so a bid lower than the user's existing max is silently ignored — the
// SQL bid handler can still record the row for audit, but it won't appear
// in the leaderboard.
func (r *RankingStore) AddBid(ctx context.Context, auctionID, userID uint, amount float64) error {
	return Exec(ctx, r.c, func(rdb *redis.Client) error {
		// ZADD ... GT: only update if score > current. ZADD without GT
		// would let a $5 bid replace a $100 bid, which would be wrong.
		return rdb.ZAddArgs(ctx, AuctionRankings(auctionID), redis.ZAddArgs{
			GT:      true,
			Members: []redis.Z{{Score: amount, Member: strconv.FormatUint(uint64(userID), 10)}},
		}).Err()
	})
}

// TopN returns the top N bidders by amount, descending. Pulls usernames
// and avatars from the user cache (or, on miss, expects the caller to fall
// back to MySQL — see GetRankingsWithFallback in the service layer).
func (r *RankingStore) TopN(ctx context.Context, auctionID uint, n int64) ([]models.BidRanking, error) {
	zs, err := Do(ctx, r.c, func(rdb *redis.Client) ([]redis.Z, error) {
		return rdb.ZRevRangeWithScores(ctx, AuctionRankings(auctionID), 0, n-1).Result()
	})
	if err != nil {
		return nil, err
	}
	if len(zs) == 0 {
		return nil, nil
	}

	// Batch-fetch user display data via pipeline. Single round-trip even
	// for 10 users beats N round-trips on a slow network.
	pipe := r.c.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(zs))
	for i, z := range zs {
		uid := z.Member.(string)
		cmds[i] = pipe.HGetAll(ctx, "user:cache:"+uid)
	}
	_, _ = pipe.Exec(ctx) // best-effort; missing user fields fall through

	out := make([]models.BidRanking, 0, len(zs))
	for i, z := range zs {
		uidStr := z.Member.(string)
		uid, _ := strconv.ParseUint(uidStr, 10, 64)
		userData, _ := cmds[i].Result()

		out = append(out, models.BidRanking{
			Rank:     i + 1,
			UserID:   uint(uid),
			Username: userData["username"], // empty string is fine — caller can backfill
			Avatar:   userData["avatar"],
			Amount:   z.Score,
		})
	}
	return out, nil
}

// CacheUser stores a user's display fields. Called after login or on first
// read so subsequent leaderboards don't need a user-table fetch.
func (r *RankingStore) CacheUser(ctx context.Context, u *models.User) error {
	return Exec(ctx, r.c, func(rdb *redis.Client) error {
		return rdb.HSet(ctx, UserCache(u.ID), map[string]any{
			"username": u.Username,
			"avatar":   u.Avatar,
		}).Err()
	})
}

// PurgeAuction is called when an auction ends, to free ZSET memory. The
// rankings can still be reconstructed from MySQL if needed for audit.
func (r *RankingStore) PurgeAuction(ctx context.Context, auctionID uint) error {
	return Exec(ctx, r.c, func(rdb *redis.Client) error {
		return rdb.Del(ctx, AuctionRankings(auctionID)).Err()
	})
}
