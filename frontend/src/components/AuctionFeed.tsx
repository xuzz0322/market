import React, { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Search as SearchIcon, Sparkles, Radio } from 'lucide-react'
import type { Auction, AuctionRoom } from '../types'
import { listAuctions, followedRooms } from '../services/api'
import wsClient from '../services/websocket'
import AuctionDetail from './AuctionDetail'

type FeedTab = 'recommend' | 'following'

// ─── Tab bar ────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: FeedTab; onChange: (t: FeedTab) => void }) {
  return (
    <div className="absolute top-0 left-0 right-0 z-30 flex justify-center pt-3 pb-1 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
      <div className="flex gap-1 bg-black/40 backdrop-blur-md rounded-full px-1 py-1 pointer-events-auto">
        <TabBtn id="recommend" active={active} label="推荐" icon={<Sparkles size={13} />} onChange={onChange} />
        <TabBtn id="following" active={active} label="关注间" icon={<Radio size={13} />} onChange={onChange} />
      </div>
    </div>
  )
}

function TabBtn({ id, active, label, icon, onChange }: {
  id: FeedTab; active: FeedTab; label: string; icon: React.ReactNode; onChange: (t: FeedTab) => void
}) {
  return (
    <button
      onClick={() => onChange(id)}
      className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
        active === id ? 'bg-white text-black' : 'text-white/70'
      }`}
    >
      {icon} {label}
    </button>
  )
}

// ─── Recommend tab (vertical auction feed) ───────────────────────────────────

function AuctionFeedTab() {
  const navigate = useNavigate()
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
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadAuctions()
    const unsub = wsClient.on('auction_start', () => loadAuctions())
    return unsub
  }, [loadAuctions])

  const goNext = useCallback(() => {
    if (currentIndex < auctions.length - 1) setCurrentIndex((i) => i + 1)
  }, [currentIndex, auctions.length])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1)
  }, [currentIndex])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') goNext()
      if (e.key === 'ArrowUp') goPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev])

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (isScrolling.current) return
      isScrolling.current = true
      if (e.deltaY > 0) goNext(); else goPrev()
      setTimeout(() => { isScrolling.current = false }, 700)
    }
    const el = feedRef.current
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => el?.removeEventListener('wheel', onWheel)
  }, [goNext, goPrev])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (auctions.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="text-6xl">🎪</div>
        <h2 className="text-white text-xl font-bold">暂无进行中的拍卖</h2>
        <p className="text-white/50 text-sm">去发布一个商品并开始拍卖吧！</p>
      </div>
    )
  }

  return (
    <div
      ref={feedRef}
      className="h-full overflow-hidden relative"
      onTouchStart={(e) => { touchStartY.current = e.touches[0].clientY }}
      onTouchEnd={(e) => {
        if (isScrolling.current) return
        const diff = touchStartY.current - e.changedTouches[0].clientY
        if (Math.abs(diff) > 50) {
          isScrolling.current = true
          if (diff > 0) goNext(); else goPrev()
          setTimeout(() => { isScrolling.current = false }, 600)
        }
      }}
    >
      <div
        className="h-full transition-transform duration-500 ease-in-out"
        style={{ transform: `translateY(-${currentIndex * 100}%)` }}
      >
        {auctions.map((auction, idx) => (
          <div key={auction.id} className="h-screen w-full relative">
            <FeedCard auction={auction} isActive={idx === currentIndex} onOpen={() => setSelectedId(auction.id)} />
          </div>
        ))}
      </div>

      {/* Progress dots */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-20">
        {auctions.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrentIndex(i)}
            className={`w-1 rounded-full transition-all ${i === currentIndex ? 'h-6 bg-white' : 'h-1.5 bg-white/40'}`}
          />
        ))}
      </div>

      {/* Search button */}
      <button
        onClick={() => navigate('/search')}
        className="absolute top-14 left-4 z-20 w-10 h-10 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/15"
      >
        <SearchIcon size={18} />
      </button>

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

// ─── Following tab (rooms the user follows) ──────────────────────────────────

function FollowingTab() {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<AuctionRoom[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    followedRooms()
      .then(setRooms)
      .catch(() => setRooms([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (rooms.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="text-6xl">📡</div>
        <h2 className="text-white text-xl font-bold">还没有关注任何主播</h2>
        <p className="text-white/50 text-sm">去拍卖间关注主播，他们开拍时会在这里出现</p>
        <button
          onClick={() => navigate('/rooms')}
          className="mt-2 bg-brand-pink text-white font-bold px-6 py-2.5 rounded-full text-sm"
        >
          逛拍卖间
        </button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pt-14 pb-24">
      <div className="px-3 grid grid-cols-2 gap-3">
        {rooms.map((r) => {
          const live = !!r.current_auction_id
          return (
            <motion.button
              key={r.id}
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate(`/rooms/${r.id}`)}
              className="text-left bg-white/5 rounded-2xl overflow-hidden"
            >
              <div className="relative aspect-[4/5]">
                <img
                  src={r.cover_url || `https://picsum.photos/seed/room${r.id}/400/500`}
                  alt={r.title}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                {live && (
                  <span className="absolute top-1.5 left-1.5 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 animate-pulse">
                    <Radio size={10} /> LIVE
                  </span>
                )}
                <div className="absolute bottom-2 left-2 right-2">
                  <div className="text-white font-black text-sm line-clamp-1">{r.title}</div>
                  <div className="text-white/60 text-[10px] mt-0.5">@{r.host?.username ?? '—'}</div>
                </div>
              </div>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Root component ──────────────────────────────────────────────────────────

export default function AuctionFeed() {
  const [tab, setTab] = useState<FeedTab>('recommend')

  return (
    <div className="h-screen bg-black overflow-hidden relative">
      <TabBar active={tab} onChange={setTab} />
      <AnimatePresence mode="wait">
        {tab === 'recommend' ? (
          <motion.div
            key="recommend"
            className="h-full"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <AuctionFeedTab />
          </motion.div>
        ) : (
          <motion.div
            key="following"
            className="h-full"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <FollowingTab />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Feed card (shared) ──────────────────────────────────────────────────────

function FeedCard({ auction, isActive, onOpen }: { auction: Auction; isActive: boolean; onOpen: () => void }) {
  const [currentPrice, setCurrentPrice] = useState(auction.current_price)
  const [bidCount, setBidCount] = useState(auction.bid_count)

  useEffect(() => { setCurrentPrice(auction.current_price); setBidCount(auction.bid_count) }, [auction])

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
      <img src={cover} alt={auction.product?.title} className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

      <div className="absolute top-16 left-4 flex items-center gap-2">
        <span className="bg-brand-pink text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
          🔴 直播竞拍
        </span>
        {auction.seconds_left && auction.seconds_left <= 30 && (
          <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">⚡ 即将结束</span>
        )}
      </div>

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

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/40 text-xs">点击进入竞拍</div>
    </div>
  )
}
