import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Eye, Heart, Share2, ChevronUp, Trophy, Zap, Info, Users, AlertTriangle, Package, Sparkles, ShieldCheck } from 'lucide-react'
import type { Auction, BidRanking, BidUpdateData, AuctionEndData } from '../types'
import { getAuction, placeBid, getAuctionRecommendations, getDepositState, payDeposit, type DepositState } from '../services/api'
import wsClient from '../services/websocket'
import { useAuthStore, useFavoritesStore } from '../services/store'
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
  const [viewerCount, setViewerCount] = useState(0)
  const [bidInput, setBidInput] = useState('')
  const [bidding, setBidding] = useState(false)
  const [particles, setParticles] = useState<Array<{ id: number; amount: number; username: string }>>([])
  const [showBidPanel, setShowBidPanel] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [outbidAlert, setOutbidAlert] = useState<{ leader: string; price: number } | null>(null)
  const [ended, setEnded] = useState(false)
  const [cancelled, setCancelled] = useState<{ reason: string } | null>(null)
  const [winner, setWinner] = useState<{ name: string; price: number; winnerId?: number } | null>(null)
  const [likeCount, setLikeCount] = useState(0)

  // Favorites — backed by zustand store, source-of-truth is the server.
  // We read directly via selector so the heart re-renders only when THIS
  // auction's state changes (not on every other favorite toggle).
  const isFavorited = useFavoritesStore((s) => s.ids.has(auctionId))
  const toggleFavorite = useFavoritesStore((s) => s.toggle)

  // Deposit state — gate that blocks the bid panel when the seller required
  // an earnest payment. Re-fetched after a successful pay so the UI flips
  // directly into "you can now bid" mode without a manual refresh.
  const [depositState, setDepositState] = useState<DepositState | null>(null)
  const [payingDeposit, setPayingDeposit] = useState(false)
  // Recommendations shown after the auction ends. Lazy-loaded once the
  // first end/cancel event fires so we don't pay the request cost during
  // the live bidding phase.
  const [recommendations, setRecommendations] = useState<Auction[]>([])
  const [showRecommendations, setShowRecommendations] = useState(false)
  const recsLoadedRef = useRef(false)

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
          setWinner({ name: res.auction.winner.username, price: res.auction.current_price, winnerId: res.auction.winner_id })
        } else {
          // No winner — could be reserve-not-met or no bids at all.
          setWinner({ name: '', price: res.auction.current_price })
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
      // Live concurrent viewers in this auction's room — refreshed on
      // every broadcast so the count reflects in-flight churn.
      if (typeof data.viewer_count === 'number') {
        setViewerCount(data.viewer_count)
      }
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
      setWinner({
        name: data.winner_name || '',
        price: data.final_price,
        winnerId: data.winner_id,
      })
    })

    // Personal "you've been outbid" — only fire the IN-PAGE banner here;
    // the global notifier (App-mounted) already handles toasts/OS
    // notifications. The banner gives the user an obvious "再加价" CTA
    // without scrolling away from the bid panel.
    const unsubOutbid = wsClient.on('bid_outbid', (msg) => {
      const data = msg.data as { auction_id: number; new_leader: string; current_price: number }
      if (data.auction_id !== auctionId) return
      setOutbidAlert({ leader: data.new_leader, price: data.current_price })
      // Auto-dismiss after a few seconds so it doesn't permanently
      // occupy screen real estate.
      setTimeout(() => setOutbidAlert(null), 5000)
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
      unsubOutbid()
      unsubCancel()
      unsubState()
      lastSeqRef.current = 0
    }
  }, [auctionId, loadAuction, resync])

  // Mark this auction as the user's current focus so the global outbid
  // notifier can suppress its banner toast for THIS auction (we already
  // show the in-page banner). Cleared on unmount.
  useEffect(() => {
    ;(window as unknown as { __auctionFocus?: number }).__auctionFocus = auctionId
    return () => {
      const w = window as unknown as { __auctionFocus?: number }
      if (w.__auctionFocus === auctionId) w.__auctionFocus = undefined
    }
  }, [auctionId])

  // Pull the user's deposit status once auction info is loaded. Skipped
  // when the user is the seller (sellers can't bid → can't deposit).
  useEffect(() => {
    if (!auction || !user) return
    if (user.id === auction.seller_id) return
    if (!auction.requires_deposit) {
      setDepositState({ required: false, amount: 0, paid: false })
      return
    }
    getDepositState(auctionId).then(setDepositState).catch(() => {})
  }, [auction, user, auctionId])

  const handlePayDeposit = async () => {
    if (!depositState) return
    setPayingDeposit(true)
    try {
      await payDeposit(auctionId)
      setDepositState({ ...depositState, paid: true, status: 'held' })
      toast.success(`已缴纳保证金 ¥${depositState.amount}，可以出价啦`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '缴纳失败'
      toast.error(msg)
    } finally {
      setPayingDeposit(false)
    }
  }

  // Once the auction terminates (ended or cancelled), pull recommendations
  // and surface the overlay. We load lazily — there's no value in fetching
  // these while the user is actively bidding, and the overlay is the only
  // place they're shown in this page. The ref guards against re-loading
  // when both `ended` and `cancelled` change in quick succession.
  useEffect(() => {
    if (!ended && !cancelled) return
    if (recsLoadedRef.current) return
    recsLoadedRef.current = true
    getAuctionRecommendations(auctionId, 10)
      .then((list) => {
        setRecommendations(list)
        if (list.length > 0) {
          // Slight delay so the result/cancel banner gets its entrance
          // animation before the overlay slides in over it.
          setTimeout(() => setShowRecommendations(true), 1200)
        }
      })
      .catch(() => {
        // Silent — recommendations are a non-critical feature.
      })
  }, [ended, cancelled, auctionId])

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

        {/* Like — actual favorite (persisted). The local liked/likeCount
            state is kept for the count animation, but the heart fill comes
            from the favorites store. */}
        <button
          onClick={async () => {
            try {
              const next = await toggleFavorite(auctionId)
              setLikeCount((c) => next ? c + 1 : Math.max(0, c - 1))
            } catch {
              toast.error('操作失败，请稍后重试')
            }
          }}
          className="flex flex-col items-center gap-1"
        >
          <motion.div whileTap={{ scale: 1.4 }} className={`text-2xl ${isFavorited ? 'text-red-500' : 'text-white'}`}>
            <Heart size={28} fill={isFavorited ? 'currentColor' : 'none'} />
          </motion.div>
          <span className="text-white text-xs">{(auction.view_count + likeCount).toLocaleString()}</span>
        </button>

        {/* Live viewers (concurrent in this room) — different from
            view_count which is the cumulative all-time visit count. */}
        <div className="flex flex-col items-center gap-1">
          <Users size={26} className="text-cyan-400" />
          <span className="text-white text-xs">{viewerCount}</span>
          <span className="text-white/50 text-[10px]">在看</span>
        </div>

        {/* Cumulative views */}
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

        {/* Rules — opens a slide-up drawer with the auction's pricing
            terms. Pulled out of the bottom info area because new users
            consistently miss things like the reserve / min increment /
            buy-now caps when they're inline-text. */}
        <button onClick={() => setShowRules(true)} className="flex flex-col items-center gap-1">
          <Info size={26} className="text-white" />
          <span className="text-white text-xs">规则</span>
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

        {/* Outbid alert — flashes when this user's bid was just beaten.
            Distinct from the global toast: this one sits inline near the
            bid panel so the "再加价" CTA is one tap away. */}
        <AnimatePresence>
          {outbidAlert && !ended && !cancelled && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-3 bg-gradient-to-r from-red-600 to-rose-700 rounded-2xl p-3 flex items-center gap-3 border border-red-400/50"
            >
              <AlertTriangle size={22} className="text-white flex-shrink-0 animate-pulse" />
              <div className="flex-1 min-w-0">
                <div className="text-white font-bold text-sm">你被反超了！</div>
                <div className="text-white/90 text-xs">
                  @{outbidAlert.leader} 出价至 ¥{outbidAlert.price.toLocaleString()} — 立即加价
                </div>
              </div>
              <button
                onClick={() => { setShowBidPanel(true); setOutbidAlert(null) }}
                className="bg-white text-red-600 font-black text-xs px-3 py-1.5 rounded-full flex-shrink-0"
              >
                再加价
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Auction ended — distinguishes 4 outcomes for clarity:
            1. You won (winner_id === me) — gold celebration + 查看订单 CTA
            2. Someone else won — neutral result line
            3. Reserve not met (winner_name empty but bid_count > 0) — yellow
            4. No bids — gray flat-line */}
        <AnimatePresence>
          {ended && winner && !cancelled && (() => {
            const youWon = !!winner.winnerId && winner.winnerId === user?.id
            const reserveNotMet = !winner.name && auction.bid_count > 0
            const noBids = !winner.name && auction.bid_count === 0

            if (youWon) {
              return (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mb-3 bg-gradient-to-r from-yellow-400 via-orange-500 to-pink-500 rounded-2xl p-4 text-white"
                >
                  <div className="flex items-center gap-3">
                    <div className="text-4xl">🏆</div>
                    <div className="flex-1">
                      <div className="font-black text-lg">恭喜中标！</div>
                      <div className="text-white/90 text-sm">
                        以 ¥{winner.price.toLocaleString()} 拍下《{auction.product?.title}》
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => navigate('/orders')}
                    className="w-full mt-3 bg-white text-orange-600 font-black py-2.5 rounded-xl flex items-center justify-center gap-2"
                  >
                    <Package size={16} /> 查看订单 / 填写收货地址
                  </button>
                  {recommendations.length > 0 && (
                    <button
                      onClick={() => setShowRecommendations(true)}
                      className="w-full mt-2 bg-white/20 text-white font-bold py-2 rounded-xl flex items-center justify-center gap-2 text-sm"
                    >
                      <Sparkles size={14} /> 看看其他类似宝贝
                    </button>
                  )}
                </motion.div>
              )
            }
            if (reserveNotMet) {
              return (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-3 bg-yellow-500/30 border border-yellow-500/50 rounded-2xl p-3 flex items-center gap-3">
                  <div className="text-2xl">📉</div>
                  <div>
                    <div className="text-yellow-100 font-bold">流拍 — 未达保留价</div>
                    <div className="text-yellow-100/80 text-xs">最高出价 ¥{winner.price.toLocaleString()}，本次拍卖无人成交</div>
                  </div>
                </motion.div>
              )
            }
            if (noBids) {
              return (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-3 bg-white/10 rounded-2xl p-3 flex items-center gap-3">
                  <div className="text-2xl">🌙</div>
                  <div>
                    <div className="text-white font-bold">无人出价</div>
                    <div className="text-white/60 text-xs">本场拍卖结束，没有竞拍者</div>
                  </div>
                </motion.div>
              )
            }
            return (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-3 bg-gradient-to-r from-yellow-500/90 to-orange-500/90 rounded-2xl p-3 flex items-center gap-3">
                <Trophy size={28} className="text-white flex-shrink-0" />
                <div>
                  <div className="text-white font-bold">拍卖结束</div>
                  <div className="text-white/90 text-sm">
                    🎉 @{winner.name} 以 ¥{winner.price.toLocaleString()} 赢得竞拍
                  </div>
                </div>
              </motion.div>
            )
          })()}
        </AnimatePresence>

        {/* "Look at similar items" CTA — shown for any end state (lost,
            reserve-not-met, no-bids, cancelled) when we have recs to offer.
            Skipped for the win case because that branch already includes
            its own equivalent button next to the order CTA. */}
        {(ended || cancelled) && recommendations.length > 0 && !showRecommendations &&
         !(ended && winner && winner.winnerId === user?.id) && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => setShowRecommendations(true)}
            className="w-full mb-3 bg-white/15 backdrop-blur-md text-white font-bold py-2.5 rounded-2xl flex items-center justify-center gap-2 text-sm border border-white/15"
          >
            <Sparkles size={16} className="text-yellow-400" /> 看看其他类似宝贝
          </motion.button>
        )}

        {/* Bid CTA */}
        {auction.status === 'active' && !ended && !cancelled && user?.id !== auction.seller_id && (
          <>
            {/* Deposit gate — when the seller required earnest, replace
                the bid CTA with a "缴纳保证金" button. After payment, the
                UI flips back to the normal bid flow on the next render. */}
            {depositState?.required && !depositState.paid ? (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={handlePayDeposit}
                disabled={payingDeposit}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-black text-base py-3.5 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <ShieldCheck size={18} />
                {payingDeposit
                  ? '缴纳中...'
                  : `缴纳保证金 ¥${depositState.amount} 后出价`}
              </motion.button>
            ) : !showBidPanel ? (
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

      {/* Recommendations overlay — surfaces after the auction terminates
          (won / lost / cancelled / no-bids). Designed to keep the user
          engaged: pull them straight into another live auction in a category
          they care about instead of letting them bounce. Slides up from the
          bottom and is dismissable. The "查看更多" button at the top of the
          ended banner re-opens it if the user closed it. */}
      <AnimatePresence>
        {showRecommendations && recommendations.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowRecommendations(false)}
            className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end"
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-brand-dark border-t border-white/10 rounded-t-3xl p-5 pb-8 max-h-[80vh] overflow-y-auto"
            >
              <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-black text-lg flex items-center gap-2">
                  <Sparkles size={18} className="text-yellow-400" /> 猜你喜欢
                </h3>
                <button onClick={() => setShowRecommendations(false)} className="text-white/50 px-2 text-sm">关闭</button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {recommendations.map((a) => {
                  let img = ''
                  try {
                    const arr = JSON.parse(a.product?.images || '[]')
                    img = Array.isArray(arr) ? arr[0] : ''
                  } catch { /* ignore */ }
                  if (!img) img = `https://picsum.photos/seed/r${a.id}/400/500`
                  return (
                    <motion.button
                      key={a.id}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => {
                        setShowRecommendations(false)
                        // Use replace so the back button doesn't bounce the
                        // user through a stack of ended auctions.
                        navigate(`/auction/${a.id}`, { replace: true })
                      }}
                      className="text-left bg-white/5 rounded-xl overflow-hidden"
                    >
                      <div className="relative aspect-[4/5]">
                        <img src={img} alt={a.product?.title} className="w-full h-full object-cover" loading="lazy" />
                        <span className="absolute top-1.5 left-1.5 bg-brand-pink text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                          <Zap size={10} /> 直播中
                        </span>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                          <div className="text-white text-xs font-bold line-clamp-1">{a.product?.title}</div>
                          <div className="flex items-center justify-between mt-0.5">
                            <span className="text-brand-pink text-sm font-black">¥{a.current_price.toLocaleString()}</span>
                            <span className="text-white/60 text-[10px]">{a.bid_count} 出价</span>
                          </div>
                        </div>
                      </div>
                    </motion.button>
                  )
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rules drawer — slides up from the bottom. Lives at the root of
          the component so it overlays all other content (z-50). The
          backdrop click and the close button both dismiss; we trap the
          inner click so tapping the drawer body doesn't dismiss. */}
      <AnimatePresence>
        {showRules && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowRules(false)}
            className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end"
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-brand-dark border-t border-white/10 rounded-t-3xl p-5 pb-8"
            >
              <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-black text-lg flex items-center gap-2"><Info size={18} /> 竞拍规则</h3>
                <button onClick={() => setShowRules(false)} className="text-white/50 px-2">关闭</button>
              </div>

              <div className="space-y-2.5">
                <RuleRow label="起拍价"  value={auction.start_price === 0 ? '⚡ 0元起拍' : `¥${auction.start_price.toLocaleString()}`} highlight={auction.start_price === 0} />
                <RuleRow label="加价幅度" value={`+¥${auction.min_increment} / 次`} />
                {auction.has_reserve && (
                  <RuleRow
                    label="保留价"
                    value={`¥${auction.reserve_price.toLocaleString()}`}
                    sub="未达保留价时拍卖流拍，无人成交"
                    highlight
                  />
                )}
                {auction.has_buy_now && (
                  <RuleRow
                    label="封顶价"
                    value={`¥${auction.buy_now_price.toLocaleString()}`}
                    sub="出价达到此值立即结拍并成交"
                    highlight
                  />
                )}
                {auction.requires_deposit && auction.deposit_amount > 0 && (
                  <RuleRow
                    label="保证金"
                    value={`¥${auction.deposit_amount.toLocaleString()}`}
                    sub="出价前需缴纳，未中标全额退回；中标抵扣最终成交价"
                    highlight
                  />
                )}
                <RuleRow
                  label="竞拍时长"
                  value={(() => {
                    const d = auction.duration
                    if (d >= 3600) return `${Math.floor(d / 3600)} 小时${d % 3600 ? ` ${Math.floor((d % 3600) / 60)} 分` : ''}`
                    if (d >= 60) return `${Math.floor(d / 60)} 分钟`
                    return `${d} 秒`
                  })()}
                />
                <RuleRow label="商品分类" value={auction.product?.category || '—'} />
                <RuleRow label="卖家" value={`@${auction.seller?.username ?? '—'}`} />
              </div>

              <div className="mt-4 bg-white/5 rounded-xl p-3 text-xs text-white/60 leading-relaxed">
                <div className="text-white/80 font-bold mb-1">温馨提示</div>
                · 出价后无法撤回，请确认金额无误<br />
                · 中标后货款已托管，确认收货后释放给卖家<br />
                · 竞拍结束前可被其他买家反超，请关注通知
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RuleRow({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-white/60 text-sm flex-shrink-0">{label}</div>
      <div className="text-right">
        <div className={`font-bold text-sm ${highlight ? 'text-yellow-400' : 'text-white'}`}>{value}</div>
        {sub && <div className="text-white/40 text-xs mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}
