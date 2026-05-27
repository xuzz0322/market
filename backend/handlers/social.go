package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
)

type SocialHandler struct {
	db  *gorm.DB
	hub interface {
		PushToUser(userID uint, msg interface{})
	}
}

func NewSocialHandler(db *gorm.DB, hub interface {
	PushToUser(userID uint, msg interface{})
}) *SocialHandler {
	return &SocialHandler{db: db, hub: hub}
}

// ---------- Favorites ----------

// FavoriteAuction stars an auction for the calling user. Idempotent — a
// duplicate INSERT triggers a unique-key violation which we swallow as
// success (the user wanted the row to exist, and now it does).
func (h *SocialHandler) FavoriteAuction(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")

	var auction models.Auction
	if err := h.db.First(&auction, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auction not found"})
		return
	}

	fav := models.Favorite{UserID: userID, AuctionID: auction.ID}
	if err := h.db.Create(&fav).Error; err != nil {
		// Duplicate is fine — the desired post-state is "row exists" and
		// it does. Any other error gets surfaced.
		if !isDuplicate(err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to favorite"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"favorited": true})
}

// UnfavoriteAuction is a hard delete — favorites carry no historical
// significance, so soft-delete here would just clutter the table.
func (h *SocialHandler) UnfavoriteAuction(c *gin.Context) {
	userID := c.GetUint("userID")
	id := c.Param("id")
	h.db.Where("user_id = ? AND auction_id = ?", userID, id).Delete(&models.Favorite{})
	c.JSON(http.StatusOK, gin.H{"favorited": false})
}

// MyFavorites returns the user's saved auctions, freshest first. Includes
// the basic auction + product info so the frontend can render cards
// without follow-up requests.
func (h *SocialHandler) MyFavorites(c *gin.Context) {
	userID := c.GetUint("userID")

	type row struct {
		models.Auction
		FavCreatedAt string `json:"favorited_at"`
	}

	var auctions []models.Auction
	h.db.
		Joins("JOIN favorites f ON f.auction_id = auctions.id").
		Where("f.user_id = ?", userID).
		Preload("Product").
		Preload("Seller").
		Order("f.created_at DESC").
		Find(&auctions)

	c.JSON(http.StatusOK, auctions)
}

// FavoriteIDs returns just the IDs of auctions the user has favorited. The
// frontend hits this once on session start to hydrate the heart-state cache,
// avoiding a per-card lookup when rendering the feed.
func (h *SocialHandler) FavoriteIDs(c *gin.Context) {
	userID := c.GetUint("userID")
	var ids []uint
	h.db.Model(&models.Favorite{}).
		Where("user_id = ?", userID).
		Pluck("auction_id", &ids)
	c.JSON(http.StatusOK, ids)
}

// ---------- Follows ----------

// Follow makes the caller a follower of the user identified by :id. Refuses
// self-follow because following yourself would just spam your own
// notifications.
func (h *SocialHandler) Follow(c *gin.Context) {
	userID := c.GetUint("userID")
	hostID := parseUintParam(c, "id")
	if hostID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if hostID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot follow yourself"})
		return
	}
	var host models.User
	if err := h.db.First(&host, hostID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	follow := models.Follow{FollowerID: userID, HostID: hostID}
	if err := h.db.Create(&follow).Error; err != nil {
		if !isDuplicate(err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to follow"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"following": true})
}

func (h *SocialHandler) Unfollow(c *gin.Context) {
	userID := c.GetUint("userID")
	hostID := parseUintParam(c, "id")
	if hostID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	h.db.Where("follower_id = ? AND host_id = ?", userID, hostID).Delete(&models.Follow{})
	c.JSON(http.StatusOK, gin.H{"following": false})
}

// MyFollows returns the list of hosts the caller follows. Each host is
// decorated with whether they're "live now" — a small extra query, but
// it lets the UI sort the list with active streamers first without a
// separate request.
func (h *SocialHandler) MyFollows(c *gin.Context) {
	userID := c.GetUint("userID")

	type hostRow struct {
		ID       uint   `json:"id"`
		Username string `json:"username"`
		Avatar   string `json:"avatar"`
		Live     bool   `json:"live"`
	}
	var rows []hostRow
	h.db.Raw(`
		SELECT u.id, u.username, u.avatar,
		       EXISTS(
		         SELECT 1 FROM auction_rooms r
		         WHERE r.host_id = u.id AND r.is_streaming = 1 AND r.deleted_at IS NULL
		       ) AS live
		FROM follows f
		JOIN users u ON f.host_id = u.id
		WHERE f.follower_id = ?
		ORDER BY live DESC, f.created_at DESC
	`, userID).Scan(&rows)

	c.JSON(http.StatusOK, rows)
}

// FollowState is a tiny endpoint for the host-profile UI: returns whether
// the caller follows the host plus follower count. One call, no extra
// state-syncing logic on the client.
func (h *SocialHandler) FollowState(c *gin.Context) {
	userID := c.GetUint("userID")
	hostID := parseUintParam(c, "id")
	if hostID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var following int64
	h.db.Model(&models.Follow{}).
		Where("follower_id = ? AND host_id = ?", userID, hostID).
		Count(&following)
	var followers int64
	h.db.Model(&models.Follow{}).Where("host_id = ?", hostID).Count(&followers)
	c.JSON(http.StatusOK, gin.H{
		"following":       following > 0,
		"follower_count":  followers,
	})
}

// ---------- Credit ----------

// MyCredit returns the caller's score, the participation threshold, and
// recent change log. Single endpoint — the UI for credit is small enough
// that a dedicated /history call would just be extra round-trips.
func (h *SocialHandler) MyCredit(c *gin.Context) {
	userID := c.GetUint("userID")
	var u models.User
	if err := h.db.Select("id, credit_score").First(&u, userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	var events []models.CreditEvent
	h.db.Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(50).
		Find(&events)
	c.JSON(http.StatusOK, gin.H{
		"score":         u.CreditScore,
		"min_to_bid":    models.CreditMinToBid,
		"max_score":     models.CreditMaxScore,
		"can_bid":       u.CreditScore >= models.CreditMinToBid,
		"events":        events,
	})
}

// ---------- Helpers ----------

func isDuplicate(err error) bool {
	// MySQL error 1062 — duplicate key. We don't want to import the mysql
	// driver here just to typecheck the code, so a substring match is
	// sufficient given GORM's wrapped errors. False-positives would only
	// cause a "duplicate" path to run on real errors, which is harmless
	// here because we're already using duplicate as the success path.
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	msg := err.Error()
	return contains(msg, "Duplicate") || contains(msg, "UNIQUE")
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
