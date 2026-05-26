import React, { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Auction } from '../types'
import { listAuctions } from '../services/api'
import wsClient from '../services/websocket'
import AuctionDetail from './AuctionDetail'

export default function AuctionFeed() {
  const [auctions, setAuctions] = useState<Auction[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const touchStartY = useRef(0)
  const isScrolling = useRef(false)

  const loadAuctions = useCallback(async () => {
    try {
      const data = await listAuctions({ status: 'active' })
      setAuctions(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAuctions()

    // Listen for new auctions broadcast
    const unsub = wsClient.on('auction_start', () => {
      loadAuctions()
    })
    return unsub
  }, [loadAuctions])

  const goNext = useCallback(() => {
    if (currentIndex < auctions.length - 1) {
      setCurrentIndex((i) => i + 1)
    }
  }, [currentIndex, auctions.length])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1)
    }
  }, [currentIndex])

  // Touch swipe handling
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isScrolling.current) return
    const diff = touchStartY.current - e.changedTouches[0].clientY
    if (Math.abs(diff) > 50) {
      isScrolling.current = true
      if (diff > 0) goNext()
      else goPrev()
      setTimeout(() => { isScrolling.current = false }, 600)
    }
  }

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') goNext()
      if (e.key === 'ArrowUp') goPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev])

  // Mouse wheel navigation
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (isScrolling.current) return
      isScrolling.current = true
      if (e.deltaY > 0) goNext()
      else goPrev()
      setTimeout(() => { isScrolling.current = false }, 700)
    }
    const el = feedRef.current
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => el?.removeEventListener('wheel', onWheel)
  }, [goNext, goPrev])

  if (loading) {
    return (
      <div className="h-screen bg-black flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        <p className="text-white/60 text-sm">加载拍卖中...</p>
      </div>
    )
  }

  if (auctions.length === 0) {
    return (
      <div className="h-screen bg-black flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="text-6xl">🎪</div>
        <h2 className="text-white text-xl font-bold">暂无进行中的拍卖</h2>
        <p className="text-white/50 text-sm">去发布一个商品并开始拍卖吧！</p>
      </div>
    )
  }

  return (
    <div
      ref={feedRef}
      className="h-screen bg-black overflow-hidden relative"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Feed items */}
      <div
        className="h-full transition-transform duration-500 ease-in-out"
        style={{ transform: `translateY(-${currentIndex * 100}%)` }}
      >
        {auctions.map((auction, idx) => (
          <div key={auction.id} className="h-screen w-full relative">
            <FeedCard
              auction={auction}
              isActive={idx === currentIndex}
              onOpen={() => setSelectedId(auction.id)}
            />
          </div>
        ))}
      </div>

      {/* Progress dots */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-30">
        {auctions.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrentIndex(i)}
            className={`w-1 rounded-full transition-all ${i === currentIndex ? 'h-6 bg-white' : 'h-1.5 bg-white/40'}`}
          />
        ))}
      </div>

      {/* Detail overlay */}
      <AnimatePresence>
        {selectedId !== null && (
          <motion.div
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 200 }}
            className="absolute inset-0 z-50"
          >
            <AuctionDetail auctionId={selectedId} onClose={() => setSelectedId(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function FeedCard({ auction, isActive, onOpen }: { auction: Auction; isActive: boolean; onOpen: () => void }) {
  const [currentPrice, setCurrentPrice] = useState(auction.current_price)
  const [bidCount, setBidCount] = useState(auction.bid_count)

  useEffect(() => {
    setCurrentPrice(auction.current_price)
    setBidCount(auction.bid_count)
  }, [auction])

  useEffect(() => {
    if (!isActive) return
    const unsub = wsClient.on('bid_update', (msg) => {
      const data = msg.data as { auction_id: number; current_price: number; bid_count: number }
      if (data.auction_id === auction.id) {
        setCurrentPrice(data.current_price)
        setBidCount(data.bid_count)
      }
    })
    return unsub
  }, [auction.id, isActive])

  const parseImages = (s: string) => { try { return JSON.parse(s) } catch { return s ? [s] : [] } }
  const images = parseImages(auction.product?.images || '')
  const cover = images[0] || `https://picsum.photos/seed/${auction.id * 7}/400/700`

  return (
    <div className="h-full w-full relative cursor-pointer" onClick={onOpen}>
      {/* Background */}
      <img src={cover} alt={auction.product?.title} className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

      {/* Top badge */}
      <div className="absolute top-16 left-4 flex items-center gap-2">
        <span className="bg-brand-pink text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
          🔴 直播竞拍
        </span>
        {auction.seconds_left && auction.seconds_left <= 30 && (
          <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
            ⚡ 即将结束
          </span>
        )}
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-24 left-4 right-16">
        <h3 className="text-white font-black text-xl leading-tight">{auction.product?.title}</h3>
        <p className="text-white/70 text-sm mt-1 line-clamp-2">{auction.product?.description}</p>

        <div className="flex items-center gap-3 mt-3">
          <div className="bg-black/50 backdrop-blur-sm rounded-xl px-3 py-2">
            <div className="text-white/60 text-xs">当前价</div>
            <motion.div
              key={currentPrice}
              initial={{ scale: 1.2, color: '#FE2C55' }}
              animate={{ scale: 1, color: '#fff' }}
              transition={{ duration: 0.3 }}
              className="text-white font-black text-lg"
            >
              ¥{currentPrice.toLocaleString()}
            </motion.div>
          </div>
          <div className="bg-black/50 backdrop-blur-sm rounded-xl px-3 py-2">
            <div className="text-white/60 text-xs">出价次数</div>
            <div className="text-white font-bold text-lg">{bidCount}</div>
          </div>
        </div>
      </div>

      {/* Tap hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/40 text-xs">
        点击进入竞拍
      </div>
    </div>
  )
}
