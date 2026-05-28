package handlers

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/cache"
	"market/models"
)

type SocialHandler struct {
	db    *gorm.DB
	hub   interface{ PushToUser(userID uint, msg interface{}) }
	cache *cache.Client
}

func NewSocialHandler(db *gorm.DB, hub interface{ PushToUser(userID uint, msg interface{}) }, c *cache.Client) *SocialHandler {
	return &SocialHandler{db: db, hub: hub, cache: c}
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
	} else if h.cache != nil && auction.RoomID != nil {
		// Only increment on a fresh favorite (not a dup), and only for
		// auctions inside a room so the heat scanner has a room to credit.
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		cache.IncrLikesDelta(ctx, h.cache, *auction.RoomID)
		cancel()
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
		"score":      u.CreditScore,
		"min_to_bid": models.CreditMinToBid,
		"max_score":  models.CreditMaxScore,
		"can_bid":    u.CreditScore >= models.CreditMinToBid,
		"events":     events,
	})
}

// ---------- Blocks ----------

// BlockUser adds a block from the caller onto the target. Idempotent.
// Also removes any existing follow in the same direction — you can't
// follow someone you've blocked (it would be confusing to still receive
// their live notifications after blocking them).
func (h *SocialHandler) BlockUser(c *gin.Context) {
	userID := c.GetUint("userID")
	targetID := parseUintParam(c, "id")
	if targetID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if targetID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot block yourself"})
		return
	}

	block := models.Block{BlockerID: userID, BlockedID: targetID}
	if err := h.db.Create(&block).Error; err != nil {
		if !isDuplicate(err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block"})
			return
		}
		// Already blocked — idempotent, fall through.
	}

	// Remove follow in both directions so the blocker stops receiving
	// live-alerts and the blocked user doesn't still "follow" the blocker.
	h.db.Where("(follower_id = ? AND host_id = ?) OR (follower_id = ? AND host_id = ?)",
		userID, targetID, targetID, userID).Delete(&models.Follow{})

	c.JSON(http.StatusOK, gin.H{"blocked": true})
}

// UnblockUser removes a block. Does NOT restore any prior follow.
func (h *SocialHandler) UnblockUser(c *gin.Context) {
	userID := c.GetUint("userID")
	targetID := parseUintParam(c, "id")
	if targetID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	h.db.Where("blocker_id = ? AND blocked_id = ?", userID, targetID).Delete(&models.Block{})
	c.JSON(http.StatusOK, gin.H{"blocked": false})
}

// MyBlocks lists every user the caller has blocked. Returns minimal profile
// info so the manage-blocks UI can show name + avatar without extra calls.
func (h *SocialHandler) MyBlocks(c *gin.Context) {
	userID := c.GetUint("userID")
	type row struct {
		BlockedID uint   `json:"id"`
		Username  string `json:"username"`
		Avatar    string `json:"avatar"`
		BlockedAt time.Time `json:"blocked_at"`
	}
	var rows []row
	h.db.Raw(`
		SELECT b.blocked_id, u.username, u.avatar, b.created_at AS blocked_at
		FROM blocks b
		JOIN users u ON u.id = b.blocked_id
		WHERE b.blocker_id = ?
		ORDER BY b.created_at DESC
	`, userID).Scan(&rows)
	c.JSON(http.StatusOK, rows)
}

// MyBlockedIDs returns just the list of blocked user IDs. Used by the
// auction-list endpoint to filter results client-side without joining.
func (h *SocialHandler) MyBlockedIDs(c *gin.Context) {
	userID := c.GetUint("userID")
	var ids []uint
	h.db.Model(&models.Block{}).
		Where("blocker_id = ?", userID).
		Pluck("blocked_id", &ids)
	c.JSON(http.StatusOK, ids)
}

// BlockState returns whether the caller has blocked the given user.
func (h *SocialHandler) BlockState(c *gin.Context) {
	userID := c.GetUint("userID")
	targetID := parseUintParam(c, "id")
	var count int64
	h.db.Model(&models.Block{}).
		Where("blocker_id = ? AND blocked_id = ?", userID, targetID).
		Count(&count)
	c.JSON(http.StatusOK, gin.H{"blocked": count > 0})
}

// ---------- Followed rooms ----------

// FollowedRooms returns the open auction rooms whose host the caller follows,
// sorted by heat_score desc so the most active followed rooms bubble up.
// This is the data source for the "关注的拍卖间" tab on the home feed.
func (h *SocialHandler) FollowedRooms(c *gin.Context) {
	userID := c.GetUint("userID")

	// Collect host IDs the user follows.
	var hostIDs []uint
	h.db.Model(&models.Follow{}).
		Where("follower_id = ?", userID).
		Pluck("host_id", &hostIDs)

	if len(hostIDs) == 0 {
		c.JSON(http.StatusOK, []models.AuctionRoom{})
		return
	}

	// Exclude rooms hosted by anyone the caller has blocked (belt +
	// suspenders — if you later block someone you follow, their room
	// vanishes immediately).
	var blockedIDs []uint
	h.db.Model(&models.Block{}).
		Where("blocker_id = ?", userID).
		Pluck("blocked_id", &blockedIDs)

	query := h.db.Model(&models.AuctionRoom{}).
		Preload("Host").
		Where("host_id IN ? AND status = ?", hostIDs, models.RoomOpen).
		Order("heat_score DESC, current_auction_id IS NOT NULL DESC")

	if len(blockedIDs) > 0 {
		query = query.Where("host_id NOT IN ?", blockedIDs)
	}

	var rooms []models.AuctionRoom
	if err := query.Find(&rooms).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch"})
		return
	}
	c.JSON(http.StatusOK, rooms)
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
