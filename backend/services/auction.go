package services

import (
	"context"
	"log"
	"time"

	"gorm.io/gorm"

	"market/cache"
	"market/models"
	"market/ws"
)

type AuctionService struct {
	db       *gorm.DB
	hub      *ws.Hub
	rankings *cache.RankingStore
	viewers  *cache.ViewerCounter
}

func NewAuctionService(db *gorm.DB, hub *ws.Hub, rankings *cache.RankingStore, viewers *cache.ViewerCounter) *AuctionService {
	return &AuctionService{db: db, hub: hub, rankings: rankings, viewers: viewers}
}

// StartAuctionMonitor runs in background to check auction end times
func (s *AuctionService) StartAuctionMonitor() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	log.Println("Auction monitor started")
	for range ticker.C {
		s.checkExpiredAuctions()
		s.broadcastCountdowns()
	}
}

// checkExpiredAuctions scans for auctions that should end. The DB query and
// per-row settlement are intentionally split: we don't want to hold a long
// transaction across all auctions, and we don't want a slow EndAuction call
// to block the next tick.
//
// Multi-instance safety: EndAuction uses a "claim" UPDATE
// (status: active → ended) gated by the current status — only one pod's
// UPDATE will return rowsAffected=1, the others see 0 and skip.
func (s *AuctionService) checkExpiredAuctions() {
	var auctions []models.Auction
	now := time.Now()
	s.db.Where("status = ? AND end_time <= ?", models.AuctionActive, now).
		Preload("Product").
		Find(&auctions)

	for i := range auctions {
		// Run each settlement in its own goroutine so a slow row doesn't
		// stall the tick; the DB-level claim prevents double-settle.
		a := auctions[i]
		go s.EndAuction(&a)
	}
}

func (s *AuctionService) EndAuction(auction *models.Auction) {
	// Atomic claim: only one caller transitions active → ended.
	// If this returns RowsAffected = 0, another worker (or pod) already
	// settled this auction — bail without doing duplicate work.
	claim := s.db.Model(&models.Auction{}).
		Where("id = ? AND status = ?", auction.ID, models.AuctionActive).
		Update("status", models.AuctionEnded)
	if claim.Error != nil {
		log.Printf("Auction %d claim failed: %v", auction.ID, claim.Error)
		return
	}
	if claim.RowsAffected == 0 {
		// Already settled by someone else. Reload to keep our copy fresh
		// (in case caller still uses it for broadcast).
		s.db.First(auction, auction.ID)
		return
	}

	// Find winning bid (the lock-for-update isn't strictly needed since we
	// already won the claim — at this point the auction is "ended" and
	// new bids are rejected by the bid handler).
	var topBid models.Bid
	err := s.db.Where("auction_id = ? AND status = ?", auction.ID, models.BidActive).
		Order("amount DESC").
		Preload("User").
		First(&topBid).Error

	tx := s.db.Begin()
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			log.Printf("EndAuction panic for auction %d: %v", auction.ID, r)
		}
	}()

	if err == nil {
		// We have a top bidder. But check the reserve price first — if
		// the seller set a minimum-acceptable price and we didn't reach
		// it, the auction "passes in" (流拍): no winner, no order, top
		// bidder gets nothing. We treat this as a clean failed-auction
		// rather than a partial commit.
		if auction.HasReserve && topBid.Amount < auction.ReservePrice {
			auction.Status = models.AuctionEnded
			auction.WinnerID = nil
			auction.CurrentPrice = topBid.Amount
			tx.Model(&models.Bid{}).
				Where("auction_id = ?", auction.ID).
				Update("status", models.BidOutbid)
			tx.Model(&models.Product{}).Where("id = ?", auction.ProductID).
				Update("status", models.ProductEnded)
			log.Printf("Auction %d ended — reserve not met (top: %.2f, reserve: %.2f)", auction.ID, topBid.Amount, auction.ReservePrice)
			tx.Save(auction)
			tx.Commit()

			// Broadcast & cleanup. Reuse the auction_end message with
			// nil winner so clients render "reserve not met" UI.
			s.broadcastEndAndCleanup(auction, "", nil)
			return
		}

		// We have a winner
		auction.WinnerID = &topBid.UserID
		auction.Status = models.AuctionEnded
		auction.CurrentPrice = topBid.Amount

		// Mark winning bid
		tx.Model(&topBid).Update("status", models.BidWon)

		// Mark all other bids as outbid
		tx.Model(&models.Bid{}).
			Where("auction_id = ? AND id != ?", auction.ID, topBid.ID).
			Update("status", models.BidOutbid)

		// Update product status to sold
		tx.Model(&models.Product{}).Where("id = ?", auction.ProductID).
			Update("status", models.ProductSold)

		// Deduct balance from winner. We treat this as moving funds into
		// platform escrow — they're released to the seller when the buyer
		// confirms receipt (see OrderHandler.Confirm). Doing the capture
		// here, in the same tx as winner determination, eliminates the
		// "user wins but lacks balance" race that would otherwise need a
		// reservation/cancellation flow.
		tx.Model(&models.User{}).Where("id = ?", topBid.UserID).
			UpdateColumn("balance", gorm.Expr("balance - ?", topBid.Amount))

		// Create the order record. Single tx with the auction-finalize so
		// we never have a "won auction with no order" state visible to
		// customer support.
		now := time.Now()
		order := models.Order{
			OrderNo:   generateOrderNo(),
			AuctionID: auction.ID,
			ProductID: auction.ProductID,
			SellerID:  auction.SellerID,
			BuyerID:   topBid.UserID,
			Amount:    topBid.Amount,
			Status:    models.OrderPendingAddress,
			PaidAt:    &now, // funds were just captured above
		}
		if err := tx.Create(&order).Error; err != nil {
			tx.Rollback()
			log.Printf("Failed to create order for auction %d: %v", auction.ID, err)
			return
		}

		log.Printf("Auction %d ended - winner: user %d, price: %.2f, order: %s", auction.ID, topBid.UserID, topBid.Amount, order.OrderNo)
	} else {
		// No bids, auction ends without winner
		auction.Status = models.AuctionEnded
		tx.Model(&models.Product{}).Where("id = ?", auction.ProductID).
			Update("status", models.ProductEnded)
		log.Printf("Auction %d ended with no bids", auction.ID)
	}

	tx.Save(auction)
	tx.Commit()

	// Broadcast auction end
	winnerName := ""
	var winnerID *uint
	if err == nil && topBid.User != nil {
		winnerName = topBid.User.Username
		winnerID = &topBid.UserID
	}
	s.broadcastEndAndCleanup(auction, winnerName, winnerID)
}

// broadcastEndAndCleanup is the common tail of EndAuction. It sends the
// auction_end WS message and asynchronously frees this auction's Redis
// keys. Centralizing it means alternate end-paths (reserve-not-met,
// no-bids, normal sale) all emit the same shape of broadcast.
func (s *AuctionService) broadcastEndAndCleanup(auction *models.Auction, winnerName string, winnerID *uint) {
	s.hub.BroadcastToRoom(auction.ID, ws.Message{
		Type:      ws.MsgAuctionEnd,
		AuctionID: auction.ID,
		Data: mustMarshal(ws.AuctionEndData{
			AuctionID:  auction.ID,
			WinnerID:   winnerID,
			WinnerName: winnerName,
			FinalPrice: auction.CurrentPrice,
		}),
	})

	// Free Redis structures held by this auction. Deferred via goroutine
	// so it doesn't block the broadcast — if it fails the keys will TTL
	// out naturally (we set no TTL here, but a periodic janitor could).
	go func(id uint) {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		s.OnAuctionFinalized(ctx, id)
	}(auction.ID)
}

func (s *AuctionService) broadcastCountdowns() {
	var auctions []models.Auction
	now := time.Now()
	// Only broadcast for auctions ending within 60 seconds
	s.db.Where("status = ? AND end_time > ? AND end_time <= ?",
		models.AuctionActive, now, now.Add(60*time.Second)).Find(&auctions)

	for _, auction := range auctions {
		secondsLeft := int(time.Until(*auction.EndTime).Seconds())
		if secondsLeft >= 0 {
			s.hub.BroadcastToRoom(auction.ID, ws.Message{
				Type:      ws.MsgCountdown,
				AuctionID: auction.ID,
				Data:      mustMarshal(map[string]interface{}{
					"auction_id":   auction.ID,
					"seconds_left": secondsLeft,
				}),
			})
		}
	}
}

// OnBidPlaced is the post-commit hook invoked by the bid handler. Updates
// caches that downstream readers (rankings, broadcast) depend on. Failures
// here are non-fatal — MySQL is the source of truth, the cache will heal
// on the next read via the GetRankings fallback path.
func (s *AuctionService) OnBidPlaced(ctx context.Context, auctionID, userID uint, username, avatar string, amount float64) {
	if s.rankings == nil {
		return
	}
	_ = s.rankings.AddBid(ctx, auctionID, userID, amount)
	_ = s.rankings.CacheUser(ctx, &models.User{ID: userID, Username: username, Avatar: avatar})
}

// OnAuctionFinalized is called when an auction transitions to a terminal
// state (ended/cancelled). Frees the per-auction Redis structures so
// memory doesn't grow unboundedly with historical auctions.
func (s *AuctionService) OnAuctionFinalized(ctx context.Context, auctionID uint) {
	if s.rankings != nil {
		_ = s.rankings.PurgeAuction(ctx, auctionID)
	}
}

// GetRankings returns the top bidders for an auction.
//
// Path order:
//  1. Redis ZSET (hot path — sub-ms, doesn't touch MySQL).
//  2. On cache miss / Redis down: SQL GROUP BY (cold path).
//  3. After MySQL fallback, write results back to Redis so the next
//     request hits the fast path. This self-heals after a Redis flush
//     or a fresh deployment without manual warmup.
func (s *AuctionService) GetRankings(auctionID uint, limit int) []models.BidRanking {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	if s.rankings != nil {
		if cached, err := s.rankings.TopN(ctx, auctionID, int64(limit)); err == nil && len(cached) > 0 {
			// Backfill any rows that lacked user fields in the cache
			// (happens for users that bid before we cached them).
			needBackfill := false
			for _, r := range cached {
				if r.Username == "" {
					needBackfill = true
					break
				}
			}
			if !needBackfill {
				return cached
			}
			s.backfillUsernames(cached)
			return cached
		}
	}

	// MySQL fallback (also covers cold-start: no Redis data yet).
	type result struct {
		UserID   uint
		Username string
		Avatar   string
		MaxBid   float64
	}
	var results []result
	s.db.Raw(`
		SELECT b.user_id, u.username, u.avatar, MAX(b.amount) as max_bid
		FROM bids b
		JOIN users u ON b.user_id = u.id
		WHERE b.auction_id = ?
		GROUP BY b.user_id, u.username, u.avatar
		ORDER BY max_bid DESC
		LIMIT ?
	`, auctionID, limit).Scan(&results)

	rankings := make([]models.BidRanking, len(results))
	for i, r := range results {
		rankings[i] = models.BidRanking{
			Rank:     i + 1,
			UserID:   r.UserID,
			Username: r.Username,
			Avatar:   r.Avatar,
			Amount:   r.MaxBid,
		}
	}

	// Self-heal cache. We do this best-effort: a slow Redis here shouldn't
	// slow down the hot return path.
	if s.rankings != nil && len(rankings) > 0 {
		go func(rs []models.BidRanking) {
			bgCtx, bgCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer bgCancel()
			for _, r := range rs {
				_ = s.rankings.AddBid(bgCtx, auctionID, r.UserID, r.Amount)
				_ = s.rankings.CacheUser(bgCtx, &models.User{ID: r.UserID, Username: r.Username, Avatar: r.Avatar})
			}
		}(rankings)
	}

	return rankings
}

// backfillUsernames does a single SQL fetch for any users whose display
// fields weren't in the user cache. Runs synchronously since the caller
// is about to render rankings.
func (s *AuctionService) backfillUsernames(rs []models.BidRanking) {
	missing := make([]uint, 0)
	for _, r := range rs {
		if r.Username == "" {
			missing = append(missing, r.UserID)
		}
	}
	if len(missing) == 0 {
		return
	}
	var users []models.User
	s.db.Where("id IN ?", missing).Find(&users)
	byID := make(map[uint]models.User, len(users))
	for _, u := range users {
		byID[u.ID] = u
	}
	for i := range rs {
		if rs[i].Username == "" {
			if u, ok := byID[rs[i].UserID]; ok {
				rs[i].Username = u.Username
				rs[i].Avatar = u.Avatar
				// Fire-and-forget cache backfill so we don't repeat this.
				if s.rankings != nil {
					go func(u models.User) {
						bgCtx, bgCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
						defer bgCancel()
						_ = s.rankings.CacheUser(bgCtx, &u)
					}(u)
				}
			}
		}
	}
}

// BroadcastBidState publishes the current canonical state of an auction to
// every client in its room. Centralizing this here matters: the seq counter,
// server timestamp, and end_at_ms must be filled identically on every path
// (bid handler, ws-join, post-cancel, etc.), and a missing field would
// silently break client-side gap detection or countdown sync.
//
// lastBidder may be empty (e.g., when called on join/resync — there's no
// new bid to celebrate, just a state snapshot).
func (s *AuctionService) BroadcastBidState(auction *models.Auction, lastBidder string) {
	rankings := s.GetRankings(auction.ID, 10)

	now := time.Now()
	var endAtMs int64
	secondsLeft := 0
	if auction.EndTime != nil {
		endAtMs = auction.EndTime.UnixMilli()
		secondsLeft = int(time.Until(*auction.EndTime).Seconds())
		if secondsLeft < 0 {
			secondsLeft = 0
		}
	}

	s.hub.BroadcastToRoom(auction.ID, ws.Message{
		Type:      ws.MsgBidUpdate,
		AuctionID: auction.ID,
		Data: mustMarshal(ws.BidUpdateData{
			AuctionID:    auction.ID,
			CurrentPrice: auction.CurrentPrice,
			BidCount:     auction.BidCount,
			LastBidder:   lastBidder,
			Rankings:     rankings,
			SecondsLeft:  secondsLeft,
			EndAtMs:      endAtMs,
			ServerTimeMs: now.UnixMilli(),
			Seq:          s.hub.NextSeq(auction.ID),
		}),
	})
}

// SendBidStateTo sends a state snapshot to a single client (used on join,
// to bring a freshly-connected client to the latest canonical state without
// relying on it having received the prior broadcast).
func (s *AuctionService) SendBidStateTo(client *ws.Client, auction *models.Auction) {
	rankings := s.GetRankings(auction.ID, 10)

	now := time.Now()
	var endAtMs int64
	secondsLeft := 0
	if auction.EndTime != nil {
		endAtMs = auction.EndTime.UnixMilli()
		secondsLeft = int(time.Until(*auction.EndTime).Seconds())
		if secondsLeft < 0 {
			secondsLeft = 0
		}
	}

	client.SendMessage(ws.Message{
		Type:      ws.MsgBidUpdate,
		AuctionID: auction.ID,
		Data: mustMarshal(ws.BidUpdateData{
			AuctionID:    auction.ID,
			CurrentPrice: auction.CurrentPrice,
			BidCount:     auction.BidCount,
			Rankings:     rankings,
			SecondsLeft:  secondsLeft,
			EndAtMs:      endAtMs,
			ServerTimeMs: now.UnixMilli(),
			// Note: we deliberately use the next seq even on a personal
			// snapshot. The client's "last seen seq" advances accordingly,
			// so subsequent broadcasts will appear contiguous.
			Seq: s.hub.NextSeq(auction.ID),
		}),
	})
}

// StartAuction activates a pending auction
func (s *AuctionService) StartAuction(auction *models.Auction) error {
	now := time.Now()
	endTime := now.Add(time.Duration(auction.Duration) * time.Second)
	auction.StartTime = &now
	auction.EndTime = &endTime
	auction.Status = models.AuctionActive

	if err := s.db.Save(auction).Error; err != nil {
		return err
	}

	// Update product status
	s.db.Model(&models.Product{}).Where("id = ?", auction.ProductID).
		Update("status", models.ProductAuction)

	// Broadcast to all clients
	s.db.Preload("Product.Seller").Preload("Seller").First(auction, auction.ID)
	s.hub.BroadcastAll(ws.Message{
		Type:      ws.MsgAuctionStart,
		AuctionID: auction.ID,
		Data:      mustMarshal(auction),
	})

	log.Printf("Auction %d started, ends at %v", auction.ID, endTime)
	return nil
}

// CancelAuction aborts an auction in pending or active state. Used by sellers
// who need to pull a listing (wrong description, item lost/damaged, dispute,
// etc.). Concurrency notes:
//   - Like EndAuction, uses an atomic CAS-style UPDATE gated by current status
//     so two concurrent cancels (or a cancel racing with an EndAuction tick)
//     can't both "win". Whoever's UPDATE returns RowsAffected=1 owns the
//     state transition; the loser bails.
//   - Active bids are marked BidCancelled (distinct from BidOutbid) so the
//     bid history accurately reflects WHY the user didn't win.
//   - The product is reverted to "active" so the seller can immediately
//     re-list with corrected info.
func (s *AuctionService) CancelAuction(auction *models.Auction, reason string) error {
	now := time.Now()

	// Atomic claim: only succeed if status is still pending/active.
	res := s.db.Model(&models.Auction{}).
		Where("id = ? AND status IN ?", auction.ID, []models.AuctionStatus{models.AuctionPending, models.AuctionActive}).
		Updates(map[string]interface{}{
			"status":        models.AuctionCancelled,
			"cancel_reason": reason,
			"cancelled_at":  now,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		// Already settled or cancelled — race lost, treat as success
		// from caller's point of view (the auction is no longer running).
		return nil
	}

	// Best-effort cleanup. We do these outside a single big tx because
	// each is independent and a partial failure (e.g., product update
	// fails) shouldn't roll back the cancellation itself — the auction
	// being cancelled is the user-visible truth.
	s.db.Model(&models.Bid{}).
		Where("auction_id = ? AND status = ?", auction.ID, models.BidActive).
		Update("status", models.BidCancelled)

	s.db.Model(&models.Product{}).
		Where("id = ?", auction.ProductID).
		Update("status", models.ProductActive)

	// Reflect changes on the in-memory copy so the caller can return it.
	auction.Status = models.AuctionCancelled
	auction.CancelReason = reason
	auction.CancelledAt = &now

	// Notify everyone watching the auction so their UI flips immediately
	// rather than waiting for the next poll/refresh.
	s.hub.BroadcastToRoom(auction.ID, ws.Message{
		Type:      ws.MsgAuctionCancel,
		AuctionID: auction.ID,
		Data: mustMarshal(ws.AuctionCancelData{
			AuctionID: auction.ID,
			Reason:    reason,
		}),
	})

	log.Printf("Auction %d cancelled by seller, reason=%q", auction.ID, reason)

	// Same Redis cleanup as EndAuction — see comment there.
	go func(id uint) {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		s.OnAuctionFinalized(ctx, id)
	}(auction.ID)

	return nil
}
