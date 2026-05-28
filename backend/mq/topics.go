package mq

// Topic constants. Centralised here so a typo in one file can't silently
// produce to one topic and consume from another.
const (
	// TopicNotifyOutbid carries "you've been outbid" events. Each message
	// is keyed by the displaced user_id so all their events are ordered
	// per-user (single partition per key in the default hash partitioner).
	// Consumer: WS push to affected user's connections.
	// At-most-once semantics are fine — a missed outbid toast is not
	// a money-loss event; the next bid_update broadcast already conveys
	// the new price.
	TopicNotifyOutbid = "notify.outbid"

	// TopicCreditAdjust carries deferred credit-score mutations. The DB
	// write (AdjustCredit) happens in the consumer, decoupled from the
	// primary order/cancel transaction. This means the primary tx commits
	// faster and the credit write can be retried independently if the
	// DB is briefly overloaded.
	// At-least-once (consumer re-reads on restart) is safe because
	// AdjustCredit is idempotent when run twice (score clamp + same
	// CreditEvent gets a new PK but the net effect on credit_score is
	// the same if the first write succeeded — we accept a tiny duplicate
	// log row, not a double credit-score change, because the clamp caps it).
	TopicCreditAdjust = "credit.adjust"

	// TopicHeatIncr carries heat-signal increments (bids, likes) from
	// the hot request path to the Redis-writing consumer. Decouples the
	// API handler from Redis latency; a Redis hiccup only delays the heat
	// update, not the bid response.
	// At-most-once is fine — heat is a best-effort metric.
	TopicHeatIncr = "heat.incr"

	// TopicDM carries private messages from the send-handler to the
	// fan-out consumer. The consumer writes to MySQL (durable) and
	// pushes the WS notification. At-least-once: a duplicate push in
	// the unlikely consumer-restart scenario is harmless (user sees the
	// same message twice, client deduplicates by message ID).
	TopicDM = "dm.send"
)
