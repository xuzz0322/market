package services

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"time"
)

func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("{}")
	}
	return data
}

// generateOrderNo produces a human-friendly business order code.
//
// Shape: AC + yyyyMMddHHmmss + 6-digit random
//   e.g. AC20240526143012849273
//
// Why not a UUID: order numbers show up in customer-service chats and
// shipping labels — humans need to read them out loud. The timestamp
// prefix doubles as an at-a-glance creation time and makes ID-based
// sorting roughly chronological.
//
// The 6-digit suffix uses crypto/rand so concurrent end-of-auction
// calls in the same millisecond don't collide. Birthday-paradox math:
// at our scale (single-digit orders/sec) collisions are vanishingly rare,
// and the DB uniqueIndex would catch any that slip through (caller can retry).
func generateOrderNo() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		// Fallback: nano-timestamp; still unique enough not to break.
		return fmt.Sprintf("AC%s%06d", time.Now().Format("20060102150405"), time.Now().Nanosecond()%1_000_000)
	}
	return fmt.Sprintf("AC%s%06d", time.Now().Format("20060102150405"), n.Int64())
}
