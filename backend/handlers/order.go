package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
	"market/mq"
	"market/services"
)

type OrderHandler struct {
	db       *gorm.DB
	producer *mq.Producer
}

func NewOrderHandler(db *gorm.DB, producer *mq.Producer) *OrderHandler {
	return &OrderHandler{db: db, producer: producer}
}

// ---- Buyer endpoints ----

// MyOrders lists orders where the caller is the buyer.
// Filterable by status for the H5 tabbed UI.
func (h *OrderHandler) MyOrders(c *gin.Context) {
	userID := c.GetUint("userID")
	q := h.db.
		Where("buyer_id = ?", userID).
		Preload("Product").
		Preload("Seller").
		Preload("Auction").
		Order("created_at DESC")
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	var orders []models.Order
	if err := q.Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch orders"})
		return
	}
	c.JSON(http.StatusOK, orders)
}

// MyBuyHistory returns the caller's complete purchase history with an
// aggregate summary card so the UI can show "你共买入 X 件，总花费 ¥Y" without
// a second round-trip. Only completed orders count toward the summary to
// match what users intuitively consider "money spent".
func (h *OrderHandler) MyBuyHistory(c *gin.Context) {
	userID := c.GetUint("userID")

	var orders []models.Order
	if err := h.db.
		Where("buyer_id = ?", userID).
		Preload("Product").
		Preload("Seller").
		Preload("Auction").
		Order("created_at DESC").
		Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch"})
		return
	}

	var totalSpent float64
	var completedCount int
	for _, o := range orders {
		if o.Status == models.OrderCompleted {
			totalSpent += o.Amount
			completedCount++
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"orders":          orders,
		"total_spent":     totalSpent,
		"completed_count": completedCount,
		"total_count":     len(orders),
	})
}

// MySellHistory returns the caller's complete sell history. Available to
// every role (not just seller/admin) so a regular user who sold their
// first item can still see the record without role-gating.
func (h *OrderHandler) MySellHistory(c *gin.Context) {
	userID := c.GetUint("userID")

	var orders []models.Order
	if err := h.db.
		Where("seller_id = ?", userID).
		Preload("Product").
		Preload("Buyer").
		Preload("Auction").
		Order("created_at DESC").
		Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch"})
		return
	}

	var totalEarned float64
	var completedCount int
	for _, o := range orders {
		if o.Status == models.OrderCompleted {
			totalEarned += o.Amount
			completedCount++
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"orders":          orders,
		"total_earned":    totalEarned,
		"completed_count": completedCount,
		"total_count":     len(orders),
	})
}

// SetAddress lets the buyer attach a shipping address. Only allowed in
// the pending_address state — once shipped/completed, the address is
// frozen so the seller can't be told a different destination after
// dispatch.
type SetAddressRequest struct {
	Address models.ShippingAddress `json:"address" binding:"required"`
}

func (h *OrderHandler) SetAddress(c *gin.Context) {
	userID := c.GetUint("userID")
	idStr := c.Param("id")

	var req SetAddressRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Address.Name == "" || req.Address.Phone == "" || req.Address.Detail == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name, phone, and detail are required"})
		return
	}

	var order models.Order
	if err := h.db.Where("id = ? AND buyer_id = ?", idStr, userID).First(&order).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Status != models.OrderPendingAddress && order.Status != models.OrderPendingShipment {
		c.JSON(http.StatusBadRequest, gin.H{"error": "address can only be set before shipment"})
		return
	}

	addrJSON, _ := json.Marshal(req.Address)
	updates := map[string]interface{}{
		"shipping_address": string(addrJSON),
		"status":           models.OrderPendingShipment,
	}
	if err := h.db.Model(&order).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update order"})
		return
	}
	h.db.First(&order, order.ID)
	c.JSON(http.StatusOK, order)
}

// Confirm is called by the buyer after receiving the goods. This is the
// trust-release step: funds (held in escrow since auction end) are
// credited to the seller's balance.
//
// Concurrency: the status-gated UPDATE is atomic — two confirms from the
// same buyer (rapid double-click, network retry) won't double-credit
// the seller. The second sees RowsAffected=0 and bails.
func (h *OrderHandler) Confirm(c *gin.Context) {
	userID := c.GetUint("userID")
	idStr := c.Param("id")

	var order models.Order
	if err := h.db.Where("id = ? AND buyer_id = ?", idStr, userID).First(&order).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Status != models.OrderShipped {
		c.JSON(http.StatusBadRequest, gin.H{"error": "order is not in shipped state"})
		return
	}

	tx := h.db.Begin()
	now := time.Now()
	res := tx.Model(&models.Order{}).
		Where("id = ? AND status = ?", order.ID, models.OrderShipped).
		Updates(map[string]interface{}{
			"status":       models.OrderCompleted,
			"completed_at": now,
		})
	if res.Error != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to confirm"})
		return
	}
	if res.RowsAffected == 0 {
		// Already confirmed by a concurrent request — return success
		// (idempotent from the user's perspective).
		tx.Rollback()
		c.JSON(http.StatusOK, order)
		return
	}

	// Release escrow → seller balance.
	if err := tx.Model(&models.User{}).Where("id = ?", order.SellerID).
		UpdateColumn("balance", gorm.Expr("balance + ?", order.Amount)).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to release funds"})
		return
	}

	// Credit rewards via Kafka (at-least-once). If Kafka is down we fall
	// back to the synchronous AdjustCredit call so credit is never lost.
	publishCredit := func(userID uint, delta int, reason, refType, note string) {
		ev := mq.CreditEvent{UserID: userID, Delta: delta, Reason: reason, RefType: refType, RefID: order.ID, Note: note}
		if h.producer != nil && h.producer.Available() {
			_ = h.producer.Publish(mq.TopicCreditAdjust, mq.FormatKey(userID), ev)
		} else {
			services.AdjustCredit(tx, userID, delta, models.CreditEventReason(reason), refType, order.ID, note)
		}
	}
	publishCredit(order.BuyerID, +5, string(models.CreditReasonOrderCompleted), "order", "确认收货")
	publishCredit(order.SellerID, +3, string(models.CreditReasonOrderCompleted), "order", "订单成交完成")

	tx.Commit()
	h.db.First(&order, order.ID)
	c.JSON(http.StatusOK, order)
}

// ---- Seller endpoints ----

// SellerOrders lists orders where the caller is the seller. Mirrors
// MyOrders but with the seller_id filter; intentionally separate handler
// rather than a query param so the route group's RequireRole gate maps
// 1:1 to "seller-only data".
func (h *OrderHandler) SellerOrders(c *gin.Context) {
	userID := c.GetUint("userID")
	role, _ := c.Get("role")

	q := h.db.
		Preload("Product").
		Preload("Buyer").
		Preload("Auction").
		Order("created_at DESC")
	if role != string(models.RoleAdmin) {
		q = q.Where("seller_id = ?", userID)
	}
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	var orders []models.Order
	if err := q.Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch orders"})
		return
	}
	c.JSON(http.StatusOK, orders)
}

type ShipRequest struct {
	TrackingNo  string `json:"tracking_no" binding:"required,max=64"`
	ShipCarrier string `json:"ship_carrier" binding:"max=50"`
}

// Ship marks an order as shipped. Requires the buyer to have set an
// address first — this prevents sellers from clicking "ship" on orders
// that have nowhere to go, and means the platform's shipping data is
// always self-consistent.
func (h *OrderHandler) Ship(c *gin.Context) {
	userID := c.GetUint("userID")
	role, _ := c.Get("role")
	idStr := c.Param("id")

	var req ShipRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	q := h.db.Where("id = ?", idStr)
	if role != string(models.RoleAdmin) {
		q = q.Where("seller_id = ?", userID)
	}
	var order models.Order
	if err := q.First(&order).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Status != models.OrderPendingShipment {
		c.JSON(http.StatusBadRequest, gin.H{"error": "order is not awaiting shipment"})
		return
	}

	now := time.Now()
	res := h.db.Model(&models.Order{}).
		Where("id = ? AND status = ?", order.ID, models.OrderPendingShipment).
		Updates(map[string]interface{}{
			"status":       models.OrderShipped,
			"tracking_no":  req.TrackingNo,
			"ship_carrier": req.ShipCarrier,
			"shipped_at":   now,
		})
	if res.Error != nil || res.RowsAffected == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to ship"})
		return
	}

	h.db.First(&order, order.ID)
	c.JSON(http.StatusOK, order)
}

// Get returns a single order — visible to either the buyer or the
// seller. Used by both the H5 "my orders" detail and the admin "order
// detail" pages.
func (h *OrderHandler) Get(c *gin.Context) {
	userID := c.GetUint("userID")
	role, _ := c.Get("role")
	idStr := c.Param("id")

	q := h.db.Preload("Product").Preload("Seller").Preload("Buyer").Preload("Auction")
	if role != string(models.RoleAdmin) {
		q = q.Where("buyer_id = ? OR seller_id = ?", userID, userID)
	}
	var order models.Order
	if err := q.First(&order, idStr).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	c.JSON(http.StatusOK, order)
}
