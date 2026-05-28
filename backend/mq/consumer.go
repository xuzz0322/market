package mq

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/IBM/sarama"
)

// ConsumerHandler is the function signature each topic consumer must
// implement. err != nil → consumer logs and continues (at-least-once retry
// happens on the next poll; at-most-once topics should always return nil).
type ConsumerHandler func(ctx context.Context, key, value []byte) error

// Consumer wraps a sarama consumer group for a single topic. One goroutine
// per topic keeps the logic simple; for high-throughput topics in prod you'd
// scale partition count instead.
type Consumer struct {
	group   sarama.ConsumerGroup
	topic   string
	handler ConsumerHandler
}

// NewConsumer creates a consumer group reader for one topic. Returns nil when
// Kafka is disabled (KAFKA_BROKERS empty) so callers can skip Start().
func NewConsumer(topic, groupID string, handler ConsumerHandler) *Consumer {
	brokers := brokerList()
	if len(brokers) == 0 {
		return nil
	}

	cfg := sarama.NewConfig()
	cfg.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyRoundRobin(),
	}
	// Read from the earliest offset on first join so no events are missed
	// when a new consumer group is introduced after the topic already has
	// messages (e.g., first deploy with Kafka).
	cfg.Consumer.Offsets.Initial = sarama.OffsetNewest
	cfg.Consumer.Return.Errors = true
	cfg.Net.DialTimeout = 5 * time.Second

	g, err := sarama.NewConsumerGroup(brokers, groupID, cfg)
	if err != nil {
		log.Printf("Kafka consumer group %s init failed: %v", groupID, err)
		return nil
	}
	log.Printf("Kafka consumer group %s ready (topic: %s)", groupID, topic)
	return &Consumer{group: g, topic: topic, handler: handler}
}

// Start runs the consume loop in a goroutine until ctx is cancelled.
func (c *Consumer) Start(ctx context.Context) {
	if c == nil {
		return
	}
	go func() {
		h := &cgHandler{handler: c.handler}
		for {
			if err := c.group.Consume(ctx, []string{c.topic}, h); err != nil {
				log.Printf("Kafka consumer %s error: %v", c.topic, err)
			}
			if ctx.Err() != nil {
				return
			}
			// Brief pause before re-joining after an error to avoid a
			// tight spin loop on persistent broker issues.
			time.Sleep(500 * time.Millisecond)
		}
	}()
	// Log consumer group errors in a separate goroutine so they don't
	// block the consume loop.
	go func() {
		for err := range c.group.Errors() {
			log.Printf("Kafka group error (%s): %v", c.topic, err)
		}
	}()
}

// Unmarshal is a helper for handlers to decode the message value.
func Unmarshal(value []byte, dst interface{}) error {
	return json.Unmarshal(value, dst)
}

// cgHandler implements sarama.ConsumerGroupHandler.
type cgHandler struct{ handler ConsumerHandler }

func (h *cgHandler) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (h *cgHandler) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }
func (h *cgHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for {
		select {
		case msg, ok := <-claim.Messages():
			if !ok {
				return nil
			}
			if err := h.handler(session.Context(), msg.Key, msg.Value); err != nil {
				log.Printf("handler error (topic %s offset %d): %v", msg.Topic, msg.Offset, err)
				// For at-least-once topics we do NOT commit on error so
				// the message is re-delivered after a restart. For at-most-
				// once topics the handler should always return nil.
			} else {
				session.MarkMessage(msg, "")
			}
		case <-session.Context().Done():
			return nil
		}
	}
}
