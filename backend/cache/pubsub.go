package cache

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// PubSubBridge enables multi-instance WS broadcasts. Without it, when pod
// A receives a bid and broadcasts to its room, only the clients connected
// to A get the update — clients on pod B miss it.
//
// Design: every broadcast is published to a shared Redis channel with the
// originating instance ID. All pods subscribe; they re-emit to their local
// rooms but skip messages they sent themselves (echo prevention).
//
// We could have used Redis Streams (with persistence + consumer groups)
// but Pub/Sub is the right tradeoff here:
//   - Auctions are real-time; a 100ms-old bid update is useless. We don't
//     need replay.
//   - Pub/Sub is ~5x faster than Streams (no fsync, no consumer ack).
//   - If a pod is briefly disconnected from Redis, missed messages are
//     fine: the next bid carries fresh state and the seq-gap detector on
//     the client triggers a resync.
type PubSubBridge struct {
	c          *Client
	instanceID string
	// onRemote receives broadcasts originating from OTHER instances.
	// Local broadcasts call onRemote directly to avoid a Redis round-trip.
	onRemote func(envelope BroadcastEnvelope)
}

// BroadcastEnvelope is what we put on the wire. Originator + payload.
type BroadcastEnvelope struct {
	InstanceID string          `json:"instance_id"`
	AuctionID  uint            `json:"auction_id"`
	GlobalAll  bool            `json:"global_all,omitempty"`
	Payload    json.RawMessage `json:"payload"`
}

func NewPubSubBridge(c *Client, onRemote func(BroadcastEnvelope)) *PubSubBridge {
	return &PubSubBridge{c: c, instanceID: c.InstanceID(), onRemote: onRemote}
}

// Publish announces a broadcast to all instances. The local instance is
// expected to dispatch via its own hub directly (faster); Publish only
// targets remote instances.
func (b *PubSubBridge) Publish(ctx context.Context, env BroadcastEnvelope) {
	if !b.c.Available() {
		// Single-instance / Redis-down: callers still dispatch locally,
		// so the local clients see updates. Cross-pod fan-out is the
		// only thing we lose, and that's fine for a degraded mode.
		return
	}
	env.InstanceID = b.instanceID
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	// Fire-and-forget: this is fast (microseconds) and we don't want to
	// block the bid response on a Redis hiccup. Errors are tracked by
	// the client's circuit breaker.
	_ = Exec(ctx, b.c, func(rdb *redis.Client) error {
		return rdb.Publish(ctx, WSBroadcastChannel, data).Err()
	})
}

// Start subscribes to the broadcast channel and dispatches incoming
// envelopes to the registered onRemote callback. Runs forever; call once
// at boot.
//
// Resilience: redis.Subscribe auto-reconnects internally. On a clean shut-
// down (ctx cancelled) the loop exits.
func (b *PubSubBridge) Start(ctx context.Context) {
	if !b.c.Available() {
		log.Println("Pub/Sub bridge inactive (redis disabled) — single-instance mode")
		return
	}
	go func() {
		sub := b.c.rdb.Subscribe(ctx, WSBroadcastChannel)
		defer sub.Close()
		ch := sub.Channel()
		log.Printf("Pub/Sub bridge subscribed to %s (instance %s)", WSBroadcastChannel, b.instanceID)

		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var env BroadcastEnvelope
				if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
					continue
				}
				// Echo prevention: this envelope came from us, so we've
				// already dispatched locally. Skip.
				if env.InstanceID == b.instanceID {
					continue
				}
				b.onRemote(env)
			}
		}
	}()
}
