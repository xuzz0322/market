package handlers

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"market/cache"
	"market/models"
	"market/mq"
	"market/services"
	"market/ws"
)

type BidHandler struct {
	db         *gorm.DB
	hub        *ws.Hub
	auctionSvc *services.AuctionService
	cache      *cache.Client
	producer   *mq.Producer
}

func NewBidHandler(db *gorm.DB, hub *ws.Hub, svc *services.AuctionService, c *cache.Client, producer *mq.Producer) *BidHandler {
	return &BidHandler{db: db, hub: hub, auctionSvc: svc, cache: c, producer: producer}
}

type PlaceBidRequest struct {
	Amount      float64 `json:"amount" binding:"required,min=0.01"`
	ClientBidID string  `json:"client_bid_id"` // optional UUID for idempotency
}

// errors used by retry logic
var (
	errStaleVersion = errors.New("auction version conflict, retry")
)

const (
	maxBidRetries  = 3
	bidTxTimeout   = 3 * time.Second
)

// PlaceBid places a bid with strong concurrency guarantees:
//  1. Idempotency: same (auction_id, client_bid_id) is rejected at DB level (unique index)
//  2. Row lock: SELECT ... FOR UPDATE prevents concurrent reads of stale current_price
//  3. Optimistic version: UPDATE ... WHERE version = ? as second-line defense across instances
//  4. Tx timeout: protects DB pool from being exhausted by slow clients
//  5. Retry on serialization failures (deadlock / version conflict)
func (h *BidHandler) PlaceBid(c *gin.Context) {
	userID := c.GetUint("userID")
	auctionID := parseUintParam(c, "id")
	if auctionID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid auction id"})
		return
	}

	var req PlaceBidRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Idempotency fast-path: if same client_bid_id was already accepted, return prior result
	if req.ClientBidID != "" {
		var existing models.Bid
		if err := h.db.Where("auction_id = ? AND client_bid_id = ?", auctionID, req.ClientBidID).First(&existing).Error; err == nil {
			// Already processed — return success (idempotent)
			c.JSON(http.StatusOK, gin.H{
				"bid":           existing,
				"current_price": existing.Amount,
				"idempotent":    true,
			})
			return
		}
	}

	var (
		bid          models.Bid
		auction      models.Auction
		currentUser  models.User
		newPrice     float64
		isBuyNow     bool
		// displacedUsers holds the user IDs that were leading before this
		// bid landed (i.e., had active bids that we just downgraded to
		// outbid). We capture them inside the tx so we can notify them
		// post-commit. NotifyOutbid skips the bidder themself.
		displacedUsers []uint
	)

	// Retry loop for transient conflicts (deadlock, version mismatch)
	var lastErr error
	for attempt := 0; attempt < maxBidRetries; attempt++ {
		ctx, cancel := contextWithTimeout(c, bidTxTimeout)
		txErr := h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			// Lock auction row to serialize concurrent bids
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				First(&auction, auctionID).Error; err != nil {
				return err
			}

			// Validate auction state
			if auction.Status != models.AuctionActive {
				return &bidValidationError{Code: 400, Msg: "auction is not active"}
			}
			if auction.EndTime != nil && time.Now().After(*auction.EndTime) {
				return &bidValidationError{Code: 400, Msg: "auction has ended"}
			}
			if auction.SellerID == userID {
				return &bidValidationError{Code: 400, Msg: "cannot bid on your own auction"}
			}

			// Deposit gate: if the seller required an earnest payment, block
			// users who haven't put it down yet. We DON'T deduct balance
			// here — the deposit is collected via /api/auctions/:id/deposit
			// before the user opens the bid panel.
			if auction.RequiresDeposit && auction.DepositAmount > 0 {
				var depCount int64
				tx.Model(&models.Deposit{}).
					Where("user_id = ? AND auction_id = ? AND status = ?", userID, auction.ID, models.DepositHeld).
					Count(&depCount)
				if depCount == 0 {
					return &bidValidationError{Code: 402, Msg: "请先缴纳保证金"}
				}
			}

			minBid := auction.CurrentPrice + auction.MinIncrement
			if auction.BidCount == 0 {
				minBid = auction.StartPrice
			}
			if req.Amount < minBid {
				return &bidValidationError{Code: 400, Msg: "bid too low"}
			}

			// Lock user balance row (small lock window — only the user themself)
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				First(&currentUser, userID).Error; err != nil {
				return err
			}
			// Credit gate. Same threshold as the deposit endpoint so users
			// don't get blocked unexpectedly mid-flow ("I paid the deposit
			// but can't bid?"). A 402-ish status would mislead clients into
			// thinking it's a payment issue, so we use 403.
			if currentUser.CreditScore < models.CreditMinToBid {
				return &bidValidationError{Code: 403, Msg: "信用分过低，暂时无法参与拍卖"}
			}
			if currentUser.Balance < req.Amount {
				return &bidValidationError{Code: 400, Msg: "insufficient balance"}
			}

			// Capture the previous leader BEFORE we mutate state. The
			// leader is whoever held a bid equal to the pre-update
			// current_price — that's the user this new bid is displacing.
			// Skipped on the very first bid (no one to displace).
			if auction.BidCount > 0 {
				var prev struct{ UserID uint }
				tx.Raw(`
					SELECT user_id FROM bids
					WHERE auction_id = ? AND amount = ? AND user_id != ?
					ORDER BY id DESC LIMIT 1
				`, auction.ID, auction.CurrentPrice, userID).Scan(&prev)
				if prev.UserID > 0 {
					displacedUsers = append(displacedUsers, prev.UserID)
				}
			}

			// Mark previous active bids from this user as outbid
			if err := tx.Model(&models.Bid{}).
				Where("auction_id = ? AND user_id = ? AND status = ?", auction.ID, userID, models.BidActive).
				Update("status", models.BidOutbid).Error; err != nil {
				return err
			}

			// Insert new bid (unique index on (auction_id, client_bid_id) enforces idempotency)
			bid = models.Bid{
				AuctionID:   auction.ID,
				UserID:      userID,
				Amount:      req.Amount,
				Status:      models.BidActive,
				ClientBidID: req.ClientBidID,
			}
			if err := tx.Create(&bid).Error; err != nil {
				// Detect MySQL duplicate-key (idempotent retry from same client)
				var mysqlErr *mysql.MySQLError
				if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
					// Find the existing bid and return it
					return tx.Where("auction_id = ? AND client_bid_id = ?", auction.ID, req.ClientBidID).
						First(&bid).Error
				}
				return err
			}

			// Optimistic version update: only succeeds if row hasn't changed since SELECT FOR UPDATE
			// (defense in depth — within a tx with row lock this should always succeed, but for safety)
			res := tx.Model(&models.Auction{}).
				Where("id = ? AND version = ?", auction.ID, auction.Version).
				Updates(map[string]interface{}{
					"current_price": req.Amount,
					"bid_count":     gorm.Expr("bid_count + 1"),
					"version":       gorm.Expr("version + 1"),
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return errStaleVersion
			}

			newPrice = req.Amount
			isBuyNow = auction.HasBuyNow && auction.BuyNowPrice > 0 && req.Amount >= auction.BuyNowPrice
			return nil
		})
		cancel()

		if txErr == nil {
			break
		}

		// Validation failures don't retry
		var vErr *bidValidationError
		if errors.As(txErr, &vErr) {
			c.JSON(vErr.Code, gin.H{"error": vErr.Msg})
			return
		}

		// Retry on transient errors (deadlock 1213, lock wait timeout 1205, version conflict)
		if isRetryableError(txErr) && attempt < maxBidRetries-1 {
			time.Sleep(time.Duration(20*(attempt+1)) * time.Millisecond)
			lastErr = txErr
			continue
		}

		lastErr = txErr
		break
	}

	if lastErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "bid failed, please retry"})
		return
	}

	// Reload auction (post-transaction) and broadcast canonical state.
	// All seq/timestamp/end_at_ms wiring is centralized in the service so
	// every broadcast path is consistent — clients depend on these fields
	// for gap detection and clock-skew-corrected countdowns.
	h.db.First(&auction, auction.ID)

	// Update the Redis leaderboard. ZADD is idempotent and uses GT, so
	// out-of-order arrivals can't downgrade a user's high bid. Done before
	// the broadcast so the rankings included in the broadcast match what
	// any later HTTP fetch would return.
	bgCtx, bgCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	h.auctionSvc.OnBidPlaced(bgCtx, auction.ID, userID, currentUser.Username, currentUser.Avatar, newPrice)
	bgCancel()

	// Heat incr via Kafka (at-most-once). If Kafka is down we fall back
	// to the direct Redis path so the score stays approximate but not stale.
	if h.producer != nil && h.producer.Available() {
		_ = h.producer.Publish(mq.TopicHeatIncr, mq.FormatAuctionKey(auction.ID), mq.HeatIncrEvent{
			Kind:      "bid",
			AuctionID: auction.ID,
		})
	} else if h.cache != nil {
		fallCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		cache.IncrBidDelta(fallCtx, h.cache, auction.ID)
		cancel()
	}

	h.auctionSvc.BroadcastBidState(&auction, currentUser.Username)

	// "You've been outbid" notifications via Kafka (at-most-once). Each
	// displaced user gets a separate message keyed by their user_id so
	// all their outbid events land on the same partition in order.
	// Falls back to the in-process goroutine path if Kafka is unavailable.
	if len(displacedUsers) > 0 {
		h.db.Preload("Product").First(&auction, auction.ID)
		productTitle := ""
		if auction.Product != nil {
			productTitle = auction.Product.Title
		}
		secondsLeft := 0
		if auction.EndTime != nil {
			secondsLeft = int(time.Until(*auction.EndTime).Seconds())
			if secondsLeft < 0 {
				secondsLeft = 0
			}
		}

		// Collect prior bids to show "your ¥X was beaten".
		type prevBid struct {
			UserID uint
			Amount float64
		}
		var prev []prevBid
		h.db.Raw(`SELECT user_id, MAX(amount) as amount FROM bids
			WHERE auction_id = ? AND user_id IN (?) AND status = ?
			GROUP BY user_id`, auction.ID, displacedUsers, models.BidOutbid).Scan(&prev)
		prevByUser := make(map[uint]float64)
		for _, p := range prev {
			prevByUser[p.UserID] = p.Amount
		}

		for _, uid := range displacedUsers {
			ev := mq.OutbidEvent{
				AuctionID:    auction.ID,
				ProductTitle: productTitle,
				DisplacedUID: uid,
				YourBid:      prevByUser[uid],
				NewPrice:     newPrice,
				NewLeader:    currentUser.Username,
				SecondsLeft:  secondsLeft,
			}
			if h.producer != nil && h.producer.Available() {
				_ = h.producer.Publish(mq.TopicNotifyOutbid, mq.FormatKey(uid), ev)
			} else {
				// Kafka unavailable: push directly via hub (legacy path).
				h.auctionSvc.NotifyOutbid(&auction, []uint{uid}, currentUser.Username, newPrice)
			}
		}
	}

	if isBuyNow {
		go h.auctionSvc.EndAuction(&auction)
	}

	bid.User = &currentUser
	c.JSON(http.StatusCreated, gin.H{
		"bid":           bid,
		"current_price": newPrice,
		"rankings":      h.auctionSvc.GetRankings(auction.ID, 10),
	})
}

func (h *BidHandler) GetBids(c *gin.Context) {
	auctionID := c.Param("id")
	var bids []models.Bid
	if err := h.db.Where("auction_id = ?", auctionID).
		Preload("User").
		Order("created_at DESC").
		Limit(50).
		Find(&bids).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch bids"})
		return
	}
	c.JSON(http.StatusOK, bids)
}

// --- helpers ---

type bidValidationError struct {
	Code int
	Msg  string
}

func (e *bidValidationError) Error() string { return e.Msg }

func isRetryableError(err error) bool {
	if errors.Is(err, errStaleVersion) {
		return true
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		// 1213 = deadlock, 1205 = lock wait timeout
		return mysqlErr.Number == 1213 || mysqlErr.Number == 1205
	}
	return false
}
