package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// RequestTimeout wraps each request in a context with the given timeout.
//
// Why this matters under network jitter:
//   - A downstream call (DB, external API) that hangs without this timeout
//     keeps the goroutine, the DB conn, and any locks held until the client
//     gives up — minutes, in pathological cases.
//   - With it, gorm sees ctx.Done() and aborts the query, returning the
//     conn to the pool quickly so the next request can succeed.
//
// We use http.StatusServiceUnavailable instead of 504 so retry-aware
// clients (and L7 load balancers) treat it as transient.
func RequestTimeout(d time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Skip WebSocket upgrades — they're long-lived by design and
		// must not be killed by a per-request timeout.
		if c.GetHeader("Upgrade") == "websocket" {
			c.Next()
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), d)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)

		done := make(chan struct{})
		go func() {
			defer close(done)
			c.Next()
		}()

		select {
		case <-done:
			return
		case <-ctx.Done():
			// Handler is still running but exceeded the budget.
			// We've already cancelled its ctx; if the handler respects it
			// (DB calls do, when using c.Request.Context()), it'll exit
			// shortly. We return 503 to the client either way — the
			// handler's eventual write will be a no-op once the response
			// is committed.
			if !c.Writer.Written() {
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
					"error": "request timeout, please retry",
				})
			}
			<-done // drain the goroutine
		}
	}
}
