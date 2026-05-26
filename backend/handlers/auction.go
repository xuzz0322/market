package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
	"market/services"
	"market/ws"
)

type AuctionHandler struct {
	db         *gorm.DB
	hub        *ws.Hub
	auctionSvc *services.AuctionService
}

func NewAuctionHandler(db *gorm.DB, hub *ws.Hub, svc *services.AuctionService) *AuctionHandler {
	return &AuctionHandler{db: db, hub: hub, auctionSvc: svc}
}

type CreateAuctionRequest struct {
	ProductID    uint    `json:"product_id" binding:"required"`
	StartPrice   float64 `json:"start_price" binding:"min=0"`
	MinIncrement float64 `json:"min_increment" binding:"required,min=0.01"`
	HasReserve   bool    `json:"has_reserve"`
	ReservePrice float64 `json:"reserve_price"`
	HasBuyNow    bool    `json:"has_buy_now"`
	BuyNowPrice  float64 `json:"buy_now_price"`
	Duration     int     `json:"duration" binding:"required,min=60"`
}

type CancelAuctionRequest struct {
	Reason string `json:"reason" binding:"max=500"`
}

func (h *AuctionHandler) Create(c *gin.Context) {
	userID := c.GetUint("userID")

	var req CreateAuctionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify product ownership
	var product models.Product
	if err := h.db.Where("id = ? AND seller_id = ?", req.ProductID, userID).First(&product).Error; err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "product not found or not owned by you"})
		return
	}

	if product.Status != models.ProductActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "product is not available for auction"})
		return
	}

	// Check no existing auction for this product
	var existing models.Auction
	if err := h.db.Where("product_id = ? AND status IN (?)", req.ProductID, []string{"pending", "active"}).First(&existing).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "auction already exists for this product"})
		return
	}

	// Validate buy-now price: must exceed start price when enabled.
	// Otherwise the auction would end on first bid, defeating the purpose.
	if req.HasBuyNow && req.BuyNowPrice <= req.StartPrice {
		c.JSON(http.StatusBadRequest, gin.H{"error": "buy-now price must be greater than start price"})
		return
	}
	// Validate reserve price: must be ≥ start price (otherwise pointless),
	// and if both reserve + buy-now are set, reserve must be ≤ buy-now
	// (otherwise reaching buy-now wouldn't satisfy reserve, which is absurd).
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

	auction := models.Auction{
		ProductID:    req.ProductID,
		SellerID:     userID,
		StartPrice:   req.StartPrice,
		CurrentPrice: req.StartPrice,
		MinIncrement: req.MinIncrement,
		HasReserve:   req.HasReserve,
		ReservePrice: req.ReservePrice,
		HasBuyNow:    req.HasBuyNow,
		BuyNowPrice:  req.BuyNowPrice,
		Duration:     req.Duration,
		Status:       models.AuctionPending,
	}

	// Normalize: zero out disabled-feature prices so downstream checks
	// can rely on the pair (HasX, XPrice) being consistent regardless
	// of what the client sent.
	if !auction.HasBuyNow {
		auction.BuyNowPrice = 0
	}
	if !auction.HasReserve {
		auction.ReservePrice = 0
	}

	if err := h.db.Create(&auction).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create auction"})
		return
	}

	h.db.Preload("Product.Seller").Preload("Seller").First(&auction, auction.ID)
	c.JSON(http.StatusCreated, auction)
}

func (h *AuctionHandler) Start(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var auction models.Auction
	if err := h.db.Where("id = ? AND seller_id = ?", id, userID).First(&auction).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}

	if auction.Status != models.AuctionPending {
		c.JSON(http.StatusBadRequest, gin.H{"error": "auction is not in pending status"})
		return
	}

	if err := h.auctionSvc.StartAuction(&auction); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start auction"})
		return
	}

	c.JSON(http.StatusOK, auction)
}

func (h *AuctionHandler) List(c *gin.Context) {
	var auctions []models.Auction
	query := h.db.Preload("Product").Preload("Seller").Preload("Winner").Order("created_at DESC")

	status := c.Query("status")
	if status != "" {
		query = query.Where("status = ?", status)
	} else {
		// Default: show active and recent ended
		query = query.Where("status IN (?)", []string{"active", "pending"})
	}

	if err := query.Find(&auctions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch auctions"})
		return
	}

	// Add seconds_left for active auctions
	type AuctionWithTime struct {
		models.Auction
		SecondsLeft int `json:"seconds_left"`
	}

	result := make([]AuctionWithTime, len(auctions))
	for i, a := range auctions {
		awt := AuctionWithTime{Auction: a}
		if a.EndTime != nil {
			awt.SecondsLeft = int(time.Until(*a.EndTime).Seconds())
			if awt.SecondsLeft < 0 {
				awt.SecondsLeft = 0
			}
		}
		result[i] = awt
	}

	c.JSON(http.StatusOK, result)
}

func (h *AuctionHandler) Get(c *gin.Context) {
	id := c.Param("id")
	userID := c.GetUint("userID")

	var auction models.Auction
	if err := h.db.Preload("Product.Seller").Preload("Seller").Preload("Winner").
		First(&auction, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}

	// Increment view count (unique views via simple increment)
	h.db.Model(&auction).UpdateColumn("view_count", gorm.Expr("view_count + 1"))
	auction.ViewCount++

	// Get rankings
	rankings := h.auctionSvc.GetRankings(auction.ID, 10)

	// Get user's highest bid
	var userBid models.Bid
	userBidAmount := 0.0
	if err := h.db.Where("auction_id = ? AND user_id = ?", auction.ID, userID).
		Order("amount DESC").First(&userBid).Error; err == nil {
		userBidAmount = userBid.Amount
	}

	secondsLeft := 0
	if auction.EndTime != nil {
		secondsLeft = int(time.Until(*auction.EndTime).Seconds())
		if secondsLeft < 0 {
			secondsLeft = 0
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"auction":        auction,
		"rankings":       rankings,
		"seconds_left":   secondsLeft,
		"user_bid":       userBidAmount,
	})
}

// Cancel allows the seller to abort an auction in pending or active state.
// All active bids are marked as cancelled (not outbid — semantically different,
// users will get notified that the seller pulled out, not that they lost).
// The product status is reverted to "active" so the seller can re-list.
func (h *AuctionHandler) Cancel(c *gin.Context) {
	userID := c.GetUint("userID")
	idStr := c.Param("id")

	var req CancelAuctionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var auction models.Auction
	if err := h.db.Where("id = ? AND seller_id = ?", idStr, userID).First(&auction).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}

	if auction.Status != models.AuctionPending && auction.Status != models.AuctionActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "auction is not cancellable in its current state"})
		return
	}

	if err := h.auctionSvc.CancelAuction(&auction, req.Reason); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to cancel auction"})
		return
	}

	c.JSON(http.StatusOK, auction)
}
