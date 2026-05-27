import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Plus, Radio, Play, X, Package, Clock, Info, UserPlus, UserCheck } from 'lucide-react'
import {
  getRoom, addRoomAuction, startNextInRoom, closeRoom,
  listProducts, createProduct, type RoomDetailResponse,
  getFollowState, followUser, unfollowUser,
} from '../services/api'
import type { Product } from '../types'
import { useAuthStore } from '../services/store'
import AuctionDetail from '../components/AuctionDetail'
import LiveStream from '../components/LiveStream'
import RoomChat from '../components/RoomChat'
import wsClient from '../services/websocket'

export default function RoomDetail() {
  const { id } = useParams()
  const roomId = Number(id)
  const navigate = useNavigate()
  const { user } = useAuthStore()

  const [data, setData] = useState<RoomDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getRoom(roomId))
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [roomId])

  useEffect(() => { load() }, [load])

  // Refresh on auction lifecycle events so the queue/current state stays
  // synced when the host or backend auto-advances. We don't subscribe to
  // bid_update here — AuctionDetail handles that itself.
  useEffect(() => {
    const off1 = wsClient.on('auction_end', () => { load() })
    const off2 = wsClient.on('auction_start', () => { load() })
    const off3 = wsClient.on('auction_cancel', () => { load() })
    return () => { off1(); off2(); off3() }
  }, [load])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-brand-dark flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const isHost = user?.id === data.room.host_id
  const { room, current, queue, history } = data

  const [showIntro, setShowIntro] = useState(false)
  const [following, setFollowing] = useState<boolean | null>(null)

  // Pull follow state once per host. Skipped for the host themselves —
  // they can't follow themselves.
  useEffect(() => {
    if (isHost) return
    getFollowState(room.host_id).then((s) => setFollowing(s.following)).catch(() => {})
  }, [isHost, room.host_id])

  const toggleFollow = async () => {
    try {
      if (following) {
        await unfollowUser(room.host_id)
        setFollowing(false)
        toast.success('已取消关注')
      } else {
        await followUser(room.host_id)
        setFollowing(true)
        toast.success('关注成功，主播开播会通知你')
      }
    } catch {
      toast.error('操作失败')
    }
  }

  const onClose = async () => {
    if (!confirm('关闭拍卖间后将不再接受新拍品。确认关闭？')) return
    try {
      await closeRoom(roomId)
      toast.success('拍卖间已关闭')
      load()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '关闭失败'
      toast.error(msg)
    }
  }

  const onStartNext = async () => {
    try {
      await startNextInRoom(roomId)
      toast.success('已开始下一场')
      load()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '开始失败'
      toast.error(msg)
    }
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-30 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-black text-base truncate flex items-center gap-1.5">
            {current && <Radio size={14} className="text-red-500 animate-pulse" />}
            {room.title}
          </div>
          <div className="text-white/50 text-xs">@{room.host?.username ?? '—'} · 共 {room.total_auctions} 场</div>
        </div>
        {isHost && room.status === 'open' && (
          <button onClick={onClose} className="text-white/50 text-xs px-2">关闭间</button>
        )}
        {!isHost && following !== null && (
          <button
            onClick={toggleFollow}
            className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${following ? 'bg-white/10 text-white/70' : 'bg-brand-pink text-white'}`}
          >
            {following ? <><UserCheck size={12} /> 已关注</> : <><UserPlus size={12} /> 关注</>}
          </button>
        )}
        {room.status === 'closed' && (
          <span className="text-white/40 text-xs px-2">已关闭</span>
        )}
      </div>

      {/* Current auction inline. We embed AuctionDetail with its own
          auctionId so all the live bidding UI / WS handling reuses without
          duplication. The container constrains height so the page can
          scroll past it to the queue. */}
      {current ? (
        <div className="relative h-[100vh] -mt-[1px]">
          <AuctionDetail auctionId={current.id} onClose={() => navigate(-1)} />

          {/* Live A/V commentary overlay — host gets a "开始讲解" button +
              local preview tile; viewers see the incoming stream once host
              is broadcasting. Mounted over the auction so commentary plays
              while users bid. */}
          <LiveStream
            roomId={room.id}
            hostUserId={room.host_id}
            isHostMode={isHost}
            hostUsername={room.host?.username}
          />

          {/* Live chat + danmaku overlay. Anyone in the room can send. */}
          <RoomChat roomId={room.id} />

          {/* Item introduction — quick-access drawer with the product's full
              description / images, surfaced as a button next to the rules
              icon so users can deep-read the item without leaving the
              bidding flow. */}
          {current.product && (
            <button
              onClick={() => setShowIntro(true)}
              className="absolute top-32 right-3 z-30 w-10 h-10 rounded-full bg-black/40 backdrop-blur-md text-white border border-white/15 flex items-center justify-center"
              aria-label="物品介绍"
            >
              <Info size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className="px-6 py-12 text-center bg-white/5 mx-3 rounded-2xl mt-3">
          <div className="text-5xl mb-2">⏸️</div>
          <div className="text-white font-bold">暂无进行中的拍卖</div>
          <div className="text-white/50 text-xs mt-1">
            {queue.length > 0
              ? `队列里还有 ${queue.length} 场待开拍`
              : (isHost ? '点击下方 "添加拍品" 开始第一场' : '主播还在准备中…')}
          </div>
          {isHost && queue.length > 0 && (
            <button
              onClick={onStartNext}
              className="mt-4 bg-brand-pink text-white font-black px-5 py-2 rounded-full inline-flex items-center gap-1.5"
            >
              <Play size={14} /> 开始下一场
            </button>
          )}
        </div>
      )}

      {/* Description */}
      {room.description && (
        <div className="px-4 py-3 text-white/70 text-sm whitespace-pre-wrap">
          {room.description}
        </div>
      )}

      {/* Queue */}
      <div className="px-4 mt-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-black text-base flex items-center gap-1.5">
            <Clock size={16} className="text-brand-pink" /> 待拍队列 ({queue.length})
          </h3>
          {isHost && room.status === 'open' && (
            <button
              onClick={() => setShowAdd(true)}
              className="bg-brand-pink text-white text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1"
            >
              <Plus size={12} /> 添加拍品
            </button>
          )}
        </div>
        {queue.length === 0 ? (
          <div className="text-white/40 text-xs py-3">暂无待拍</div>
        ) : (
          <div className="space-y-2">
            {queue.map((a, idx) => (
              <QueueRow key={a.id} index={idx} auction={a} />
            ))}
          </div>
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="px-4 mt-5">
          <h3 className="font-black text-base mb-2">已结束 ({history.length})</h3>
          <div className="space-y-2">
            {history.map((a) => (
              <HistoryRow key={a.id} auction={a} />
            ))}
          </div>
        </div>
      )}

      <AnimatePresence>
        {showAdd && (
          <AddAuctionDrawer
            roomId={roomId}
            onClose={() => setShowAdd(false)}
            onSuccess={() => { setShowAdd(false); load() }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showIntro && current?.product && (
          <ItemIntroDrawer
            product={current.product}
            onClose={() => setShowIntro(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function ItemIntroDrawer({ product, onClose }: { product: Product; onClose: () => void }) {
  const images: string[] = (() => {
    try { return JSON.parse(product.images) || [] } catch { return [] }
  })()
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end"
    >
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-brand-dark border-t border-white/10 rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto"
      >
        <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-4" />
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-black text-lg flex items-center gap-2"><Info size={18} /> 物品介绍</h3>
          <button onClick={onClose} className="text-white/50"><X size={18} /></button>
        </div>
        <h2 className="text-white font-black text-base mb-2">{product.title}</h2>
        {product.category && (
          <span className="inline-block bg-white/10 text-white/70 text-xs px-2 py-0.5 rounded-full mb-3">{product.category}</span>
        )}
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar mb-3">
            {images.map((src, i) => (
              <img key={i} src={src} alt="" className="w-32 h-32 object-cover rounded-xl flex-shrink-0" />
            ))}
          </div>
        )}
        {product.description ? (
          <div className="text-white/80 text-sm whitespace-pre-wrap leading-relaxed">{product.description}</div>
        ) : (
          <div className="text-white/40 text-sm">主播暂未填写详细介绍</div>
        )}
      </motion.div>
    </motion.div>
  )
}

function QueueRow({ index, auction }: { index: number; auction: { id: number; product?: Product; start_price: number; duration: number } }) {
  const minutes = Math.round(auction.duration / 60)
  return (
    <div className="flex items-center gap-3 bg-white/5 rounded-xl p-2.5">
      <div className="w-7 h-7 rounded-full bg-brand-pink/20 text-brand-pink text-xs font-bold flex items-center justify-center flex-shrink-0">
        {index + 1}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm font-bold truncate">{auction.product?.title ?? '—'}</div>
        <div className="text-white/40 text-xs">起拍 ¥{auction.start_price} · {minutes} 分钟</div>
      </div>
    </div>
  )
}

function HistoryRow({ auction }: { auction: { id: number; product?: Product; current_price: number; winner?: { username: string } } }) {
  return (
    <div className="flex items-center gap-3 bg-white/5 rounded-xl p-2.5 opacity-70">
      <Package size={20} className="text-white/40 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm truncate">{auction.product?.title ?? '—'}</div>
        <div className="text-white/40 text-xs">
          ¥{auction.current_price.toLocaleString()}
          {auction.winner ? ` · 中标 @${auction.winner.username}` : ' · 流拍'}
        </div>
      </div>
    </div>
  )
}

function AddAuctionDrawer({ roomId, onClose, onSuccess }: { roomId: number; onClose: () => void; onSuccess: () => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [productId, setProductId] = useState<number | null>(null)
  const [startPrice, setStartPrice] = useState('100')
  const [minIncrement, setMinIncrement] = useState('10')
  const [duration, setDuration] = useState('300')
  const [hasBuyNow, setHasBuyNow] = useState(false)
  const [buyNowPrice, setBuyNowPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Inline new-product mode — sellers usually need a fresh product per item.
  const [newMode, setNewMode] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newImages, setNewImages] = useState('')

  useEffect(() => {
    listProducts({ mine: true, status: 'active' })
      .then(setProducts)
      .catch(() => setProducts([]))
  }, [])

  const submit = async () => {
    let pid = productId
    if (newMode) {
      if (!newTitle.trim()) { toast.error('请输入商品标题'); return }
      try {
        const images = newImages.trim()
          ? JSON.stringify(newImages.split(',').map((s) => s.trim()).filter(Boolean))
          : '[]'
        const p = await createProduct({
          title: newTitle, description: '', images, category: newCategory, status: 'active',
        } as Parameters<typeof createProduct>[0])
        pid = p.id
      } catch {
        toast.error('创建商品失败')
        return
      }
    }
    if (!pid) { toast.error('请选择商品'); return }

    const sp = parseFloat(startPrice)
    const mi = parseFloat(minIncrement)
    const d = parseInt(duration)
    if (isNaN(sp) || sp < 0) { toast.error('起拍价无效'); return }
    if (isNaN(mi) || mi <= 0) { toast.error('加价幅度无效'); return }

    let bnp = 0
    if (hasBuyNow) {
      bnp = parseFloat(buyNowPrice)
      if (isNaN(bnp) || bnp <= sp) { toast.error('封顶价必须大于起拍价'); return }
    }

    setSubmitting(true)
    try {
      const res = await addRoomAuction(roomId, {
        product_id: pid,
        start_price: sp,
        min_increment: mi,
        duration: d,
        has_buy_now: hasBuyNow,
        buy_now_price: hasBuyNow ? bnp : undefined,
      })
      toast.success(res.started ? '已直接开拍！' : '已加入队列')
      onSuccess()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '添加失败'
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end"
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-brand-dark border-t border-white/10 rounded-t-3xl p-4 pb-8 max-h-[90vh] overflow-y-auto"
      >
        <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-3" />
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-black text-lg">添加拍品到队列</h3>
          <button onClick={onClose} className="text-white/50"><X size={18} /></button>
        </div>

        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setNewMode(false)}
            className={`flex-1 py-2 rounded-xl text-sm font-bold ${!newMode ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60'}`}
          >
            选择已有商品
          </button>
          <button
            onClick={() => setNewMode(true)}
            className={`flex-1 py-2 rounded-xl text-sm font-bold ${newMode ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60'}`}
          >
            新建商品
          </button>
        </div>

        {newMode ? (
          <div className="space-y-2 mb-3">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="商品标题 *"
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 outline-none"
            />
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="分类（如：潮玩）"
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 outline-none"
            />
            <input
              value={newImages}
              onChange={(e) => setNewImages(e.target.value)}
              placeholder="图片链接（多张用逗号分隔）"
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 outline-none"
            />
          </div>
        ) : (
          <div className="mb-3 max-h-48 overflow-y-auto space-y-1">
            {products.length === 0 ? (
              <div className="text-white/40 text-sm py-4 text-center">还没有可上架的商品，先去新建一个</div>
            ) : products.map((p) => (
              <button
                key={p.id}
                onClick={() => setProductId(p.id)}
                className={`w-full text-left p-2.5 rounded-xl ${productId === p.id ? 'bg-brand-pink/20 ring-1 ring-brand-pink' : 'bg-white/5'}`}
              >
                <div className="text-white text-sm font-bold truncate">{p.title}</div>
                {p.category && <div className="text-white/40 text-xs">{p.category}</div>}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-white/60 text-xs">起拍价 (¥)</label>
            <input
              type="number" value={startPrice} onChange={(e) => setStartPrice(e.target.value)}
              className="w-full bg-white/10 text-white rounded-xl px-3 py-2 mt-1 outline-none"
            />
          </div>
          <div>
            <label className="text-white/60 text-xs">加价幅度 (¥)</label>
            <input
              type="number" value={minIncrement} onChange={(e) => setMinIncrement(e.target.value)}
              className="w-full bg-white/10 text-white rounded-xl px-3 py-2 mt-1 outline-none"
            />
          </div>
        </div>

        <div className="mb-3">
          <label className="text-white/60 text-xs">竞拍时长</label>
          <div className="grid grid-cols-4 gap-2 mt-1">
            {[
              { l: '3分', v: 180 },
              { l: '5分', v: 300 },
              { l: '10分', v: 600 },
              { l: '30分', v: 1800 },
            ].map((o) => (
              <button
                key={o.v}
                onClick={() => setDuration(String(o.v))}
                className={`py-1.5 rounded-lg text-sm font-bold ${parseInt(duration) === o.v ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60'}`}
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2.5 mb-3 cursor-pointer">
          <span className="text-white text-sm">设置封顶价</span>
          <div
            onClick={() => setHasBuyNow(!hasBuyNow)}
            className={`w-10 h-5 rounded-full relative ${hasBuyNow ? 'bg-yellow-500' : 'bg-white/20'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${hasBuyNow ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </div>
        </label>
        {hasBuyNow && (
          <input
            type="number" value={buyNowPrice} onChange={(e) => setBuyNowPrice(e.target.value)}
            placeholder="封顶价 (¥) — 必须大于起拍价"
            className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 mb-3 outline-none"
          />
        )}

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={submit}
          disabled={submitting}
          className="w-full bg-brand-pink text-white font-black py-3 rounded-2xl disabled:opacity-50"
        >
          {submitting ? '添加中...' : '加入队列'}
        </motion.button>
        <div className="text-white/40 text-xs text-center mt-2">
          队列为空时会立即开拍；否则等待前面的拍卖结束后自动接力
        </div>
      </motion.div>
    </motion.div>
  )
}
