package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"market/cache"
	"market/config"
	"market/handlers"
	"market/middleware"
	"market/models"
	"market/services"
	ws "market/ws"
)

func main() {
	db := config.InitDB()
	autoMigrate(db)

	// Redis. New() never panics — if REDIS_HOST is unset or the server
	// is unreachable, callers get ErrCacheUnavailable and fall back to
	// MySQL transparently.
	redisCli := cache.New()
	rankings := cache.NewRankingStore(redisCli)
	viewers := cache.NewViewerCounter(redisCli, db)

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	// Background flusher: drains Redis viewer counters into MySQL every
	// 30s. Final flush runs on rootCancel for graceful shutdown.
	viewers.StartFlusher(rootCtx)

	hub := ws.NewHub()

	// Cross-instance broadcast bridge. Wire it up BEFORE hub.Run() so any
	// startup-time broadcasts also reach other pods.
	bridge := cache.NewPubSubBridge(redisCli, func(env cache.BroadcastEnvelope) {
		// A broadcast arrived from another instance. Push it into our
		// local hub queue WITHOUT re-publishing (the originator already
		// did) — DispatchLocal is the no-republish path.
		hub.DispatchLocal(env.AuctionID, env.GlobalAll, env.Payload)
	})
	hub.SetRemotePublisher(func(auctionID uint, globalAll bool, payload []byte) {
		bridge.Publish(rootCtx, cache.BroadcastEnvelope{
			AuctionID: auctionID,
			GlobalAll: globalAll,
			Payload:   payload,
		})
	})
	bridge.Start(rootCtx)

	go hub.Run()

	auctionSvc := services.NewAuctionService(db, hub, rankings, viewers)
	go auctionSvc.StartAuctionMonitor()

	// Per-user rate limiters.
	// Bids: burst 5, sustained 3/s — matches realistic outbid behavior
	//   while filtering bots and double-click duplicates.
	// Generic API: burst 30, sustained 10/s — generous for legit clients,
	//   blocks scrapers.
	bidLimiter := middleware.NewRateLimiter(5, 3)
	apiLimiter := middleware.NewRateLimiter(30, 10)

	r := gin.New()
	r.Use(gin.Recovery(), gin.Logger())

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173", "http://localhost:3000"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Content-Type", "Authorization"},
		AllowCredentials: true,
	}))

	// Global request timeout: any handler that takes longer than 8s
	// gets its context cancelled. Saves the DB pool from being exhausted
	// by stuck handlers when the network is bad.
	r.Use(middleware.RequestTimeout(8 * time.Second))

	authH := handlers.NewAuthHandler(db)
	productH := handlers.NewProductHandler(db)
	auctionH := handlers.NewAuctionHandler(db, hub, auctionSvc)
	bidH := handlers.NewBidHandler(db, hub, auctionSvc)
	wsH := handlers.NewWSHandler(db, hub, auctionSvc, viewers)
	adminH := handlers.NewAdminHandler(db)
	orderH := handlers.NewOrderHandler(db)

	api := r.Group("/api")
	{
		api.POST("/register", authH.Register)
		api.POST("/login", authH.Login)

		auth := api.Group("", middleware.JWTAuth(), apiLimiter.Middleware())
		{
			auth.GET("/me", authH.GetMe)

			auth.POST("/products", productH.Create)
			auth.GET("/products", productH.List)
			auth.GET("/products/:id", productH.Get)
			auth.PATCH("/products/:id", productH.Update)
			auth.DELETE("/products/:id", productH.Delete)

			auth.POST("/auctions", auctionH.Create)
			auth.GET("/auctions", auctionH.List)
			auth.GET("/auctions/:id", auctionH.Get)
			auth.POST("/auctions/:id/start", auctionH.Start)
			auth.POST("/auctions/:id/cancel", auctionH.Cancel)

			// Bid endpoint gets a dedicated, tighter limiter.
			auth.POST("/auctions/:id/bids", bidLimiter.Middleware(), bidH.PlaceBid)
			auth.GET("/auctions/:id/bids", bidH.GetBids)

			// Buyer-side order endpoints. The seller-side counterparts
			// live under /admin/orders below since they require role.
			auth.GET("/orders", orderH.MyOrders)
			auth.GET("/orders/:id", orderH.Get)
			auth.POST("/orders/:id/address", orderH.SetAddress)
			auth.POST("/orders/:id/confirm", orderH.Confirm)
		}

		// Admin / merchant endpoints — gated by role middleware. The route
		// group's prefix doubles as a hint for any reverse-proxy ACLs we
		// want to layer on top (e.g., IP allowlist for /api/admin/*).
		admin := api.Group("/admin",
			middleware.JWTAuth(),
			middleware.RequireRole(string(models.RoleSeller), string(models.RoleAdmin)),
			apiLimiter.Middleware(),
		)
		{
			admin.GET("/stats/dashboard", adminH.Dashboard)
			admin.GET("/stats/top-products", adminH.TopProducts)
			admin.GET("/stats/recent-bids", adminH.RecentBids)
			admin.GET("/auctions/live", adminH.LiveAuctions)
			admin.GET("/auctions", adminH.AllAuctions)
			admin.GET("/products", adminH.AllProducts)

			// Seller-side order management
			admin.GET("/orders", orderH.SellerOrders)
			admin.GET("/orders/:id", orderH.Get)
			admin.POST("/orders/:id/ship", orderH.Ship)
		}
	}

	// WebSocket endpoint — no rate limit on the connection itself,
	// but the auth check still applies.
	r.GET("/ws", middleware.JWTAuth(), wsH.ServeWS)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second, // doesn't apply to hijacked WS conns
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown: drain in-flight HTTP requests and let WS clients
	// reconnect to a healthy pod. Without this, a rolling deploy mid-bid
	// would 502 the user's request even though their bid is half-committed.
	go func() {
		log.Printf("Server listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutdown signal received, draining...")

	// Cancel the root ctx so background workers (viewer flusher, pubsub
	// subscriber) stop accepting new work and do their final drains.
	rootCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("forced shutdown: %v", err)
	}
	log.Println("server stopped cleanly")
}

func autoMigrate(db *gorm.DB) {
	if err := db.AutoMigrate(
		&models.User{},
		&models.Product{},
		&models.Auction{},
		&models.Bid{},
		&models.Order{},
	); err != nil {
		log.Fatal("AutoMigrate failed:", err)
	}
	log.Println("Database migrated")
}
