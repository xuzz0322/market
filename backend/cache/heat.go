package cache

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"

	"market/models"
)

// HubBroadcaster is the minimal Hub interface for global WS broadcasts.
// Separate from HubAccessor so the scanner can broadcast without importing ws.
type HubBroadcaster interface {
	HubAccessor
	BroadcastAll(msg interface{})
}

// HeatScanner computes a composite heat score for every open auction room
// every ScanInterval seconds, writes it into the room:heat ZSET, and
// flushes the top scores back to MySQL (heat_score column) so the SQL
// ORDER BY can serve cold-start requests without Redis.
//
// Heat formula (all components are non-negative):
//
//	heat = liveViewers    * 8   // WS-room size right now
//	     + bidsInWindow   * 5   // bids in last scanWindow (from Redis delta)
//	     + likesInWindow  * 3   // new favorites since last scan
//	     + log(totalBids+1) * 2 // long-tail bid history (dampened with log)
//	     + recencyBonus         // age-decay of start_time (newer = warmer)
//
// Weight rationale:
//   - liveViewers: highest weight — a crowd draws a crowd. Real-time signal
//     so it doesn't lag like a bid count.
//   - bidsInWindow: direct engagement, but only counts recent bids to avoid
//     a 2-hour-old auction staying "hot" when nothing is happening now.
//   - likesInWindow: interest/intent signal without real money committed.
//   - log(totalBids): rewards auctions that have proven attraction
//     historically, but compressed with log so a +1000-bid outlier doesn't
//     dominate over a fresh lively room.
//   - recencyBonus: at most +20, decaying linearly over 2 hours, so a brand
//     new auction gets a small discovery boost vs a stale one.
type HeatScanner struct {
	c            *Client
	db           *gorm.DB
	hub          HubBroadcaster
	ScanInterval time.Duration
	scanWindow   time.Duration // width of the "recent bids/likes" window
}

// HubAccessor is the minimal Hub interface the scanner needs. We take an
// interface rather than the concrete Hub so this package doesn't import
// the ws package (avoiding a circular dependency).
type HubAccessor interface {
	GetRoomSize(auctionID uint) int
}

func NewHeatScanner(c *Client, db *gorm.DB, hub HubBroadcaster) *HeatScanner {
	return &HeatScanner{
		c:            c,
		db:           db,
		hub:          hub,
		ScanInterval: 30 * time.Second,
		scanWindow:   60 * time.Minute,
	}
}

// SetHub wires the hub after both the scanner and hub are constructed.
// Called from main() to break the initialisation ordering dependency.
func (s *HeatScanner) SetHub(hub HubBroadcaster) { s.hub = hub }

// Start launches the periodic heat scanner. Call once at boot. The scanner
// runs until ctx is cancelled (graceful shutdown).
func (s *HeatScanner) Start(ctx context.Context) {
	go func() {
		// Run once immediately so the first API call to /rooms gets heat
		// scores without waiting for the first ticker fire.
		s.scan(ctx)
		ticker := time.NewTicker(s.ScanInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.scan(ctx)
			}
		}
	}()
	log.Println("Heat scanner started (interval:", s.ScanInterval, ")")
}

// scan is the main loop body. It builds heat scores for all open rooms,
// writes them to Redis, and flushes the top-100 back to MySQL.
func (s *HeatScanner) scan(ctx context.Context) {
	// Load all open rooms with their current auction + total bid counts.
	type roomRow struct {
		RoomID           uint
		CurrentAuctionID *uint
		TotalBids        int
		StartTime        *time.Time
		FavoriteCount    int64
	}
	var rows []roomRow
	err := s.db.Raw(`
		SELECT
			r.id                          AS room_id,
			r.current_auction_id          AS current_auction_id,
			COALESCE(a.bid_count, 0)      AS total_bids,
			a.start_time                  AS start_time,
			COALESCE(fc.cnt, 0)           AS favorite_count
		FROM auction_rooms r
		LEFT JOIN auctions a
			ON a.id = r.current_auction_id AND a.status = 'active'
		LEFT JOIN (
			SELECT f.auction_id, COUNT(*) AS cnt
			FROM favorites f
			GROUP BY f.auction_id
		) fc ON fc.auction_id = r.current_auction_id
		WHERE r.status = 'open'
			AND r.deleted_at IS NULL
	`).Scan(&rows).Error
	if err != nil {
		log.Printf("HeatScanner: load rooms failed: %v", err)
		return
	}
	if len(rows) == 0 {
		return
	}

	now := time.Now()

	// Collect IDs for batch Redis reads.
	auctionIDs := make([]uint, 0, len(rows))
	roomIDs := make([]uint, 0, len(rows))
	for _, r := range rows {
		if r.CurrentAuctionID != nil {
			auctionIDs = append(auctionIDs, *r.CurrentAuctionID)
		}
		roomIDs = append(roomIDs, r.RoomID)
	}

	// Batch-read bid deltas and likes deltas from Redis in one pipeline.
	bidDeltas := make(map[uint]float64, len(auctionIDs))
	likeDeltas := make(map[uint]float64, len(roomIDs))

	if s.c.Available() {
		pipe := s.c.rdb.Pipeline()
		bidCmds := make(map[uint]*redis.StringCmd, len(auctionIDs))
		for _, aid := range auctionIDs {
			bidCmds[aid] = pipe.Get(ctx, AuctionBidsDelta(aid))
		}
		likeCmds := make(map[uint]*redis.StringCmd, len(roomIDs))
		for _, rid := range roomIDs {
			likeCmds[rid] = pipe.Get(ctx, RoomLikesDelta(rid))
		}
		_, _ = pipe.Exec(ctx)

		// Reset deltas immediately after reading so the next scan window
		// starts fresh. We accept a tiny race: a bid landing between our
		// GETDEL-equivalent read and the DEL would be silently lost for this
		// scan — it shows up next cycle. Using GETDEL would require two
		// round-trips; for a heat score that small imprecision is fine.
		delPipe := s.c.rdb.Pipeline()
		for _, aid := range auctionIDs {
			if v, err := bidCmds[aid].Result(); err == nil {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					bidDeltas[aid] = f
				}
			}
			delPipe.Del(ctx, AuctionBidsDelta(aid))
		}
		for _, rid := range roomIDs {
			if v, err := likeCmds[rid].Result(); err == nil {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					likeDeltas[rid] = f
				}
			}
			delPipe.Del(ctx, RoomLikesDelta(rid))
		}
		_, _ = delPipe.Exec(ctx)
	}

	// Compute score per room.
	type scored struct {
		roomID uint
		score  float64
	}
	scores := make([]scored, 0, len(rows))
	for _, r := range rows {
		var auctionID uint
		var liveViewers float64
		var bidsInWindow float64

		if r.CurrentAuctionID != nil {
			auctionID = *r.CurrentAuctionID
			liveViewers = float64(s.hub.GetRoomSize(auctionID))
			bidsInWindow = bidDeltas[auctionID]
		}

		likesInWindow := likeDeltas[r.RoomID]
		logBids := math.Log(float64(r.TotalBids) + 1)

		// Recency bonus: linearly decay over 2 h from +20 → 0.
		var recency float64
		if r.StartTime != nil {
			age := now.Sub(*r.StartTime).Minutes()
			if age < 120 {
				recency = 20 * (1 - age/120)
			}
		}

		heat := liveViewers*8 + bidsInWindow*5 + likesInWindow*3 + logBids*2 + recency

		scores = append(scores, scored{roomID: r.RoomID, score: heat})
	}

	// Write to Redis ZSET. Replace entire set so stale rooms (now closed)
	// drop out naturally without an explicit delete pass.
	if s.c.Available() {
		members := make([]redis.Z, 0, len(scores))
		for _, s := range scores {
			members = append(members, redis.Z{
				Score:  s.score,
				Member: fmt.Sprintf("%d", s.roomID),
			})
		}
		// ZADD is idempotent; stale members from closed rooms will persist
		// until they're overwritten or the key TTL expires. We set a 5-min
		// TTL so the ZSET self-heals if all rooms go idle simultaneously.
		pipe := s.c.rdb.Pipeline()
		pipe.Del(ctx, RoomHeat)
		if len(members) > 0 {
			pipe.ZAdd(ctx, RoomHeat, members...)
		}
		pipe.Expire(ctx, RoomHeat, 5*time.Minute)
		if _, err := pipe.Exec(ctx); err != nil {
			log.Printf("HeatScanner: Redis write failed: %v", err)
		}
	}

	// Flush top-100 scores back to MySQL so cold-start SQL sorts work.
	// We cap at 100 to keep the UPDATE batch cheap.
	cap := 100
	if len(scores) < cap {
		cap = len(scores)
	}
	// Sort descending by score (simple selection for small N).
	for i := 0; i < cap; i++ {
		for j := i + 1; j < len(scores); j++ {
			if scores[j].score > scores[i].score {
				scores[i], scores[j] = scores[j], scores[i]
			}
		}
	}
	for _, sc := range scores[:cap] {
		if err := s.db.Model(&models.AuctionRoom{}).
			Where("id = ?", sc.roomID).
			Update("heat_score", sc.score).Error; err != nil {
			log.Printf("HeatScanner: flush score room %d: %v", sc.roomID, err)
		}
	}

	// Broadcast the top-10 heat ranking to all connected WS clients so
	// the feed can re-order live without polling. We send at most 10 to
	// keep the message small; the full list is available via HTTP.
	if s.hub != nil && len(scores) > 0 {
		top := 10
		if len(scores) < top {
			top = len(scores)
		}
		type heatEntry struct {
			RoomID uint    `json:"room_id"`
			Score  float64 `json:"score"`
		}
		entries := make([]heatEntry, top)
		for i, sc := range scores[:top] {
			entries[i] = heatEntry{RoomID: sc.roomID, Score: sc.score}
		}
		s.hub.BroadcastAll(struct {
			Type string      `json:"type"`
			Data interface{} `json:"data"`
		}{
			Type: "heat_update",
			Data: entries,
		})
	}
}

// TopRooms returns up to `limit` rooms sorted by heat, descending.
// Tries Redis first (sub-ms); falls back to MySQL ORDER BY heat_score on
// cache miss or Redis unavailability.
func (s *HeatScanner) TopRooms(ctx context.Context, limit int64) ([]uint, error) {
	if s.c.Available() {
		zs, err := s.c.rdb.ZRevRangeWithScores(ctx, RoomHeat, 0, limit-1).Result()
		if err == nil && len(zs) > 0 {
			ids := make([]uint, 0, len(zs))
			for _, z := range zs {
				if id, err := strconv.ParseUint(z.Member.(string), 10, 64); err == nil {
					ids = append(ids, uint(id))
				}
			}
			return ids, nil
		}
	}
	// MySQL fallback.
	var ids []uint
	err := s.db.Model(&models.AuctionRoom{}).
		Where("status = ?", "open").
		Order("heat_score DESC").
		Limit(int(limit)).
		Pluck("id", &ids).Error
	return ids, err
}

// IncrBidDelta bumps the per-auction bid delta counter in Redis.
// Called by the bid handler right after a successful bid commit.
func IncrBidDelta(ctx context.Context, c *Client, auctionID uint) {
	Exec(ctx, c, func(rdb *redis.Client) error {
		pipe := rdb.Pipeline()
		pipe.Incr(ctx, AuctionBidsDelta(auctionID))
		// TTL matches the scan window so old data expires automatically.
		pipe.Expire(ctx, AuctionBidsDelta(auctionID), 65*time.Minute)
		_, err := pipe.Exec(ctx)
		return err
	})
}

// IncrLikesDelta bumps the per-room likes delta counter in Redis.
// Called by the favorites handler when a user hearts an auction.
func IncrLikesDelta(ctx context.Context, c *Client, roomID uint) {
	Exec(ctx, c, func(rdb *redis.Client) error {
		pipe := rdb.Pipeline()
		pipe.Incr(ctx, RoomLikesDelta(roomID))
		pipe.Expire(ctx, RoomLikesDelta(roomID), 65*time.Minute)
		_, err := pipe.Exec(ctx)
		return err
	})
}
