import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import {
  ArrowLeft, ShoppingBag, Store, Package, Truck, Check,
  Clock, TrendingUp, TrendingDown, ChevronRight,
} from 'lucide-react'
import { myBuyHistory, mySellHistory, type BuyHistoryResponse, type SellHistoryResponse } from '../services/api'
import type { Order, OrderStatus } from '../types'

const statusLabels: Record<OrderStatus, string> = {
  pending_address:  '待填地址',
  pending_shipment: '待发货',
  shipped:          '已发货',
  completed:        '已完成',
  cancelled:        '已取消',
}

const statusColors: Record<OrderStatus, string> = {
  pending_address:  'text-orange-400',
  pending_shipment: 'text-blue-400',
  shipped:          'text-cyan-400',
  completed:        'text-emerald-400',
  cancelled:        'text-red-400',
}

const statusIcons: Record<OrderStatus, React.ReactNode> = {
  pending_address:  <Clock size={13} />,
  pending_shipment: <Package size={13} />,
  shipped:          <Truck size={13} />,
  completed:        <Check size={13} />,
  cancelled:        <span className="text-xs">✕</span>,
}

function parseFirstImage(s?: string) {
  if (!s) return null
  try { return (JSON.parse(s) as string[])[0] ?? null } catch { return null }
}

function SummaryCard({
  icon, label, value, sub, accent,
}: { icon: React.ReactNode; label: string; value: string; sub: string; accent: string }) {
  return (
    <div className={`bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-3`}>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${accent}`}>
        {icon}
      </div>
      <div>
        <div className="text-white/50 text-xs">{label}</div>
        <div className="font-black text-white text-lg leading-tight">{value}</div>
        <div className="text-white/40 text-[10px]">{sub}</div>
      </div>
    </div>
  )
}

function OrderRow({ order, role, onDetail }: { order: Order; role: 'buy' | 'sell'; onDetail: (o: Order) => void }) {
  const cover = parseFirstImage(order.product?.images)
  const counterpart = role === 'buy' ? order.seller?.username : order.buyer?.username
  const counterLabel = role === 'buy' ? '卖家' : '买家'
  const st = order.status as OrderStatus

  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={() => onDetail(order)}
      className="w-full text-left bg-white/5 rounded-2xl p-3 border border-white/5 flex items-center gap-3"
    >
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-xl overflow-hidden flex-shrink-0 bg-white/10">
        {cover
          ? <img src={cover} alt="" className="w-full h-full object-cover" />
          : <Package size={20} className="m-auto mt-3 text-white/20" />
        }
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-white font-bold text-sm truncate">{order.product?.title ?? '—'}</div>
        <div className="text-white/40 text-xs mt-0.5">{counterLabel}：{counterpart ?? '—'}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className={`text-xs font-bold flex items-center gap-0.5 ${statusColors[st]}`}>
            {statusIcons[st]} {statusLabels[st]}
          </span>
        </div>
      </div>

      {/* Amount */}
      <div className="flex-shrink-0 text-right">
        <div className={`font-black text-sm ${role === 'buy' ? 'text-brand-pink' : 'text-emerald-400'}`}>
          {role === 'buy' ? '-' : '+'}¥{order.amount.toLocaleString()}
        </div>
        <div className="text-white/30 text-[10px] mt-0.5">
          {new Date(order.created_at).toLocaleDateString('zh-CN')}
        </div>
      </div>
      <ChevronRight size={14} className="text-white/30 flex-shrink-0" />
    </motion.button>
  )
}

type Mode = 'buy' | 'sell'

export default function TradeHistory() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [mode, setMode] = useState<Mode>((params.get('tab') as Mode) ?? 'buy')

  const [buyData, setBuyData] = useState<BuyHistoryResponse | null>(null)
  const [sellData, setSellData] = useState<SellHistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const loadMode = useCallback(async (m: Mode) => {
    setLoading(true)
    try {
      if (m === 'buy' && !buyData) {
        setBuyData(await myBuyHistory())
      } else if (m === 'sell' && !sellData) {
        setSellData(await mySellHistory())
      }
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [buyData, sellData])

  useEffect(() => { loadMode(mode) }, [mode])  // eslint-disable-line react-hooks/exhaustive-deps

  const onDetail = (order: Order) => {
    // Deep-link: pending_address / pending_shipment / shipped → /orders (tab);
    // completed / cancelled → same page, just show the row in context.
    navigate('/orders')
  }

  const orders: Order[] = mode === 'buy'
    ? (buyData?.orders ?? [])
    : (sellData?.orders ?? [])

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-black text-lg flex-1">交易记录</h1>
      </div>

      {/* Mode tabs */}
      <div className="px-4 pt-4 flex gap-2">
        {(['buy', 'sell'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2.5 rounded-2xl font-bold text-sm flex items-center justify-center gap-1.5 transition-colors ${
              mode === m ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60'
            }`}
          >
            {m === 'buy' ? <ShoppingBag size={16} /> : <Store size={16} />}
            {m === 'buy' ? '买入记录' : '卖出记录'}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="px-4 mt-3 grid grid-cols-2 gap-2">
        {mode === 'buy' && buyData && (
          <>
            <SummaryCard
              icon={<TrendingDown size={18} className="text-brand-pink" />}
              label="总花费"
              value={`¥${buyData.total_spent.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`}
              sub="已完成订单合计"
              accent="bg-brand-pink/20"
            />
            <SummaryCard
              icon={<ShoppingBag size={18} className="text-orange-400" />}
              label="购买件数"
              value={`${buyData.completed_count}`}
              sub={`共 ${buyData.total_count} 笔订单`}
              accent="bg-orange-500/20"
            />
          </>
        )}
        {mode === 'sell' && sellData && (
          <>
            <SummaryCard
              icon={<TrendingUp size={18} className="text-emerald-400" />}
              label="总收入"
              value={`¥${sellData.total_earned.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`}
              sub="已完成订单合计"
              accent="bg-emerald-500/20"
            />
            <SummaryCard
              icon={<Store size={18} className="text-cyan-400" />}
              label="卖出件数"
              value={`${sellData.completed_count}`}
              sub={`共 ${sellData.total_count} 笔订单`}
              accent="bg-cyan-500/20"
            />
          </>
        )}
      </div>

      {/* Order list */}
      <div className="px-4 mt-4">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
          </div>
        ) : orders.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-5xl mb-3">{mode === 'buy' ? '🛍️' : '🏷️'}</div>
            <div className="text-white/50">{mode === 'buy' ? '还没有买入记录' : '还没有卖出记录'}</div>
            <button
              onClick={() => navigate(mode === 'buy' ? '/' : '/create')}
              className="mt-4 bg-brand-pink text-white font-bold px-5 py-2 rounded-full text-sm"
            >
              {mode === 'buy' ? '去逛逛拍卖' : '发起拍卖'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} role={mode} onDetail={onDetail} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
