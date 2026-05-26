import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Trophy, Package, ChevronRight, LogOut, Wallet, X, AlertTriangle } from 'lucide-react'
import { getMe, listAuctions, startAuction, cancelAuction } from '../services/api'
import { useAuthStore } from '../services/store'
import type { Auction } from '../types'
import wsClient from '../services/websocket'

export default function Profile() {
  const navigate = useNavigate()
  const { user, clearAuth, updateUser } = useAuthStore()
  const [myAuctions, setMyAuctions] = useState<Auction[]>([])
  const [loading, setLoading] = useState(true)
  // Cancel dialog state — keyed by auctionId so the modal knows which row
  // it's targeting; null means closed.
  const [cancelTarget, setCancelTarget] = useState<Auction | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [freshUser, auctions] = await Promise.all([
          getMe(),
          listAuctions({ status: 'all' }),
        ])
        updateUser(freshUser)
        setMyAuctions(auctions.filter((a) => a.seller_id === freshUser.id))
      } catch {
        toast.error('加载失败')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const handleStartAuction = async (id: number) => {
    try {
      await startAuction(id)
      toast.success('拍卖已开始！')
      setMyAuctions((prev) => prev.map((a) => a.id === id ? { ...a, status: 'active' } : a))
    } catch {
      toast.error('开始失败')
    }
  }

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return
    if (!cancelReason.trim()) {
      toast.error('请填写取消原因')
      return
    }
    setCancelling(true)
    try {
      await cancelAuction(cancelTarget.id, cancelReason.trim())
      toast.success('拍卖已取消')
      setMyAuctions((prev) =>
        prev.map((a) => a.id === cancelTarget.id ? { ...a, status: 'cancelled', cancel_reason: cancelReason.trim() } : a)
      )
      setCancelTarget(null)
      setCancelReason('')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '取消失败'
      toast.error(msg)
    } finally {
      setCancelling(false)
    }
  }

  const handleLogout = () => {
    wsClient.disconnect()
    clearAuth()
    navigate('/login')
  }

  const statusLabel: Record<string, { label: string; color: string }> = {
    pending: { label: '待开始', color: 'text-yellow-400' },
    active: { label: '进行中', color: 'text-green-400' },
    ended: { label: '已结束', color: 'text-white/40' },
    cancelled: { label: '已取消', color: 'text-red-400' },
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      {/* Header */}
      <div className="bg-gradient-to-b from-black/50 to-transparent px-4 pt-12 pb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center text-white font-black text-2xl">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div>
              <h2 className="font-black text-xl">{user?.username}</h2>
              <p className="text-white/50 text-sm">{user?.email}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="text-white/50 hover:text-white">
            <LogOut size={20} />
          </button>
        </div>

        {/* Balance card */}
        <div className="mt-4 bg-gradient-to-r from-brand-pink/30 to-orange-500/30 rounded-2xl p-4 border border-brand-pink/30">
          <div className="flex items-center gap-2 text-white/70 text-sm mb-1">
            <Wallet size={14} /> 账户余额
          </div>
          <div className="text-3xl font-black text-white">
            ¥{(user?.balance ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {/* Quick action — My Orders. Sits above "我的拍卖" because for a
          typical buyer this is the screen they actually need. */}
      <div className="px-4 mb-4">
        <button
          onClick={() => navigate('/orders')}
          className="w-full bg-gradient-to-r from-brand-pink/20 to-orange-500/20 border border-brand-pink/30 rounded-2xl p-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-pink/20 flex items-center justify-center">
              <Package size={20} className="text-brand-pink" />
            </div>
            <div className="text-left">
              <div className="font-bold">我的订单</div>
              <div className="text-white/40 text-xs">查看竞拍成功的订单 / 物流</div>
            </div>
          </div>
          <ChevronRight size={20} className="text-white/40" />
        </button>
      </div>

      {/* My auctions */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-base flex items-center gap-2"><Package size={16} /> 我的拍卖</h3>
          <button
            onClick={() => navigate('/create')}
            className="text-brand-pink text-sm font-bold flex items-center gap-1"
          >
            + 发起拍卖
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
          </div>
        ) : myAuctions.length === 0 ? (
          <div className="text-center py-12 text-white/30">
            <Package size={40} className="mx-auto mb-3 opacity-30" />
            <p>还没有拍卖</p>
            <button
              onClick={() => navigate('/create')}
              className="mt-3 bg-brand-pink text-white px-6 py-2 rounded-full text-sm font-bold"
            >
              发起第一场拍卖
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {myAuctions.map((auction) => {
              const st = statusLabel[auction.status] ?? { label: auction.status, color: 'text-white/50' }
              return (
                <motion.div
                  key={auction.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white/5 rounded-2xl p-4 border border-white/5"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-14 h-14 rounded-xl bg-white/10 flex-shrink-0 overflow-hidden">
                      {(() => {
                        try {
                          const imgs = JSON.parse(auction.product?.images || '[]')
                          return imgs[0] ? <img src={imgs[0]} className="w-full h-full object-cover" /> : <Package size={24} className="m-auto mt-2 text-white/30" />
                        } catch {
                          return <Package size={24} className="m-auto mt-2 text-white/30" />
                        }
                      })()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm truncate">{auction.product?.title}</h4>
                        <span className={`text-xs font-bold ${st.color}`}>{st.label}</span>
                      </div>
                      <div className="flex gap-4 mt-2 text-xs text-white/50">
                        <span className="flex items-center gap-1"><Trophy size={11} /> {auction.bid_count} 次出价</span>
                        <span>当前 ¥{auction.current_price.toLocaleString()}</span>
                      </div>
                      {auction.status === 'pending' && (
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => handleStartAuction(auction.id)}
                            className="bg-brand-pink text-white text-xs font-bold px-3 py-1.5 rounded-lg"
                          >
                            开始竞拍
                          </button>
                          <button
                            onClick={() => setCancelTarget(auction)}
                            className="bg-white/10 text-white/70 text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1"
                          >
                            <X size={12} /> 取消
                          </button>
                        </div>
                      )}
                      {auction.status === 'active' && (
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => navigate(`/auction/${auction.id}`)}
                            className="bg-white/10 text-white text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1"
                          >
                            查看直播 <ChevronRight size={12} />
                          </button>
                          <button
                            onClick={() => setCancelTarget(auction)}
                            className="bg-red-500/20 text-red-400 text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1"
                          >
                            <AlertTriangle size={12} /> 异常取消
                          </button>
                        </div>
                      )}
                      {auction.status === 'cancelled' && auction.cancel_reason && (
                        <div className="mt-2 text-xs text-red-400/80 bg-red-500/10 rounded-lg px-2 py-1">
                          已取消：{auction.cancel_reason}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}
      </div>

      {/* Cancel confirmation modal — destructive, so we require a typed
          reason rather than a single confirm click. The reason is shown
          to bidders so they understand why the auction disappeared. */}
      <AnimatePresence>
        {cancelTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center px-4 pb-24 sm:pb-0"
            onClick={() => !cancelling && setCancelTarget(null)}
          >
            <motion.div
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 60, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-brand-dark border border-white/10 rounded-2xl p-5 w-full max-w-sm"
            >
              <div className="flex items-center gap-2 text-red-400 mb-3">
                <AlertTriangle size={20} />
                <h3 className="font-black text-lg">异常取消拍卖</h3>
              </div>
              <p className="text-white/60 text-sm mb-2">
                《{cancelTarget.product?.title}》将立即停止竞拍。
                {cancelTarget.bid_count > 0 && (
                  <span className="text-yellow-400">
                    {' '}已有 {cancelTarget.bid_count} 次出价，所有竞拍者将收到通知。
                  </span>
                )}
              </p>
              <label className="text-white/60 text-sm">取消原因（必填，会展示给竞拍者）</label>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="例如：商品出现质量问题 / 描述有误 / 物品丢失..."
                rows={3}
                maxLength={500}
                className="w-full bg-white/10 text-white rounded-xl px-3 py-2 mt-1 outline-none placeholder-white/30 resize-none focus:ring-1 focus:ring-red-500"
              />
              <div className="text-right text-white/30 text-xs mt-0.5">{cancelReason.length}/500</div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => { setCancelTarget(null); setCancelReason('') }}
                  disabled={cancelling}
                  className="flex-1 bg-white/10 text-white font-bold py-3 rounded-xl"
                >
                  保留拍卖
                </button>
                <button
                  onClick={handleConfirmCancel}
                  disabled={cancelling || !cancelReason.trim()}
                  className="flex-1 bg-red-500 text-white font-bold py-3 rounded-xl disabled:opacity-50"
                >
                  {cancelling ? '取消中...' : '确认取消'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
