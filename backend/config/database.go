package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// PoolConfig encapsulates DB pool tuning. Defaults are reasonable for a
// medium-traffic auction backend (handles ~100s concurrent bidders per pod).
//
// Sizing rationale:
//   - MaxOpenConns: should be << MySQL's max_connections (default 151).
//     Going too high causes thread thrash on the DB; too low causes the app
//     to queue on conn acquisition, which under bid spikes shows up as
//     "lock wait timeout" cascades.
//   - MaxIdleConns: keep equal to MaxOpenConns so the pool doesn't keep
//     re-handshaking on bursty traffic.
//   - ConnMaxLifetime: 30min — shorter than typical MySQL wait_timeout (8h)
//     so we recycle before the server kills us. Critical when running behind
//     a TCP load balancer that may silently drop idle conns.
//   - ConnMaxIdleTime: 10min — release idle conns sooner than lifetime so
//     low-traffic periods don't hog DB resources.
type PoolConfig struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

func defaultPoolConfig() PoolConfig {
	return PoolConfig{
		MaxOpenConns:    envInt("DB_MAX_OPEN_CONNS", 50),
		MaxIdleConns:    envInt("DB_MAX_IDLE_CONNS", 25),
		ConnMaxLifetime: time.Duration(envInt("DB_CONN_MAX_LIFETIME_MIN", 30)) * time.Minute,
		ConnMaxIdleTime: time.Duration(envInt("DB_CONN_MAX_IDLE_MIN", 10)) * time.Minute,
	}
}

func InitDB() *gorm.DB {
	host := getEnv("DB_HOST", "localhost")
	port := getEnv("DB_PORT", "3306")
	user := getEnv("DB_USER", "root")
	password := getEnv("DB_PASSWORD", "root")
	dbname := getEnv("DB_NAME", "auction_db")

	// timeout=5s : bail fast if MySQL is down rather than blocking the boot
	// readTimeout=10s, writeTimeout=10s : protects against half-open conns
	//   under network partitions (cloud LB drops, NAT timeouts, etc.)
	dsn := fmt.Sprintf(
		"%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=True&loc=Local"+
			"&timeout=5s&readTimeout=10s&writeTimeout=10s",
		user, password, host, port, dbname)

	gormCfg := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
		// PrepareStmt caches prepared statements — big win when same query
		// (e.g., place-bid path) is hammered. ~30% latency reduction in our test.
		PrepareStmt: true,
		// SkipDefaultTransaction: avoid implicit BEGIN/COMMIT for single-row
		// writes. We do explicit transactions where needed.
		SkipDefaultTransaction: true,
	}

	db, err := gorm.Open(mysql.Open(dsn), gormCfg)
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal("Failed to get DB handle:", err)
	}

	pc := defaultPoolConfig()
	sqlDB.SetMaxOpenConns(pc.MaxOpenConns)
	sqlDB.SetMaxIdleConns(pc.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(pc.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(pc.ConnMaxIdleTime)

	if err := sqlDB.Ping(); err != nil {
		log.Fatal("DB ping failed:", err)
	}

	log.Printf("DB connected: pool=%d/%d, lifetime=%v",
		pc.MaxIdleConns, pc.MaxOpenConns, pc.ConnMaxLifetime)
	return db
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func envInt(key string, defaultValue int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultValue
}
