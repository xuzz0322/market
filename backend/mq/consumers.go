package mq

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"gorm.io/gorm"

	"market/cache"
	"market/models"
)

// Consumers wires up all Kafka consumer groups and starts them.
// Returned runners must have their Start(ctx) called after construction.
type Consumers struct {
	Outbid    *Consumer
	Credit    *Consumer
	HeatIncr  *Consumer
	DM        *Consumer
}

// NewConsumers creates all consumer group instances. Pass nil for any
// dependency not available (e.g., when Kafka itself is disabled) — each
// consumer checks internally.
func NewConsumers(
	db *gorm.DB,
	hub wsHub,
	redisCli *cache.Client,
	_ interface{}, // auctionSvc reserved for future use; pass nil
) *Consumers {
	return &Consumers{
		Outbid:   NewConsumer(TopicNotifyOutbid, "auction.outbid", makeOutbidHandler(hub)),
		Credit:   NewConsumer(TopicCreditAdjust, "auction.credit", makeCreditHandler(db)),
		HeatIncr: NewConsumer(TopicHeatIncr, "auction.heat", makeHeatIncrHandler(redisCli)),
		DM:       NewConsumer(TopicDM, "auction.dm", makeDMHandler(db, hub)),
	}
}

// StartAll launches all consumers in background goroutines. Call after
// NewConsumers, before the HTTP server begins serving.
func (c *Consumers) StartAll(ctx context.Context) {
	c.Outbid.Start(ctx)
	c.Credit.Start(ctx)
	c.HeatIncr.Start(ctx)
	c.DM.Start(ctx)
}

// wsHub is the minimal Hub interface used by consumer handlers. Mirrors the
// ws.Hub method set we need, without importing the ws package at the top
// level (which could cause cycles if ws ever imports mq).
type wsHub interface {
	PushToUser(userID uint, msg interface{})
}

// ─── Handler factories ────────────────────────────────────────────────────────

func makeOutbidHandler(hub wsHub) ConsumerHandler {
	return func(ctx context.Context, key, value []byte) error {
		var ev OutbidEvent
		if err := Unmarshal(value, &ev); err != nil {
			return nil // bad payload — don't retry
		}
		hub.PushToUser(ev.DisplacedUID, map[string]interface{}{
			"type": "bid_outbid",
			"data": map[string]interface{}{
				"auction_id":    ev.AuctionID,
				"product_title": ev.ProductTitle,
				"your_bid":      ev.YourBid,
				"current_price": ev.NewPrice,
				"new_leader":    ev.NewLeader,
				"seconds_left":  ev.SecondsLeft,
			},
		})
		return nil
	}
}

func makeCreditHandler(db *gorm.DB) ConsumerHandler {
	return func(ctx context.Context, key, value []byte) error {
		var ev CreditEvent
		if err := Unmarshal(value, &ev); err != nil {
			return nil
		}
		// Inline the credit adjustment so mq doesn't import services.
		// Logic mirrors services.AdjustCredit: SELECT FOR UPDATE → clamp → UPDATE → log row.
		err := db.Transaction(func(tx *gorm.DB) error {
			var u models.User
			if err := tx.Set("gorm:query_option", "FOR UPDATE").
				Select("id, credit_score").
				First(&u, ev.UserID).Error; err != nil {
				return err
			}
			newScore := u.CreditScore + ev.Delta
			if newScore < 0 {
				newScore = 0
			}
			if newScore > models.CreditMaxScore {
				newScore = models.CreditMaxScore
			}
			if err := tx.Model(&models.User{}).Where("id = ?", ev.UserID).
				Update("credit_score", newScore).Error; err != nil {
				return err
			}
			now := time.Now()
			return tx.Create(&models.CreditEvent{
				UserID:    ev.UserID,
				Delta:     ev.Delta,
				After:     newScore,
				Reason:    models.CreditEventReason(ev.Reason),
				RefType:   ev.RefType,
				RefID:     ev.RefID,
				Note:      ev.Note,
				CreatedAt: now,
			}).Error
		})
		if err != nil {
			log.Printf("credit consumer user=%d delta=%d: %v", ev.UserID, ev.Delta, err)
		}
		return nil // always ack — credit is best-effort from caller's perspective
	}
}

func makeHeatIncrHandler(redisCli *cache.Client) ConsumerHandler {
	return func(ctx context.Context, key, value []byte) error {
		var ev HeatIncrEvent
		if err := Unmarshal(value, &ev); err != nil {
			return nil
		}
		bCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		defer cancel()
		switch ev.Kind {
		case "bid":
			cache.IncrBidDelta(bCtx, redisCli, ev.AuctionID)
		case "like":
			cache.IncrLikesDelta(bCtx, redisCli, ev.RoomID)
		}
		return nil
	}
}

func makeDMHandler(db *gorm.DB, hub wsHub) ConsumerHandler {
	return func(ctx context.Context, key, value []byte) error {
		var ev DMEvent
		if err := Unmarshal(value, &ev); err != nil {
			return nil
		}
		// Load the sender name for the WS push.
		var sender models.User
		if err := db.Select("id, username, avatar").First(&sender, ev.SenderID).Error; err != nil {
			log.Printf("DM consumer: sender %d not found: %v", ev.SenderID, err)
			return nil
		}
		// Push to receiver's active connections. Best-effort — if they're
		// offline they'll read from the DB inbox on next open.
		hub.PushToUser(ev.ReceiverID, map[string]interface{}{
			"type": "dm_received",
			"data": map[string]interface{}{
				"msg_id":      ev.MsgID,
				"sender_id":   ev.SenderID,
				"sender_name": sender.Username,
				"body":        ev.Body,
				"created_at":  time.Now().Format(time.RFC3339),
			},
		})
		return nil
	}
}

// ─── Outbid helpers shared by caller ─────────────────────────────────────────

// FormatKey produces a consistent partition key for a user-targeted event.
func FormatKey(userID uint) string {
	return strconv.FormatUint(uint64(userID), 10)
}

// FormatAuctionKey produces an auction-scoped partition key.
func FormatAuctionKey(auctionID uint) string {
	return fmt.Sprintf("auction:%d", auctionID)
}
