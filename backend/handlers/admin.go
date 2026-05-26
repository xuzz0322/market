package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
)

// AdminHandler powers the merchant/admin console. All endpoints assume
// the caller has been auth'd and is in role "seller" or "admin" — that
// gate is enforced by the route group, not re-checked per endpoint.
//
// Scoping note: a "seller" sees only their own data (filtered by
// seller_id == auth.userID). An "admin" sees everything. This is enforced
// by passing the caller's userID through scope() below.
type AdminHandler struct {
	db *gorm.DB
}

func NewAdminHandler(db *gorm.DB) *AdminHandler {
	return &AdminHandler{db: db}
}

// scope returns a query scoped to the caller's data unless they're an admin.
// Centralizing here means a forgotten WHERE clause in one handler doesn't
// silently leak other sellers' data.
func (h *AdminHandler) scope(c *gin.Context, query *gorm.DB, ownerCol string) *gorm.DB {
	role, _ := c.Get("role")
	userID := c.GetUint("userID")
	if role != string(models.RoleAdmin) {
		return query.Where(ownerCol+" = ?", userID)
	}
	return query
}

// Dashboard returns the data shown on the admin home page. We pre-aggregate
// here so the client gets a single round-trip instead of issuing N queries
// for each card.
//
// "Today" boundaries use server-local midnight, which is fine for a single-
// region deploy. Multi-region would need per-merchant timezone or UTC.
func (h *AdminHandler) Dashboard(c *gin.Context) {
	startOfDay := time.Now().Truncate(24 * time.Hour)

	type stats struct {
		ActiveAuctions int64   `json:"active_auctions"`
		TodayBids      int64   `json:"today_bids"`
		TodayGMV       float64 `json:"today_gmv"`
		TotalProducts  int64   `json:"total_products"`
		TodayViews     int64   `json:"today_views"`
		LiveBidders    int64   `json:"live_bidders"`
	}
	var s stats

	// Active auctions owned by this seller
	h.scope(c, h.db.Model(&models.Auction{}), "seller_id").
		Where("status = ?", models.AuctionActive).
		Count(&s.ActiveAuctions)

	// Today's bids: count bids placed on this seller's auctions today.
	// Subquery keeps it to a single SQL round-trip.
	auctionIDs := h.scope(c, h.db.Model(&models.Auction{}), "seller_id").Select("id")
	h.db.Model(&models.Bid{}).
		Where("auction_id IN (?) AND created_at >= ?", auctionIDs, startOfDay).
		Count(&s.TodayBids)

	// Today's GMV: sum of final_price for ended auctions today (auctions
	// that ended successfully — `winner_id IS NOT NULL`).
	var gmv struct{ Total float64 }
	h.scope(c, h.db.Model(&models.Auction{}), "seller_id").
		Where("status = ? AND winner_id IS NOT NULL AND updated_at >= ?", models.AuctionEnded, startOfDay).
		Select("COALESCE(SUM(current_price), 0) as total").
		Scan(&gmv)
	s.TodayGMV = gmv.Total

	// Total products
	h.scope(c, h.db.Model(&models.Product{}), "seller_id").Count(&s.TotalProducts)

	// Total views across all auctions
	var views struct{ Total int64 }
	h.scope(c, h.db.Model(&models.Auction{}), "seller_id").
		Select("COALESCE(SUM(view_count), 0) as total").
		Scan(&views)
	s.TodayViews = views.Total

	// Live bidders: distinct users who bid in the last 5 minutes on any
	// of this seller's active auctions.
	h.db.Model(&models.Bid{}).
		Where("auction_id IN (?) AND created_at >= ?", auctionIDs, time.Now().Add(-5*time.Minute)).
		Distinct("user_id").
		Count(&s.LiveBidders)

	c.JSON(http.StatusOK, s)
}

// TopProducts returns the seller's auctions ordered by current bid value.
// Used on the dashboard "best performers" widget.
func (h *AdminHandler) TopProducts(c *gin.Context) {
	type row struct {
		AuctionID    uint    `json:"auction_id"`
		ProductTitle string  `json:"product_title"`
		CurrentPrice float64 `json:"current_price"`
		BidCount     int     `json:"bid_count"`
		ViewCount    int     `json:"view_count"`
		Status       string  `json:"status"`
	}
	var rows []row
	q := h.db.Table("auctions a").
		Select("a.id as auction_id, p.title as product_title, a.current_price, a.bid_count, a.view_count, a.status").
		Joins("JOIN products p ON p.id = a.product_id").
		Where("a.deleted_at IS NULL")
	q = h.scope(c, q, "a.seller_id").
		Order("a.current_price DESC").
		Limit(10)
	q.Scan(&rows)

	c.JSON(http.StatusOK, rows)
}

// LiveAuctions returns active auctions for the live control console — a
// seller's "command center" view of everything currently bidding.
func (h *AdminHandler) LiveAuctions(c *gin.Context) {
	var auctions []models.Auction
	q := h.db.Preload("Product").Preload("Winner").
		Where("status = ?", models.AuctionActive)
	q = h.scope(c, q, "seller_id").
		Order("end_time ASC") // about-to-end first — needs attention
	q.Find(&auctions)

	type out struct {
		models.Auction
		SecondsLeft int `json:"seconds_left"`
	}
	result := make([]out, len(auctions))
	for i, a := range auctions {
		o := out{Auction: a}
		if a.EndTime != nil {
			o.SecondsLeft = int(time.Until(*a.EndTime).Seconds())
			if o.SecondsLeft < 0 {
				o.SecondsLeft = 0
			}
		}
		result[i] = o
	}
	c.JSON(http.StatusOK, result)
}

// AllProducts returns the seller's products including drafts and ended.
// Different from /api/products?mine=true which is buyer-oriented (active only).
func (h *AdminHandler) AllProducts(c *gin.Context) {
	var products []models.Product
	q := h.scope(c, h.db.Preload("Seller"), "seller_id").
		Order("created_at DESC")
	q.Find(&products)
	c.JSON(http.StatusOK, products)
}

// AllAuctions returns every auction the seller has ever run. Filterable
// by status for tabs in the admin UI.
func (h *AdminHandler) AllAuctions(c *gin.Context) {
	var auctions []models.Auction
	q := h.db.Preload("Product").Preload("Winner")
	q = h.scope(c, q, "seller_id")
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	q.Order("created_at DESC").Find(&auctions)
	c.JSON(http.StatusOK, auctions)
}

// RecentBids shows the latest bids on this seller's auctions — useful as
// a live-feed widget on the dashboard.
func (h *AdminHandler) RecentBids(c *gin.Context) {
	auctionIDs := h.scope(c, h.db.Model(&models.Auction{}), "seller_id").Select("id")
	var bids []models.Bid
	h.db.Where("auction_id IN (?)", auctionIDs).
		Preload("User").
		Preload("Auction.Product").
		Order("created_at DESC").
		Limit(50).
		Find(&bids)
	c.JSON(http.StatusOK, bids)
}
