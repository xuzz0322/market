package handlers

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

func mustMarshalBid(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

func parseUintParam(c *gin.Context, key string) uint {
	v, err := strconv.ParseUint(c.Param(key), 10, 64)
	if err != nil {
		return 0
	}
	return uint(v)
}

// contextWithTimeout derives a timeout-bounded ctx from gin's request context.
// Caller MUST defer cancel().
func contextWithTimeout(c *gin.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), d)
}
