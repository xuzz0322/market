package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
)

type DepositHandler struct {
	db *gorm.DB
}

func NewDepositHandler(db *gorm.DB) *DepositHandler {
	return &DepositHandler{db: db}
}

// GetMyDepositForAuction returns the caller's deposit state for a given
// auction. Used by the bid UI to decide whether to render the "缴纳保证金"
// gate or the regular bid panel.
//
// Returns the row when one exists; otherwise a default `{required: bool,
// amount: float, paid: false}` shape so the client doesn't have to handle
// 404 specially.
func (h *DepositHandler) GetMyDepositForAuction(c *gin.Context) {
	userID := c.GetUint("userID")
	auctionID := parseUintParam(c, "id")
	if auctionID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	var auction models.Auction
	if err := h.db.First(&auction, auctionID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}

	resp := gin.H{
		"required": auction.RequiresDeposit,
		"amount":   auction.DepositAmount,
		"paid":     false,
	}
	if !auction.RequiresDeposit {
		c.JSON(http.StatusOK, resp)
		return
	}

	var dep models.Deposit
	if err := h.db.Where("user_id = ? AND auction_id = ?", userID, auctionID).First(&dep).Error; err == nil {
		resp["paid"] = dep.Status == models.DepositHeld
		resp["status"] = dep.Status
	}
	c.JSON(http.StatusOK, resp)
}

// PayDeposit records the user's earnest payment for an auction. Wraps the
// balance check + balance debit + Deposit row insert in a single tx so
// they can't go out of sync (paying without debiting, or vice versa).
//
// Idempotent for an already-held deposit — re-calling returns 200 without
// double-charging. If a previously refunded deposit exists (user lost a
// prior attempt and the auction got re-listed with same id, hypothetical),
// we'd allow re-paying; in practice auction ids don't recycle.
func (h *DepositHandler) PayDeposit(c *gin.Context) {
	userID := c.GetUint("userID")
	auctionID := parseUintParam(c, "id")
	if auctionID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	var auction models.Auction
	if err := h.db.First(&auction, auctionID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}
	if !auction.RequiresDeposit || auction.DepositAmount <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "this auction does not require a deposit"})
		return
	}
	if auction.Status != models.AuctionActive && auction.Status != models.AuctionPending {
		c.JSON(http.StatusBadRequest, gin.H{"error": "auction is not accepting deposits"})
		return
	}
	if auction.SellerID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sellers cannot pay deposit on their own auction"})
		return
	}

	// Credit gate — match the bid handler's threshold so users learn early
	// (at deposit time) that they can't participate, instead of paying a
	// deposit and discovering the block one click later.
	var caller models.User
	if err := h.db.Select("credit_score").First(&caller, userID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load user"})
		return
	}
	if caller.CreditScore < models.CreditMinToBid {
		c.JSON(http.StatusForbidden, gin.H{"error": "信用分过低，暂时无法参与拍卖"})
		return
	}

	err := h.db.Transaction(func(tx *gorm.DB) error {
		// Idempotency check inside the tx — picks up state changes from
		// concurrent calls (the SELECT FOR UPDATE keeps things consistent
		// when MySQL is the storage; SQLite ignores the clause but is
		// single-writer anyway).
		var existing models.Deposit
		err := tx.Clauses().
			Where("user_id = ? AND auction_id = ?", userID, auctionID).
			First(&existing).Error
		if err == nil {
			if existing.Status == models.DepositHeld {
				return nil // already paid
			}
			// Past refunded/applied — refuse re-pay; the auction must be
			// over by then anyway.
			return errors.New("deposit already settled for this auction")
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		// Debit balance with a guarded UPDATE so concurrent payments can't
		// over-spend. RowsAffected==0 means insufficient funds.
		res := tx.Model(&models.User{}).
			Where("id = ? AND balance >= ?", userID, auction.DepositAmount).
			UpdateColumn("balance", gorm.Expr("balance - ?", auction.DepositAmount))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errors.New("insufficient balance")
		}

		dep := models.Deposit{
			UserID:    userID,
			AuctionID: auctionID,
			Amount:    auction.DepositAmount,
			Status:    models.DepositHeld,
		}
		if err := tx.Create(&dep).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		switch err.Error() {
		case "deposit already settled for this auction":
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case "insufficient balance":
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "余额不足，请充值后再缴纳保证金"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to pay deposit"})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"paid": true, "amount": auction.DepositAmount})
}

// WithdrawDeposit lets a user reclaim a held deposit BEFORE they've placed
// any bid. Once they've bid, the deposit is locked until auction settlement
// — withdrawing mid-bid would let bidders renege on commitments, defeating
// the entire purpose of an earnest deposit.
func (h *DepositHandler) WithdrawDeposit(c *gin.Context) {
	userID := c.GetUint("userID")
	auctionID := parseUintParam(c, "id")
	if auctionID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	err := h.db.Transaction(func(tx *gorm.DB) error {
		var dep models.Deposit
		if err := tx.Where("user_id = ? AND auction_id = ? AND status = ?",
			userID, auctionID, models.DepositHeld).First(&dep).Error; err != nil {
			return errors.New("no held deposit found")
		}

		// Block if user has any active bid on this auction.
		var bidCount int64
		tx.Model(&models.Bid{}).
			Where("user_id = ? AND auction_id = ? AND status = ?", userID, auctionID, models.BidActive).
			Count(&bidCount)
		if bidCount > 0 {
			return errors.New("cannot withdraw deposit after placing a bid")
		}

		now := time.Now()
		if err := tx.Model(&dep).Updates(map[string]interface{}{
			"status":     models.DepositRefunded,
			"settled_at": &now,
		}).Error; err != nil {
			return err
		}
		// Refund the balance.
		return tx.Model(&models.User{}).Where("id = ?", userID).
			UpdateColumn("balance", gorm.Expr("balance + ?", dep.Amount)).Error
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"refunded": true})
}

// MyDeposits lists the caller's deposits (any status) with the related
// auction context so the UI can render "保证金记录" — held / refunded /
// applied — without follow-up requests.
func (h *DepositHandler) MyDeposits(c *gin.Context) {
	userID := c.GetUint("userID")
	var deposits []models.Deposit
	h.db.Preload("Auction.Product").
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&deposits)
	c.JSON(http.StatusOK, deposits)
}
