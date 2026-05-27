package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
	"market/services"
)

type RoomHandler struct {
	db         *gorm.DB
	auctionSvc *services.AuctionService
}

func NewRoomHandler(db *gorm.DB, svc *services.AuctionService) *RoomHandler {
	return &RoomHandler{db: db, auctionSvc: svc}
}

type CreateRoomRequest struct {
	Title       string `json:"title" binding:"required,min=2,max=100"`
	Description string `json:"description" binding:"max=2000"`
	CoverURL    string `json:"cover_url" binding:"max=500"`
}

// Create opens a new auction room owned by the calling user. Any logged-in
// user can host — there's no role gate here on purpose: the role system in
// this codebase governs the merchant /admin/* surface, while user-hosted
// rooms are a peer-to-peer feature.
func (h *RoomHandler) Create(c *gin.Context) {
	userID := c.GetUint("userID")

	var req CreateRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	room := models.AuctionRoom{
		HostID:      userID,
		Title:       req.Title,
		Description: req.Description,
		CoverURL:    req.CoverURL,
		Status:      models.RoomOpen,
	}
	if err := h.db.Create(&room).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create room"})
		return
	}
	h.db.Preload("Host").First(&room, room.ID)
	c.JSON(http.StatusCreated, room)
}

// List returns rooms ordered by liveness: open rooms with an active auction
// first, then open-but-idle, then closed. This mirrors the user's likely
// browsing intent ("show me what's happening NOW").
func (h *RoomHandler) List(c *gin.Context) {
	userID := c.GetUint("userID")

	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 || limit > 100 {
		limit = 30
	}

	query := h.db.Model(&models.AuctionRoom{}).Preload("Host")

	// Optional ?mine=true — host-managed rooms list, used by the manage UI.
	if c.Query("mine") == "true" {
		query = query.Where("host_id = ?", userID)
	} else {
		// Public listing: hide closed rooms with no auctions (dead rooms).
		// Closed-but-historic rooms are still hidden to keep the discovery
		// list useful — historic content is available via the host's profile.
		query = query.Where("status = ?", models.RoomOpen)
	}

	var rooms []models.AuctionRoom
	if err := query.
		Order("CASE WHEN current_auction_id IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC").
		Limit(limit).
		Find(&rooms).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch rooms"})
		return
	}

	c.JSON(http.StatusOK, rooms)
}

// Get returns a room with its current auction and pending queue. The queue
// is just an ordered list of pending auctions tied to this room. We don't
// page it because rooms practically have <100 queued items.
func (h *RoomHandler) Get(c *gin.Context) {
	id := c.Param("id")

	var room models.AuctionRoom
	if err := h.db.Preload("Host").First(&room, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	// Current auction (the one being bid on right now).
	var current *models.Auction
	if room.CurrentAuctionID != nil {
		var a models.Auction
		if err := h.db.Preload("Product").Preload("Seller").First(&a, *room.CurrentAuctionID).Error; err == nil {
			// If the cached pointer is stale (auction already ended) we
			// surface it anyway so the UI can render the result; the
			// auto-advance pass will clear it on the next end event.
			current = &a
		}
	}

	// Pending queue — auctions waiting their turn, oldest first.
	var queue []models.Auction
	h.db.Preload("Product").
		Where("room_id = ? AND status = ?", room.ID, models.AuctionPending).
		Order("created_at ASC").
		Find(&queue)

	// History — recent ended auctions in this room. Cheap LIMIT 10.
	var history []models.Auction
	h.db.Preload("Product").Preload("Winner").
		Where("room_id = ? AND status IN ?", room.ID, []models.AuctionStatus{
			models.AuctionEnded, models.AuctionCancelled,
		}).
		Order("updated_at DESC").
		Limit(10).
		Find(&history)

	// Decorate current with seconds_left so the client can render an
	// initial countdown without waiting for the first WS tick.
	type currentOut struct {
		*models.Auction
		SecondsLeft int `json:"seconds_left"`
	}
	var currentResp interface{}
	if current != nil {
		s := 0
		if current.EndTime != nil {
			s = int(time.Until(*current.EndTime).Seconds())
			if s < 0 {
				s = 0
			}
		}
		currentResp = currentOut{Auction: current, SecondsLeft: s}
	}

	c.JSON(http.StatusOK, gin.H{
		"room":    room,
		"current": currentResp,
		"queue":   queue,
		"history": history,
	})
}

type UpdateRoomRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	CoverURL    *string `json:"cover_url"`
}

// Update lets the host edit the room's display fields. Status changes go
// through Close so we have a single closure code path.
func (h *RoomHandler) Update(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var room models.AuctionRoom
	if err := h.db.Where("id = ? AND host_id = ?", id, userID).First(&room).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}

	var req UpdateRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	updates := map[string]interface{}{}
	if req.Title != nil {
		updates["title"] = *req.Title
	}
	if req.Description != nil {
		updates["description"] = *req.Description
	}
	if req.CoverURL != nil {
		updates["cover_url"] = *req.CoverURL
	}
	if len(updates) > 0 {
		if err := h.db.Model(&room).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update"})
			return
		}
	}
	h.db.Preload("Host").First(&room, room.ID)
	c.JSON(http.StatusOK, room)
}

// Close marks the room as closed. We refuse if there's an in-flight auction
// (host should cancel it first) — closing while live would either orphan
// bidders or require us to also cancel the auction, and "close" should mean
// a clean shutdown decision, not a side-effect cascade.
func (h *RoomHandler) Close(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var room models.AuctionRoom
	if err := h.db.Where("id = ? AND host_id = ?", id, userID).First(&room).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if room.Status == models.RoomClosed {
		c.JSON(http.StatusOK, room)
		return
	}

	// Block close if there's an active auction.
	var liveCount int64
	h.db.Model(&models.Auction{}).
		Where("room_id = ? AND status = ?", room.ID, models.AuctionActive).
		Count(&liveCount)
	if liveCount > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cancel the live auction before closing the room"})
		return
	}

	if err := h.db.Model(&room).Updates(map[string]interface{}{
		"status":             models.RoomClosed,
		"current_auction_id": nil,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to close"})
		return
	}
	room.Status = models.RoomClosed
	c.JSON(http.StatusOK, room)
}

type AddAuctionRequest struct {
	ProductID    uint    `json:"product_id" binding:"required"`
	StartPrice   float64 `json:"start_price" binding:"min=0"`
	MinIncrement float64 `json:"min_increment" binding:"required,min=0.01"`
	HasBuyNow    bool    `json:"has_buy_now"`
	BuyNowPrice  float64 `json:"buy_now_price"`
	HasReserve   bool    `json:"has_reserve"`
	ReservePrice float64 `json:"reserve_price"`
	RequiresDeposit bool    `json:"requires_deposit"`
	DepositAmount   float64 `json:"deposit_amount"`
	Duration     int     `json:"duration" binding:"required,min=60"`
}

// AddAuction queues a new auction inside this room. If the room currently
// has no active auction, the new auction is immediately promoted to active —
// otherwise it sits in the queue until the auto-advance hook picks it up
// when the prior auction ends.
func (h *RoomHandler) AddAuction(c *gin.Context) {
	userID := c.GetUint("userID")
	idStr := c.Param("id")

	var room models.AuctionRoom
	if err := h.db.Where("id = ? AND host_id = ?", idStr, userID).First(&room).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if room.Status != models.RoomOpen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "room is closed"})
		return
	}

	var req AddAuctionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate product ownership — same rule as the standalone /api/auctions
	// path. Hosts can only queue their own products.
	var product models.Product
	if err := h.db.Where("id = ? AND seller_id = ?", req.ProductID, userID).First(&product).Error; err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "product not found or not owned by you"})
		return
	}
	if product.Status != models.ProductActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "product is not available for auction"})
		return
	}

	// Same buy-now / reserve sanity checks as the standalone create.
	if req.HasBuyNow && req.BuyNowPrice <= req.StartPrice {
		c.JSON(http.StatusBadRequest, gin.H{"error": "buy-now price must be greater than start price"})
		return
	}
	if req.HasReserve {
		if req.ReservePrice < req.StartPrice {
			c.JSON(http.StatusBadRequest, gin.H{"error": "reserve price must be at least the start price"})
			return
		}
		if req.HasBuyNow && req.ReservePrice > req.BuyNowPrice {
			c.JSON(http.StatusBadRequest, gin.H{"error": "reserve price cannot exceed buy-now price"})
			return
		}
	}
	if req.RequiresDeposit && req.DepositAmount <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "deposit amount must be greater than zero"})
		return
	}

	roomID := room.ID
	auction := models.Auction{
		ProductID:    req.ProductID,
		SellerID:     userID,
		RoomID:       &roomID,
		StartPrice:   req.StartPrice,
		CurrentPrice: req.StartPrice,
		MinIncrement: req.MinIncrement,
		HasReserve:   req.HasReserve,
		ReservePrice: req.ReservePrice,
		HasBuyNow:    req.HasBuyNow,
		BuyNowPrice:  req.BuyNowPrice,
		RequiresDeposit: req.RequiresDeposit,
		DepositAmount:   req.DepositAmount,
		Duration:     req.Duration,
		Status:       models.AuctionPending,
	}
	if !auction.HasBuyNow {
		auction.BuyNowPrice = 0
	}
	if !auction.HasReserve {
		auction.ReservePrice = 0
	}
	if !auction.RequiresDeposit {
		auction.DepositAmount = 0
	}

	if err := h.db.Create(&auction).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to queue auction"})
		return
	}
	h.db.Model(&room).UpdateColumn("total_auctions", gorm.Expr("total_auctions + 1"))

	// Auto-promote: if the room is idle, kick off this auction immediately
	// so the host doesn't have to make a second API call. The room's queue
	// invariant ("at most one active auction") is guarded by the
	// current_auction_id check below.
	if room.CurrentAuctionID == nil {
		if err := h.auctionSvc.StartAuction(&auction); err != nil {
			// We don't roll back the insert — the auction is still validly
			// queued; the host can manually start it later.
			h.db.Preload("Product").First(&auction, auction.ID)
			c.JSON(http.StatusCreated, gin.H{"auction": auction, "started": false})
			return
		}
		h.db.Model(&room).UpdateColumn("current_auction_id", auction.ID)
	}

	h.db.Preload("Product").First(&auction, auction.ID)
	c.JSON(http.StatusCreated, gin.H{"auction": auction, "started": auction.Status == models.AuctionActive})
}

// StartNext lets the host advance the queue manually when the previous
// auction has ended but auto-advance was skipped (e.g., the host wanted a
// pause). Picks the oldest pending auction in the room.
func (h *RoomHandler) StartNext(c *gin.Context) {
	userID := c.GetUint("userID")
	idStr := c.Param("id")

	var room models.AuctionRoom
	if err := h.db.Where("id = ? AND host_id = ?", idStr, userID).First(&room).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if room.Status != models.RoomOpen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "room is closed"})
		return
	}
	if room.CurrentAuctionID != nil {
		// Verify the current is actually still active before refusing.
		var live int64
		h.db.Model(&models.Auction{}).
			Where("id = ? AND status = ?", *room.CurrentAuctionID, models.AuctionActive).
			Count(&live)
		if live > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "an auction is still live in this room"})
			return
		}
	}

	var next models.Auction
	if err := h.db.Where("room_id = ? AND status = ?", room.ID, models.AuctionPending).
		Order("created_at ASC").
		First(&next).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "queue is empty"})
		return
	}

	if err := h.auctionSvc.StartAuction(&next); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start"})
		return
	}
	h.db.Model(&room).UpdateColumn("current_auction_id", next.ID)
	c.JSON(http.StatusOK, next)
}
