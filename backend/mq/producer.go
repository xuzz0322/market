package mq

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"

	"github.com/IBM/sarama"
)

// Producer is a thin synchronous-produce wrapper around sarama. We use sync
// because our message sizes are tiny (<1KB) and our produce rate is low
// (order of hundreds/sec at peak); the latency hit from sync ack is
// negligible, and it gives us clear back-pressure when Kafka is overloaded.
//
// For at-most-once topics we could use AsyncProducer, but the simpler sync
// API covers all our topics without extra goroutine management.
type Producer struct {
	p   sarama.SyncProducer
	ok  bool // false when KAFKA_BROKERS is unset — degrade silently
}

// NewProducer reads KAFKA_BROKERS (comma-separated) and returns a producer.
// If the env var is absent or Kafka is unreachable, returns a no-op producer
// so the app starts without Kafka (useful for local dev without docker).
func NewProducer() *Producer {
	brokers := brokerList()
	if len(brokers) == 0 {
		log.Println("KAFKA_BROKERS not set — Kafka producer disabled, falling back to in-process")
		return &Producer{}
	}

	cfg := sarama.NewConfig()
	cfg.Producer.Return.Successes = true
	cfg.Producer.RequiredAcks = sarama.WaitForLocal // ack from leader only
	cfg.Producer.Compression = sarama.CompressionSnappy
	cfg.Producer.Retry.Max = 3
	cfg.Producer.Retry.Backoff = 100 * time.Millisecond
	cfg.Net.DialTimeout = 5 * time.Second

	p, err := sarama.NewSyncProducer(brokers, cfg)
	if err != nil {
		log.Printf("Kafka producer init failed (%v) — running without Kafka", err)
		return &Producer{}
	}
	log.Printf("Kafka producer connected: %v", brokers)
	return &Producer{p: p, ok: true}
}

// Publish encodes v as JSON and produces to topic. Silently drops if Kafka
// is disabled. key is optional — if empty, Kafka assigns a partition.
func (p *Producer) Publish(topic, key string, v interface{}) error {
	if !p.ok {
		return nil // degraded mode: caller falls back inline
	}
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	msg := &sarama.ProducerMessage{
		Topic: topic,
		Value: sarama.ByteEncoder(payload),
	}
	if key != "" {
		msg.Key = sarama.StringEncoder(key)
	}
	_, _, err = p.p.SendMessage(msg)
	return err
}

// Available reports whether the producer is connected to Kafka.
func (p *Producer) Available() bool { return p.ok }

// Close shuts down the producer cleanly. Call on graceful shutdown.
func (p *Producer) Close() {
	if p.ok {
		_ = p.p.Close()
	}
}

func brokerList() []string {
	v := os.Getenv("KAFKA_BROKERS")
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, b := range parts {
		if s := strings.TrimSpace(b); s != "" {
			out = append(out, s)
		}
	}
	return out
}
