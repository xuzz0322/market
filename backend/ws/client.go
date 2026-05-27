package ws

import (
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	// Bumped from 512 to 64KB to accommodate WebRTC SDP offers/answers.
	// A typical offer is 2-4KB; trickle ICE candidates are <1KB. The 10x
	// buffer below the read deadline is now superfluous given this size,
	// but kept for parity with previous behaviour.
	maxMessageSize = 64 * 1024
	// maxDropCount: kill the connection after this many consecutive
	// "channel full + drop-oldest still full" events. Indicates the client
	// is permanently stuck (TCP RWND collapsed or dead peer that hasn't
	// failed the ping yet).
	maxDropCount = 100
)

type Client struct {
	Hub    *Hub
	Conn   *websocket.Conn
	Send   chan []byte
	UserID uint
	// dropCount is incremented by Hub.deliver when an outbound message
	// must be dropped. WritePump reads it on each tick and force-closes
	// the conn if it crosses maxDropCount — this is the back-pressure
	// safety valve that prevents one slow client from accumulating
	// unbounded delivery attempts.
	dropCount atomic.Uint64
}

// ReadPump pumps messages from the WebSocket connection to the hub
func (c *Client) ReadPump(onMessage func(client *Client, msg *Message)) {
	defer func() {
		c.Hub.UnregisterClient(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error for user %d: %v", c.UserID, err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Invalid message from user %d: %v", c.UserID, err)
			continue
		}

		onMessage(c, &msg)
	}
}

// WritePump pumps messages from the hub to the WebSocket connection
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Flush queued messages
			n := len(c.Send)
			for i := 0; i < n; i++ {
				w.Write([]byte("\n"))
				w.Write(<-c.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			// Back-pressure circuit breaker: force-close clients that
			// have been chronically full. Without this, a stuck TCP peer
			// would keep being targeted by hub.deliver until ping timeout
			// (~60s), wasting hub CPU and memory.
			if c.dropCount.Load() > maxDropCount {
				log.Printf("Client user=%d dropped %d msgs, closing", c.UserID, c.dropCount.Load())
				return
			}

			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) SendMessage(msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case c.Send <- data:
	default:
	}
}
