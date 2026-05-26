package handlers

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	gws "github.com/gorilla/websocket"
	"gorm.io/gorm"

	"market/cache"
	"market/models"
	"market/services"
	ws "market/ws"
)

var upgrader = gws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type WSHandler struct {
	db         *gorm.DB
	hub        *ws.Hub
	auctionSvc *services.AuctionService
	viewers    *cache.ViewerCounter
}

func NewWSHandler(db *gorm.DB, hub *ws.Hub, svc *services.AuctionService, viewers *cache.ViewerCounter) *WSHandler {
	return &WSHandler{db: db, hub: hub, auctionSvc: svc, viewers: viewers}
}

func (h *WSHandler) ServeWS(c *gin.Context) {
	userID := c.GetUint("userID")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	client := &ws.Client{
		Hub:    h.hub,
		Conn:   conn,
		Send:   make(chan []byte, 256),
		UserID: userID,
	}

	h.hub.RegisterClient(client)

	go client.WritePump()
	client.ReadPump(h.handleMessage)
}

func (h *WSHandler) handleMessage(client *ws.Client, msg *ws.Message) {
	switch msg.Type {
	case ws.MsgJoinAuction:
		h.handleJoinAuction(client, msg)
	case ws.MsgLeaveAuction:
		h.hub.LeaveRoom(client, msg.AuctionID)
	}
}

func (h *WSHandler) handleJoinAuction(client *ws.Client, msg *ws.Message) {
	if msg.AuctionID == 0 {
		return
	}
	h.hub.JoinRoom(client, msg.AuctionID)

	var auction models.Auction
	if err := h.db.Preload("Product.Seller").Preload("Seller").Preload("Winner").
		First(&auction, msg.AuctionID).Error; err != nil {
		return
	}

	// Increment viewer count via Redis (lock-free) instead of MySQL UPDATE
	// (row-lock contention on hot rows). The flusher periodically reconciles
	// the Redis delta back into MySQL so existing reports keep working.
	if h.viewers != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		h.viewers.Inc(ctx, msg.AuctionID)
		cancel()
	} else {
		// Redis disabled fallback — original MySQL path.
		h.db.Model(&auction).UpdateColumn("view_count", gorm.Expr("view_count + 1"))
	}

	// Send a personal snapshot — bypasses the room broadcast so newly-joined
	// clients get state immediately without disturbing existing viewers.
	// The seq advances, so this client's "next expected seq" is now in sync
	// with the room's stream.
	h.auctionSvc.SendBidStateTo(client, &auction)
}
