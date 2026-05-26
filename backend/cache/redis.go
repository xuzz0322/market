package cache

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Client wraps go-redis with two key behaviors that the rest of the
// codebase relies on:
//
//  1. Optional / graceful degradation. If REDIS_HOST is empty or the
//     server is unreachable at startup, we DO NOT panic. Instead we run
//     in "disabled" mode where every Cmd returns immediately and callers
//     fall back to MySQL. This matters because the auction system has to
//     keep working even when Redis is down — we'd rather lose a bit of
//     read performance than refuse bids.
//
//  2. Health tracking. After a sequence of failed calls we mark the
//     client unhealthy and stop sending requests for a cooldown period.
//     This prevents a cascading failure where every request waits for a
//     redis dial timeout on each call.
//
// The "should I use redis right now?" decision is exposed via Available()
// and is sub-microsecond (atomic load) so it's safe to call from hot paths.
type Client struct {
	rdb     *redis.Client
	enabled bool

	// Health: failures (atomic counter) crossing failureThreshold flips
	// us into a cooldown window. After cooldown we let one request through
	// to probe; success resets the counter.
	failures   atomic.Int32
	disabled   atomic.Bool
	disableUntil atomic.Int64 // unix ms

	// instanceID is a process-unique marker stamped on every WS broadcast
	// so subscribers can drop their own publishes (avoid echo loops).
	instanceID string
}

const (
	failureThreshold = 5
	cooldownMs       = 30_000 // 30s circuit-breaker window
)

func New() *Client {
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		// Graceful: just return a disabled client. Caller's checks via
		// Available() will skip every redis path.
		log.Println("REDIS_HOST not set — cache disabled, falling back to MySQL only")
		return &Client{enabled: false, instanceID: makeInstanceID()}
	}
	port := envOr("REDIS_PORT", "6379")
	db, _ := strconv.Atoi(envOr("REDIS_DB", "0"))

	rdb := redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%s", host, port),
		Password:     os.Getenv("REDIS_PASSWORD"),
		DB:           db,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  500 * time.Millisecond,
		WriteTimeout: 500 * time.Millisecond,
		PoolSize:     30,
		MinIdleConns: 5,
	})

	// Probe at boot — if redis is unreachable we run disabled, but DON'T
	// block startup waiting for it. Production deploys frequently bring
	// redis up after the app pod, and we don't want to crashloop.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("Redis ping failed (%v) — starting in degraded mode, will retry on first call", err)
	} else {
		log.Printf("Redis connected: %s:%s", host, port)
	}

	return &Client{rdb: rdb, enabled: true, instanceID: makeInstanceID()}
}

// Raw exposes the underlying client. Most callers should use the typed
// helpers in this package; reach for Raw only when you need a command we
// haven't wrapped (and add a wrapper if it's hot-path).
func (c *Client) Raw() *redis.Client { return c.rdb }

func (c *Client) InstanceID() string { return c.instanceID }

// Available reports whether the cache is usable RIGHT NOW. It's atomic
// and cheap — call it on hot paths to gate redis usage.
func (c *Client) Available() bool {
	if !c.enabled {
		return false
	}
	if c.disabled.Load() {
		// Check if cooldown has elapsed; if so, allow a probe.
		if time.Now().UnixMilli() >= c.disableUntil.Load() {
			c.disabled.Store(false)
			c.failures.Store(0)
			return true
		}
		return false
	}
	return true
}

// trackError is called by wrappers after each command. After enough
// consecutive failures we open the circuit for cooldownMs.
func (c *Client) trackError(err error) {
	if err == nil {
		c.failures.Store(0)
		return
	}
	if err == redis.Nil {
		// "key not found" is not a system error; reset.
		c.failures.Store(0)
		return
	}
	if c.failures.Add(1) >= failureThreshold {
		c.disabled.Store(true)
		c.disableUntil.Store(time.Now().UnixMilli() + cooldownMs)
		log.Printf("Redis circuit OPEN for %dms after %d consecutive failures (last: %v)", cooldownMs, failureThreshold, err)
	}
}

// Do is a thin wrapper that does an availability check, runs the fn, and
// tracks the error. Callers use it like:
//
//	val, err := cache.Do(ctx, c, func(rdb *redis.Client) (string, error) {
//	    return rdb.Get(ctx, "foo").Result()
//	})
//
// On unavailable, returns (zero, ErrCacheUnavailable) — caller falls back.
func Do[T any](ctx context.Context, c *Client, fn func(*redis.Client) (T, error)) (T, error) {
	var zero T
	if !c.Available() {
		return zero, ErrCacheUnavailable
	}
	val, err := fn(c.rdb)
	c.trackError(err)
	if err != nil && err != redis.Nil {
		return zero, err
	}
	return val, err
}

// Exec is for fire-and-forget commands where the caller doesn't need a
// return value (e.g., ZADD, HMSET). Same semantics as Do.
func Exec(ctx context.Context, c *Client, fn func(*redis.Client) error) error {
	if !c.Available() {
		return ErrCacheUnavailable
	}
	err := fn(c.rdb)
	c.trackError(err)
	return err
}

// ErrCacheUnavailable is the sentinel that callers check to know "the
// cache isn't usable right now, do MySQL". We deliberately return this
// rather than nil so callers can't accidentally treat a cache miss as
// "no rankings exist".
var ErrCacheUnavailable = fmt.Errorf("cache unavailable")

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func makeInstanceID() string {
	hostname, _ := os.Hostname()
	return fmt.Sprintf("%s-%d", hostname, time.Now().UnixNano())
}
