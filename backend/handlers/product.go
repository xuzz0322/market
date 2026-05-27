package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
)

type ProductHandler struct {
	db *gorm.DB
}

func NewProductHandler(db *gorm.DB) *ProductHandler {
	return &ProductHandler{db: db}
}

type CreateProductRequest struct {
	Title       string `json:"title" binding:"required,max=200"`
	Description string `json:"description"`
	Images      string `json:"images"` // JSON array of URLs
	VideoURL    string `json:"video_url"`
	Category    string `json:"category"`
}

func (h *ProductHandler) Create(c *gin.Context) {
	userID := c.GetUint("userID")

	var req CreateProductRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	product := models.Product{
		SellerID:    userID,
		Title:       req.Title,
		Description: req.Description,
		Images:      req.Images,
		VideoURL:    req.VideoURL,
		Category:    req.Category,
		Status:      models.ProductActive,
	}

	if err := h.db.Create(&product).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create product"})
		return
	}

	h.db.Preload("Seller").First(&product, product.ID)
	c.JSON(http.StatusCreated, product)
}

func (h *ProductHandler) List(c *gin.Context) {
	var products []models.Product
	query := h.db.Preload("Seller").Order("created_at DESC")

	category := c.Query("category")
	if category != "" {
		query = query.Where("category = ?", category)
	}

	status := c.Query("status")
	if status != "" {
		query = query.Where("status = ?", status)
	}

	// My products
	if c.Query("mine") == "true" {
		userID := c.GetUint("userID")
		query = query.Where("seller_id = ?", userID)
	}

	if err := query.Find(&products).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch products"})
		return
	}

	c.JSON(http.StatusOK, products)
}

// Search returns active products matching a free-text query and/or category.
// The keyword runs as a LIKE against title + description; we don't pull in
// MySQL FULLTEXT yet because at our scale (low-six-figure rows) the LIKE plan
// is fast enough on the title index, and FULLTEXT requires a schema migration
// the deploy story doesn't currently cover.
//
// To make results actionable, each product carries the ID of its currently
// in-progress auction (if any) so the client can deep-link into the auction
// room directly from the search results.
func (h *ProductHandler) Search(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	category := strings.TrimSpace(c.Query("category"))

	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}

	if q == "" && category == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one of q or category is required"})
		return
	}

	// Restrict to publicly browsable states. Drafts and sold items are not
	// useful in a search result for a buyer.
	query := h.db.Model(&models.Product{}).
		Where("status IN ?", []models.ProductStatus{
			models.ProductActive,
			models.ProductAuction,
		})

	if q != "" {
		// Escape wildcard chars in user input so a query like "50%" doesn't
		// match everything. We then wrap with our own % for substring match.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
		like := "%" + escaped + "%"
		query = query.Where("title LIKE ? OR description LIKE ?", like, like)
	}
	if category != "" {
		query = query.Where("category = ?", category)
	}

	var total int64
	query.Count(&total)

	var products []models.Product
	if err := query.
		Preload("Seller").
		Order("created_at DESC").
		Limit(limit).
		Offset((page - 1) * limit).
		Find(&products).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search"})
		return
	}

	// For products in 'auctioning' state, attach the active auction's ID so
	// the UI can deep-link straight into the bid room. One bulk query keeps
	// this O(1) regardless of result size.
	auctionByProduct := make(map[uint]uint, len(products))
	if len(products) > 0 {
		productIDs := make([]uint, 0, len(products))
		for _, p := range products {
			if p.Status == models.ProductAuction {
				productIDs = append(productIDs, p.ID)
			}
		}
		if len(productIDs) > 0 {
			type row struct {
				ProductID uint
				ID        uint
			}
			var rows []row
			h.db.Model(&models.Auction{}).
				Select("product_id, id").
				Where("product_id IN ? AND status IN ?", productIDs, []models.AuctionStatus{
					models.AuctionPending,
					models.AuctionActive,
				}).
				Scan(&rows)
			for _, r := range rows {
				auctionByProduct[r.ProductID] = r.ID
			}
		}
	}

	type result struct {
		models.Product
		AuctionID uint `json:"auction_id,omitempty"`
	}
	out := make([]result, len(products))
	for i, p := range products {
		out[i] = result{Product: p, AuctionID: auctionByProduct[p.ID]}
	}

	c.JSON(http.StatusOK, gin.H{
		"products": out,
		"total":    total,
		"page":     page,
		"limit":    limit,
	})
}

func (h *ProductHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var product models.Product
	if err := h.db.Preload("Seller").First(&product, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}
	c.JSON(http.StatusOK, product)
}

type UpdateProductRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	Images      *string `json:"images"`
	VideoURL    *string `json:"video_url"`
	Category    *string `json:"category"`
	Status      *string `json:"status"` // "draft" or "active" only — others are state-machine transitions
}

// Update edits a product. Only allowed when not currently in an auction
// (otherwise mid-auction edits would let sellers bait-and-switch). Uses
// pointer fields so unset fields don't clobber existing values.
func (h *ProductHandler) Update(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var req UpdateProductRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var product models.Product
	if err := h.db.Where("id = ? AND seller_id = ?", id, userID).First(&product).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}
	if product.Status == models.ProductAuction {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot edit a product currently in auction"})
		return
	}

	updates := map[string]interface{}{}
	if req.Title != nil       { updates["title"] = *req.Title }
	if req.Description != nil { updates["description"] = *req.Description }
	if req.Images != nil      { updates["images"] = *req.Images }
	if req.VideoURL != nil    { updates["video_url"] = *req.VideoURL }
	if req.Category != nil    { updates["category"] = *req.Category }
	if req.Status != nil {
		// Only let sellers toggle between draft (off-shelf) and active
		// (on-shelf). Auctioning/sold/ended are state-machine outputs,
		// not user choices.
		s := models.ProductStatus(*req.Status)
		if s != models.ProductDraft && s != models.ProductActive {
			c.JSON(http.StatusBadRequest, gin.H{"error": "status must be 'draft' or 'active'"})
			return
		}
		updates["status"] = s
	}

	if err := h.db.Model(&product).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update"})
		return
	}
	h.db.Preload("Seller").First(&product, product.ID)
	c.JSON(http.StatusOK, product)
}

// Delete soft-deletes a product. Refused if any auction (active or
// historical) references it — historical references matter because we
// still want to render the product details on past order pages.
func (h *ProductHandler) Delete(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var product models.Product
	if err := h.db.Where("id = ? AND seller_id = ?", id, userID).First(&product).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}
	if product.Status == models.ProductAuction {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete a product currently in auction"})
		return
	}

	var count int64
	h.db.Model(&models.Auction{}).Where("product_id = ?", product.ID).Count(&count)
	if count > 0 {
		// Has historical auctions — refuse hard delete; offer status=draft
		// as the equivalent "hide from listings" path.
		c.JSON(http.StatusBadRequest, gin.H{"error": "product has historical auctions; set status to 'draft' to hide instead"})
		return
	}

	if err := h.db.Delete(&product).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete"})
		return
	}
	c.Status(http.StatusNoContent)
}
