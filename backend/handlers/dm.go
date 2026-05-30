package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/models"
	"market/mq"
)

type DMHandler struct {
	db       *gorm.DB
	producer *mq.Producer
}

func NewDMHandler(db *gorm.DB, producer *mq.Producer) *DMHandler {
	return &DMHandler{db: db, producer: producer}
}

type SendDMRequest struct {
	Body string `json:"body" binding:"required,min=1,max=2000"`
}

// Send saves a DM to MySQL and enqueues a Kafka event for the WS push.
// We write to DB first so:
//  1. The message is durable even if Kafka is down.
//  2. The MsgID is available to stamp on the Kafka event (dedup).
// The receiver sees the message in their inbox regardless of whether
// they're online, and gets a real-time push if they are.
func (h *DMHandler) Send(c *gin.Context) {
	senderID := c.GetUint("userID")
	receiverID := parseUintParam(c, "id")
	if receiverID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid receiver id"})
		return
	}
	if receiverID == senderID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot message yourself"})
		return
	}

	var req SendDMRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Check receiver exists and is not blocking the sender.
	var count int64
	h.db.Model(&models.Block{}).
		Where("blocker_id = ? AND blocked_id = ?", receiverID, senderID).
		Count(&count)
	if count > 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "cannot send message to this user"})
		return
	}

	msg := models.DirectMessage{
		SenderID:   senderID,
		ReceiverID: receiverID,
		Body:       req.Body,
	}
	if err := h.db.Create(&msg).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to send message"})
		return
	}

	// Kafka: async WS push. Falls back to silence if Kafka is down;
	// the receiver will see the message when they poll their inbox.
	_ = h.producer.Publish(mq.TopicDM, mq.FormatKey(receiverID), mq.DMEvent{
		SenderID:   senderID,
		ReceiverID: receiverID,
		Body:       req.Body,
		MsgID:      msg.ID,
	})

	h.db.Preload("Sender").First(&msg, msg.ID)
	c.JSON(http.StatusCreated, msg)
}

// Inbox returns the caller's conversation list — one row per unique
// peer, showing the latest message and unread count. Used to render
// the inbox list view without N+1 queries.
func (h *DMHandler) Inbox(c *gin.Context) {
	userID := c.GetUint("userID")
	type convo struct {
		PeerID      uint       `json:"peer_id"`
		Username    string     `json:"username"`
		Avatar      string     `json:"avatar"`
		LastBody    string     `json:"last_body"`
		LastAt      time.Time  `json:"last_at"`
		UnreadCount int        `json:"unread_count"`
	}
	rows := make([]convo, 0)
	// One row per peer: the last message (by ID) with this peer, plus
	// unread count. The subquery picks the max message id per peer pair
	// so we get the latest message without a separate round-trip.
	h.db.Raw(`
		SELECT
			peer_id,
			u.username,
			u.avatar,
			dm.body AS last_body,
			dm.created_at AS last_at,
			SUM(CASE WHEN dm.receiver_id = ? AND dm.read_at IS NULL THEN 1 ELSE 0 END) AS unread_count
		FROM (
			SELECT
				CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
				MAX(id) AS max_id
			FROM direct_messages
			WHERE (sender_id = ? OR receiver_id = ?)
			  AND deleted_at IS NULL
			GROUP BY peer_id
		) latest
		JOIN direct_messages dm ON dm.id = latest.max_id
		JOIN users u ON u.id = latest.peer_id
		GROUP BY latest.peer_id, u.username, u.avatar, dm.body, dm.created_at
		ORDER BY dm.created_at DESC
	`, userID, userID, userID, userID).Scan(&rows)
	c.JSON(http.StatusOK, rows)
}

// Thread returns the full message history between the caller and peer.
// Sorted ascending (oldest first) so the UI can render a chat bubble
// sequence without reversing. Marks messages as read in the same query.
func (h *DMHandler) Thread(c *gin.Context) {
	userID := c.GetUint("userID")
	peerID := parseUintParam(c, "id")
	if peerID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid peer id"})
		return
	}

	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	// Cursor-based paging: ?before=<message_id> for older messages.
	before, _ := strconv.ParseUint(c.Query("before"), 10, 64)

	query := h.db.Preload("Sender").
		Where("(sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)",
			userID, peerID, peerID, userID).
		Order("id DESC").
		Limit(limit)
	if before > 0 {
		query = query.Where("id < ?", before)
	}

	var msgs []models.DirectMessage
	query.Find(&msgs)

	// Mark unread messages FROM peer as read.
	now := time.Now()
	h.db.Model(&models.DirectMessage{}).
		Where("sender_id = ? AND receiver_id = ? AND read_at IS NULL", peerID, userID).
		Update("read_at", &now)

	// Return in ascending order (newest-first from DB, reversed here).
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	c.JSON(http.StatusOK, msgs)
}

// UnreadCount returns the total number of unread messages across all threads.
// Polled by the frontend badge on the messages icon.
func (h *DMHandler) UnreadCount(c *gin.Context) {
	userID := c.GetUint("userID")
	var count int64
	h.db.Model(&models.DirectMessage{}).
		Where("receiver_id = ? AND read_at IS NULL", userID).
		Count(&count)
	c.JSON(http.StatusOK, gin.H{"unread": count})
}
