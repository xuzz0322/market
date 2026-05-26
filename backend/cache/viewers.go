package cache

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// ViewerCounter shifts viewer-count INCRs from MySQL (where they cause
// row-lock contention on hot rows) to Redis (where INCR is O(1) and lock-
// free). Counts are flushed back to MySQL periodically so existing
// view_count queries keep working.
//
// Trade-offs we accept:
//   - View counts shown to users may lag MySQL by up to flushInterval.
//     For a vanity counter on a UI, this is invisible.
//   - On Redis crash, in-flight increments since last flush are lost.
//     For viewer counts, that's fine; for money we'd never do this.
type ViewerCounter struct {
	c             *Client
	db            *gorm.DB
	flushInterval time.Duration
}

func NewViewerCounter(c *Client, db *gorm.DB) *ViewerCounter {
	return &ViewerCounter{c: c, db: db, flushInterval: 30 * time.Second}
}

// Inc bumps the in-memory counter for an auction. The dirty set tracks
// which auctions have unflushed increments so the flusher knows where to
// look without a global SCAN.
func (v *ViewerCounter) Inc(ctx context.Context, auctionID uint) {
	if !v.c.Available() {
		// Fall through silently — viewer count is a vanity metric.
		// We intentionally do NOT fall back to MySQL on miss because
		// that's the expensive write we're trying to avoid in the first place.
		return
	}
	pipe := v.c.rdb.Pipeline()
	pipe.Incr(ctx, AuctionViewers(auctionID))
	pipe.SAdd(ctx, AuctionDirtyViewers, auctionID)
	_, _ = pipe.Exec(ctx)
}

// Get returns the current viewer count from Redis (live). Used by the WS
// join response so users see their join reflected immediately.
func (v *ViewerCounter) Get(ctx context.Context, auctionID uint) (int64, error) {
	return Do(ctx, v.c, func(rdb *redis.Client) (int64, error) {
		s, err := rdb.Get(ctx, AuctionViewers(auctionID)).Result()
		if err == redis.Nil {
			return 0, nil
		}
		if err != nil {
			return 0, err
		}
		return strconv.ParseInt(s, 10, 64)
	})
}

// StartFlusher launches the background loop that drains Redis counters
// into MySQL. Call once at boot.
func (v *ViewerCounter) StartFlusher(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(v.flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				v.flush(context.Background()) // final drain on shutdown
				return
			case <-ticker.C:
				v.flush(ctx)
			}
		}
	}()
	log.Println("Viewer counter flusher started")
}

// flush drains the dirty set, reads each counter, applies it as a delta
// to MySQL, and clears the Redis counter atomically.
//
// We use GETDEL (atomic get + delete) so a concurrent Inc that lands
// between our read and our reset isn't lost; it'll show up in the next
// flush cycle.
func (v *ViewerCounter) flush(ctx context.Context) {
	if !v.c.Available() {
		return
	}
	dirty, err := v.c.rdb.SMembers(ctx, AuctionDirtyViewers).Result()
	if err != nil || len(dirty) == 0 {
		return
	}

	for _, idStr := range dirty {
		auctionID, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil {
			continue
		}
		// GETDEL: atomic read-and-clear. Anything Inc'd between this and
		// the next Pop will show up as a fresh dirty entry.
		s, err := v.c.rdb.GetDel(ctx, AuctionViewers(uint(auctionID))).Result()
		if err == redis.Nil {
			// Already drained by something else, just clear dirty bit.
			v.c.rdb.SRem(ctx, AuctionDirtyViewers, idStr)
			continue
		}
		if err != nil {
			continue
		}
		delta, _ := strconv.ParseInt(s, 10, 64)
		if delta == 0 {
			v.c.rdb.SRem(ctx, AuctionDirtyViewers, idStr)
			continue
		}

		// Single SQL statement: cheaper than fetching+writing back.
		err = v.db.Exec(
			"UPDATE auctions SET view_count = view_count + ? WHERE id = ?",
			delta, auctionID,
		).Error
		if err != nil {
			// Re-add to dirty so we retry next cycle. Don't put the
			// counter back — that risks double-applying; the user-facing
			// counter is "live + flushed", so a brief miss is fine.
			v.c.rdb.SAdd(ctx, AuctionDirtyViewers, idStr)
			log.Printf("Viewer flush failed for auction %d: %v", auctionID, err)
			continue
		}
		v.c.rdb.SRem(ctx, AuctionDirtyViewers, idStr)
	}
}
