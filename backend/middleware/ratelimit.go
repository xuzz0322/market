package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// tokenBucket is a simple per-key rate limiter.
//
// Why token bucket rather than fixed-window:
//   - Smooths out burst traffic without rejecting legit clients on the
//     boundary between windows.
//   - For bid traffic, we want to allow short bursts (user clicking
//     quickly to outbid) but cap sustained spam.
//
// Why in-memory (vs Redis):
//   - Single-instance deploy: trivial.
//   - Multi-instance: each pod limits independently, so the effective
//     limit is N × rate. Acceptable for now; swap to a Redis-backed
//     limiter (e.g., redis_rate) when horizontal scaling matters.
type tokenBucket struct {
	tokens    float64
	maxTokens float64
	refillPer float64 // tokens added per second
	lastSeen  time.Time
}

func (b *tokenBucket) take(now time.Time) bool {
	// Lazy refill: top up based on elapsed time since last call.
	// This avoids needing a goroutine per bucket.
	elapsed := now.Sub(b.lastSeen).Seconds()
	b.tokens += elapsed * b.refillPer
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}
	b.lastSeen = now

	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

type RateLimiter struct {
	mu        sync.Mutex
	buckets   map[uint]*tokenBucket
	maxTokens float64
	refillPer float64
	idleTTL   time.Duration
}

// NewRateLimiter creates a per-user rate limiter.
//   maxBurst: max requests in a burst (bucket capacity)
//   perSecond: sustained rate (tokens/sec refill)
//
// Example for bid endpoint: NewRateLimiter(5, 2)
//   = "burst of 5, then 2/sec sustained"
//   = a user can fire 5 quick bids, then is held to 2/sec
func NewRateLimiter(maxBurst float64, perSecond float64) *RateLimiter {
	rl := &RateLimiter{
		buckets:   make(map[uint]*tokenBucket),
		maxTokens: maxBurst,
		refillPer: perSecond,
		idleTTL:   10 * time.Minute,
	}
	// Periodic cleanup so the map doesn't grow unbounded across many users.
	go rl.gcLoop()
	return rl
}

func (rl *RateLimiter) gcLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for now := range ticker.C {
		rl.mu.Lock()
		for uid, b := range rl.buckets {
			if now.Sub(b.lastSeen) > rl.idleTTL {
				delete(rl.buckets, uid)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *RateLimiter) Allow(userID uint) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[userID]
	now := time.Now()
	if !ok {
		b = &tokenBucket{
			tokens:    rl.maxTokens,
			maxTokens: rl.maxTokens,
			refillPer: rl.refillPer,
			lastSeen:  now,
		}
		rl.buckets[userID] = b
	}
	return b.take(now)
}

// Middleware returns a gin handler that enforces the limit on the authenticated user.
// MUST run AFTER JWTAuth so userID is in context.
func (rl *RateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetUint("userID")
		if userID == 0 {
			c.Next()
			return
		}
		if !rl.Allow(userID) {
			c.Header("Retry-After", "1")
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error": "too many requests, please slow down",
			})
			c.Abort()
			return
		}
		c.Next()
	}
}
