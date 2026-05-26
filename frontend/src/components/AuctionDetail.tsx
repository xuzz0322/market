import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Eye, Heart, Share2, ChevronUp, Trophy, Zap } from 'lucide-react'
import type { Auction, BidRanking, BidUpdateData, AuctionEndData } from '../types'
import { getAuction, placeBid } from '../services/api'
import wsClient from '../services/websocket'
import { useAuthStore } from '../services/store'
import CountdownTimer from './CountdownTimer'

// Floating bid animation particle
const BidParticle = ({ amount, username }: { amount: number; username: string }) => (
  <motion.div
    initial={{ opacity: 1, y: 0, scale: 1 }}
    animate={{ opacity: 0, y: -100, scale: 1.3 }}
    transition={{ duration: 1.5, ease: 'easeOut' }}
    className="absolute bottom-32 right-4 bg-brand-pink text-white text-sm font-bold px-3 py-1 rounded-full z-30 pointer-events-none"
  >
    +¥{amount.toFixed(0)} {username}
  </motion.div>
)

interface AuctionDetailProps {
  auctionId?: number
  onClose?: () => void
}

export default function AuctionDetail({ auctionId: propAuctionId, onClose }: AuctionDetailProps) {
  const { id: paramId } = useParams()
  const navigate = useNavigate()
  const auctionId = propAuctionId ?? Number(paramId)
  const { user } = useAuthStore()

  const [auction, setAuction] = useState<Auction | null>(null)
  const [rankings, setRankings] = useState<BidRanking[]>([])
  const [endAtMs, setEndAtMs] = useState(0)
  const [bidInput, setBidInput] = useState('')
  const [bidding, setBidding] = useState(false)
  const [particles, setParticles] = useState<Array<{ id: number; amount: number; username: string }>>([])
  const [showBidPanel, setShowBidPanel] = useState(false)
  const [ended, setEnded] = useState(false)
  const [cancelled, setCancelled] = useState<{ reason: string } | null>(null)
  const [winner, setWinner] = useState<{ name: string; price: number } | null>(null)
  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)

  // Last seen sequence — used to detect dropped WS messages and trigger
  // a full HTTP resync when the stream skips. Stored in a ref so the
  // bid_update handler always reads the latest value without re-subscribing.
  const lastSeqRef = useRef(0)
  const resyncInFlightRef = useRef(false)

  const loadAuction = useCallback(async () => {
    try {
      const res = await getAuction(auctionId)
      setAuction(res.auction)
      setRankings(res.rankings)
      // Compute endAtMs from auction.end_time (ISO string from JSON).
      // This is the source of truth before any WS message arrives.
      if (res.auction.end_time) {
        setEndAtMs(new Date(res.auction.end_time).getTime())
      }
      if (res.auction.status === 'ended') {
        setEnded(true)
        if (res.auction.winner) {
          setWinner({ name: res.auction.winner.username, price: res.auction.current_price })
        }
      } else if (res.auction.status === 'cancelled') {
        setCancelled({ reason: res.auction.cancel_reason || '卖家取消了拍卖' })
      }
    } catch {
      toast.error('加载失败')
    }
  }, [auctionId])

  // Triggered when we detect a sequence gap or some other inconsistency.
  // Pulls the canonical state via HTTP. Throttled by a ref so a flood of
  // gap-detect events doesn't hammer the API.
  const resync = useCallback(async () => {
    if (resyncInFlightRef.current) return
    resyncInFlightRef.current = true
    try {
      await loadAuction()
    } finally {
      // Small cooldown so consecutive late messages don't each trigger a fetch.
      setTimeout(() => { resyncInFlightRef.current = false }, 500)
    }
  }, [loadAuction])

  // WebSocket listeners
  useEffect(() => {
    loadAuction()
    wsClient.joinAuction(auctionId)

    const unsubBid = wsClient.on('bid_update', (msg) => {
      const data = msg.data as BidUpdateData
      if (data.auction_id !== auctionId) return

      // Sequence gap detection. If the server's seq jumped past what we
      // expect (e.g., 5 → 8), it means we missed messages while the WS was
      // briefly disconnected, slow, or in a backpressure-drop state. We
      // accept this update (the latest is always more correct than nothing)
      // AND trigger a full HTTP resync to make sure rankings and any other
      // state we couldn't reconstruct from the partial deltas are correct.
      const lastSeq = lastSeqRef.current
      const seq = data.seq ?? 0
      if (lastSeq > 0 && seq > lastSeq + 1) {
        console.warn(`[bid_update] seq gap ${lastSeq} → ${seq}, resyncing`)
        resync()
      }
      // Out-of-order: ignore older messages so a delayed packet can't
      // overwrite newer state. (This can happen if a tab unsuspended
      // and got a flood of buffered messages.)
      if (seq > 0 && seq < lastSeq) {
        return
      }
      if (seq > 0) lastSeqRef.current = seq

      setAuction((prev) => prev ? { ...prev, current_price: data.current_price, bid_count: data.bid_count } : prev)
      setRankings(data.rankings)
      // end_at_ms is the authoritative end time. Update on every message so
      // the timer stays aligned with the server even if our HTTP load was stale.
      if (data.end_at_ms) setEndAtMs(data.end_at_ms)

      if (data.last_bidder) {
        const pid = Date.now()
        setParticles((prev) => [...prev, { id: pid, amount: data.current_price, username: data.last_bidder }])
        setTimeout(() => setParticles((prev) => prev.filter((p) => p.id !== pid)), 2000)
      }
    })

    const unsubEnd = wsClient.on('auction_end', (msg) => {
      const data = msg.data as AuctionEndData
      if (data.auction_id !== auctionId) return
      setEnded(true)
      setWinner({ name: data.winner_name || '无人竞拍', price: data.final_price })
    })

    const unsubCancel = wsClient.on('auction_cancel', (msg) => {
      const data = msg.data as { auction_id: number; reason: string }
      if (data.auction_id !== auctionId) return
      setCancelled({ reason: data.reason || '卖家取消了拍卖' })
      toast('该拍卖已被卖家取消', { icon: '⚠️' })
    })

    // After every reconnect, we resync once. The WS layer auto-rejoins the
    // room (which sends a fresh bid_update snapshot), but we also re-pull
    // over HTTP for any state not in that snapshot (winner info, cancel
    // reason, product status changes).
    const unsubState = wsClient.onStateChange((s) => {
      if (s === 'connected' && lastSeqRef.current > 0) {
        // Skip the very first 'connected' (initial connect) — loadAuction
        // is already running. Only resync on RECONNECT (lastSeq > 0
        // means we previously had a stream).
        resync()
      }
    })

    return () => {
      wsClient.leaveAuction(auctionId)
      unsubBid()
      unsubEnd()
      unsubCancel()
      unsubState()
      lastSeqRef.current = 0
    }
  }, [auctionId, loadAuction, resync])

  const handleBid = async () => {
    if (!user) { toast.error('请先登录'); return }
    const amount = parseFloat(bidInput)
    if (isNaN(amount) || amount <= 0) { toast.error('请输入有效金额'); return }

    const minBid = auction ? (auction.bid_count === 0 ? auction.start_price : auction.current_price + auction.min_increment) : 0
    if (amount < minBid) { toast.error(`最低出价 ¥${minBid.toFixed(2)}`); return }

    setBidding(true)
    try {
      await placeBid(auctionId, amount)
      setBidInput('')
      setShowBidPanel(false)
      toast.success(`出价 ¥${amount.toFixed(2)} 成功！`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '出价失败'
      toast.error(msg)
    } finally {
      setBidding(false)
    }
  }

  const handleQuickBid = async (multiplier: number) => {
    if (!auction) return
    const minBid = auction.bid_count === 0 ? auction.start_price : auction.current_price + auction.min_increment
    const amount = parseFloat((minBid * multiplier).toFixed(2))
    setBidInput(String(amount))
  }

  const parseImages = (imagesStr: string): string[] => {
    try {
      return JSON.parse(imagesStr) || []
    } catch {
      return imagesStr ? [imagesStr] : []
    }
  }

  if (!auction) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const images = parseImages(auction.product?.images || '')
  const coverImage = images[0] || `https://picsum.photos/seed/${auction.id}/400/700`
  const minNextBid = auction.bid_count === 0
    ? auction.start_price
    : auction.current_price + auction.min_increment

  return (
    <div className="relative h-full w-full bg-black overflow-hidden select-none">
      {/* Background image / video */}
      <div className="absolute inset-0">
        <img src={coverImage} alt={auction.product?.title} className="w-full h-full object-cover opacity-80" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/30" />
      </div>

      {/* Back button */}
      <button
        onClick={() => onClose ? onClose() : navigate(-1)}
        className="absolute top-4 left-4 z-20 p-2 rounded-full bg-black/30 text-white"
      >
        <ArrowLeft size={20} />
      </button>

      {/* Cyber countdown - top right floating */}
      {auction.status === 'active' && !ended && !cancelled && (
        <div className="absolute top-3 right-3 z-30">
          <CountdownTimer
            endAtMs={endAtMs}
            clockSkewMs={wsClient.getClockSkew()}
            totalSeconds={auction.duration}
            onEnd={() => {
              // Server-side settler will broadcast auction_end shortly;
              // until then, render an "ending..." soft state via remaining=0.
              // No action needed here — the auction_end handler flips `ended`.
            }}
          />
        </div>
      )}

      {/* Floating bid particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {particles.map((p) => (
          <BidParticle key={p.id} amount={p.amount} username={p.username} />
        ))}
      </div>

      {/* Right action column (TikTok style) */}
      <div className="absolute right-3 bottom-36 flex flex-col items-center gap-5 z-20">
        {/* Avatar */}
        <div className="relative">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center text-white font-bold text-lg ring-2 ring-white">
            {auction.seller?.username?.[0]?.toUpperCase()}
          </div>
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-5 h-5 bg-brand-pink rounded-full flex items-center justify-center">
            <span className="text-white text-xs">+</span>
          </div>
        </div>

        {/* Like */}
        <button onClick={() => { setLiked(!liked); setLikeCount(c => liked ? c - 1 : c + 1) }} className="flex flex-col items-center gap-1">
          <motion.div whileTap={{ scale: 1.4 }} className={`text-2xl ${liked ? 'text-red-500' : 'text-white'}`}>
            <Heart size={28} fill={liked ? 'currentColor' : 'none'} />
          </motion.div>
          <span className="text-white text-xs">{(auction.view_count + likeCount).toLocaleString()}</span>
        </button>

        {/* Views */}
        <div className="flex flex-col items-center gap-1">
          <Eye size={26} className="text-white" />
          <span className="text-white text-xs">{auction.view_count.toLocaleString()}</span>
        </div>

        {/* Bid count */}
        <div className="flex flex-col items-center gap-1">
          <Zap size={26} className="text-yellow-400" />
          <span className="text-white text-xs">{auction.bid_count}</span>
        </div>

        {/* Share */}
        <button className="flex flex-col items-center gap-1">
          <Share2 size={26} className="text-white" />
          <span className="text-white text-xs">分享</span>
        </button>
      </div>

      {/* Bottom content */}
      <div className="absolute bottom-0 left-0 right-0 pb-4 px-4 z-20">

        {/* Rankings bar */}
        {rankings.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
            {rankings.slice(0, 5).map((r) => (
              <motion.div
                key={r.user_id}
                layout
                className="flex items-center gap-1 bg-white/10 backdrop-blur-sm rounded-full px-2 py-1 min-w-fit"
              >
                <span className={`text-xs font-bold ${r.rank === 1 ? 'text-yellow-400' : r.rank === 2 ? 'text-gray-300' : 'text-orange-400'}`}>
                  {r.rank === 1 ? '👑' : `#${r.rank}`}
                </span>
                <span className="text-white text-xs">{r.username}</span>
                <span className="text-brand-pink text-xs font-bold">¥{r.amount.toLocaleString()}</span>
              </motion.div>
            ))}
          </div>
        )}

        {/* Auction info */}
        <div className="mb-3">
          <h2 className="text-white font-bold text-lg leading-tight">{auction.product?.title}</h2>
          <p className="text-gray-300 text-sm mt-0.5 line-clamp-2">{auction.product?.description}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-gray-400 text-xs">@{auction.seller?.username}</span>
            {auction.product?.category && (
              <span className="text-xs bg-white/10 text-white rounded px-1.5 py-0.5">{auction.product.category}</span>
            )}
          </div>
        </div>

        {/* Price + Timer row */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-gray-400 text-xs">当前价格</div>
            <motion.div
              key={auction.current_price}
              initial={{ scale: 1.3, color: '#FE2C55' }}
              animate={{ scale: 1, color: '#ffffff' }}
              transition={{ duration: 0.4 }}
              className="text-2xl font-black text-white"
            >
              ¥{auction.current_price.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
            </motion.div>
            {auction.bid_count === 0 && (
              <div className="text-gray-400 text-xs">起拍价 ¥{auction.start_price.toFixed(2)}</div>
            )}
          </div>

          {/* Countdown - now using cyber CountdownTimer in top-right */}
          {auction.status === 'pending' && (
            <div className="bg-yellow-500/80 rounded-xl px-3 py-2">
              <span className="text-white text-sm font-bold">即将开始</span>
            </div>
          )}
        </div>

        {/* Auction cancelled state — takes precedence over normal end UI.
            We show this even if the user has the bid panel open; the
            wsClient.on('auction_cancel') handler will already have
            triggered, but the user could be mid-typing a bid. */}
        <AnimatePresence>
          {cancelled && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className="mb-3 bg-gradient-to-r from-red-600/90 to-rose-700/90 rounded-2xl p-3 flex items-start gap-3 border border-red-400/50"
            >
              <div className="text-2xl flex-shrink-0">⚠️</div>
              <div>
                <div className="text-white font-bold">该拍卖已被卖家取消</div>
                <div className="text-white/90 text-sm mt-0.5 break-words">
                  原因：{cancelled.reason}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Auction ended state */}
        <AnimatePresence>
          {ended && winner && !cancelled && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 bg-gradient-to-r from-yellow-500/90 to-orange-500/90 rounded-2xl p-3 flex items-center gap-3"
            >
              <Trophy size={28} className="text-white flex-shrink-0" />
              <div>
                <div className="text-white font-bold">拍卖结束！</div>
                <div className="text-white/90 text-sm">
                  {winner.name ? `🎉 ${winner.name} 以 ¥${winner.price.toFixed(2)} 赢得竞拍` : '无人出价，流拍'}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bid CTA */}
        {auction.status === 'active' && !ended && !cancelled && user?.id !== auction.seller_id && (
          <>
            {!showBidPanel ? (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => setShowBidPanel(true)}
                className="w-full bg-brand-pink text-white font-black text-lg py-3.5 rounded-2xl flex items-center justify-center gap-2"
              >
                <ChevronUp size={20} />
                立即出价 — 最低 ¥{minNextBid.toFixed(2)}
              </motion.button>
            ) : (
              <AnimatePresence>
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 30 }}
                  className="bg-white/10 backdrop-blur-md rounded-2xl p-3"
                >
                  {/* Quick bid buttons */}
                  <div className="flex gap-2 mb-2">
                    {[1, 1.1, 1.5, 2].map((m) => (
                      <button
                        key={m}
                        onClick={() => handleQuickBid(m)}
                        className="flex-1 bg-white/15 text-white text-xs py-1.5 rounded-lg font-bold"
                      >
                        ×{m}
                      </button>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={bidInput}
                      onChange={(e) => setBidInput(e.target.value)}
                      placeholder={`最低 ¥${minNextBid.toFixed(2)}`}
                      className="flex-1 bg-white/20 text-white placeholder-white/50 rounded-xl px-3 py-2.5 text-base outline-none"
                    />
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={handleBid}
                      disabled={bidding}
                      className="bg-brand-pink text-white font-black px-5 py-2.5 rounded-xl disabled:opacity-50"
                    >
                      {bidding ? '...' : '出价'}
                    </motion.button>
                    <button onClick={() => setShowBidPanel(false)} className="text-white/60 px-2">取消</button>
                  </div>

                  {auction.buy_now_price > 0 && (
                    <button
                      onClick={() => { setBidInput(String(auction.buy_now_price)); handleBid() }}
                      className="w-full mt-2 bg-yellow-500 text-white font-bold py-2 rounded-xl text-sm"
                    >
                      立即购买 ¥{auction.buy_now_price.toLocaleString()}
                    </button>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </>
        )}
      </div>
    </div>
  )
}
