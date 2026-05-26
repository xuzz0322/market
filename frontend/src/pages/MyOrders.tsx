import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Package, ChevronLeft, MapPin, Truck, Check, ChevronRight } from 'lucide-react'
import { getMyOrders, setOrderAddress, confirmOrder } from '../services/api'
import type { Order, OrderStatus, ShippingAddress } from '../types'

const tabs: Array<{ key: OrderStatus | ''; label: string }> = [
  { key: '',                  label: '全部' },
  { key: 'pending_address',   label: '待填地址' },
  { key: 'pending_shipment',  label: '待发货' },
  { key: 'shipped',           label: '待收货' },
  { key: 'completed',         label: '已完成' },
]

const statusColors: Record<OrderStatus, string> = {
  pending_address:  'text-orange-400',
  pending_shipment: 'text-blue-400',
  shipped:          'text-cyan-400',
  completed:        'text-green-400',
  cancelled:        'text-red-400',
}

const statusLabels: Record<OrderStatus, string> = {
  pending_address:  '待填收货地址',
  pending_shipment: '商家待发货',
  shipped:          '已发货 — 等待收货',
  completed:        '已完成',
  cancelled:        '已取消',
}

function parseAddress(s?: string): ShippingAddress | null {
  if (!s) return null
  try { return JSON.parse(s) as ShippingAddress } catch { return null }
}

function parseFirstImage(s?: string): string | null {
  if (!s) return null
  try { return (JSON.parse(s) as string[])[0] ?? null } catch { return null }
}

export default function MyOrders() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<OrderStatus | ''>('')
  const [list, setList] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  // Address form modal target
  const [addressTarget, setAddressTarget] = useState<Order | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setList(await getMyOrders(tab || undefined)) }
    catch { toast.error('加载失败') }
    finally { setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [tab])

  const counts = useMemo(() => {
    // Compute per-tab badge counts from the unfiltered list. We only have
    // the current tab's data, so this is approximate — the dot just hints
    // at "you have something here". Real counts would need a separate
    // /orders/counts endpoint.
    return list.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1
      return acc
    }, {})
  }, [list])

  const handleConfirm = async (id: number) => {
    if (!confirm('确认收到货物？确认后货款将释放给商家。')) return
    try {
      await confirmOrder(id)
      toast.success('已确认收货')
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      toast.error(e.response?.data?.error ?? '确认失败')
    }
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-sm border-b border-white/10 px-4 pt-3 pb-2">
        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => navigate(-1)} className="p-1 -ml-1">
            <ChevronLeft size={22} />
          </button>
          <h1 className="font-black text-lg">我的订单</h1>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto no-scrollbar">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                tab === t.key ? 'bg-brand-pink text-white font-bold' : 'bg-white/10 text-white/60'
              }`}
            >
              {t.label}
              {counts[t.key as OrderStatus] > 0 && tab !== t.key && (
                <span className="ml-1 text-xs bg-brand-pink/80 text-white rounded-full px-1.5">{counts[t.key as OrderStatus]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="p-4 space-y-3">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
          </div>
        ) : list.length === 0 ? (
          <div className="text-center py-16 text-white/30">
            <Package size={48} className="mx-auto mb-3 opacity-30" />
            <p>暂无订单</p>
          </div>
        ) : (
          list.map((order) => {
            const addr = parseAddress(order.shipping_address)
            const cover = parseFirstImage(order.product?.images)
            return (
              <motion.div
                key={order.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white/5 rounded-2xl p-3 border border-white/5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/40 font-mono">{order.order_no}</span>
                  <span className={`font-bold ${statusColors[order.status]}`}>
                    {statusLabels[order.status]}
                  </span>
                </div>

                <div className="flex gap-3 mt-2">
                  {cover ? (
                    <img src={cover} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-white/10 flex-shrink-0 flex items-center justify-center">
                      <Package size={20} className="text-white/30" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate">{order.product?.title}</div>
                    <div className="text-white/50 text-xs mt-0.5">卖家：{order.seller?.username}</div>
                    <div className="text-brand-pink font-black mt-1">¥{order.amount.toLocaleString()}</div>
                  </div>
                </div>

                {/* Tracking info if shipped */}
                {order.tracking_no && (
                  <div className="mt-2 text-xs bg-white/5 rounded-lg px-2 py-1.5 flex items-center gap-1.5">
                    <Truck size={12} className="text-cyan-400" />
                    <span className="text-white/70">{order.ship_carrier} · {order.tracking_no}</span>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-3 flex gap-2 justify-end">
                  {order.status === 'pending_address' && (
                    <button
                      onClick={() => setAddressTarget(order)}
                      className="bg-brand-pink text-white text-xs font-bold px-4 py-1.5 rounded-full flex items-center gap-1"
                    >
                      <MapPin size={12} /> 填写地址
                    </button>
                  )}
                  {order.status === 'pending_shipment' && addr && (
                    <button
                      onClick={() => setAddressTarget(order)}
                      className="bg-white/10 text-white/70 text-xs px-4 py-1.5 rounded-full"
                    >
                      修改地址
                    </button>
                  )}
                  {order.status === 'shipped' && (
                    <button
                      onClick={() => handleConfirm(order.id)}
                      className="bg-green-500 text-white text-xs font-bold px-4 py-1.5 rounded-full flex items-center gap-1"
                    >
                      <Check size={12} /> 确认收货
                    </button>
                  )}
                  {order.status === 'completed' && (
                    <span className="text-white/30 text-xs">交易完成</span>
                  )}
                </div>
              </motion.div>
            )
          })
        )}
      </div>

      {/* Address modal */}
      <AnimatePresence>
        {addressTarget && (
          <AddressModal
            order={addressTarget}
            submitting={submitting}
            onClose={() => setAddressTarget(null)}
            onSubmit={async (addr) => {
              setSubmitting(true)
              try {
                await setOrderAddress(addressTarget.id, addr)
                toast.success('地址已保存')
                setAddressTarget(null)
                load()
              } catch (err: unknown) {
                const e = err as { response?: { data?: { error?: string } } }
                toast.error(e.response?.data?.error ?? '保存失败')
              } finally {
                setSubmitting(false)
              }
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function AddressModal({
  order, submitting, onClose, onSubmit,
}: {
  order: Order
  submitting: boolean
  onClose: () => void
  onSubmit: (a: ShippingAddress) => void
}) {
  const existing = parseAddress(order.shipping_address)
  const [addr, setAddr] = useState<ShippingAddress>(existing ?? {
    name: '', phone: '', province: '', city: '', district: '', detail: '',
  })

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center"
      onClick={() => !submitting && onClose()}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-brand-dark border-t border-white/10 rounded-t-3xl p-5 w-full max-w-lg pb-8"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-black text-lg">{existing ? '修改收货地址' : '填写收货地址'}</h3>
          <button onClick={onClose} className="text-white/50 px-2">取消</button>
        </div>

        <div className="space-y-3">
          <input
            value={addr.name}
            onChange={(e) => setAddr({ ...addr, name: e.target.value })}
            placeholder="收货人姓名"
            className="w-full bg-white/10 text-white rounded-xl px-4 py-3 outline-none placeholder-white/40"
          />
          <input
            value={addr.phone}
            onChange={(e) => setAddr({ ...addr, phone: e.target.value })}
            placeholder="手机号"
            inputMode="tel"
            className="w-full bg-white/10 text-white rounded-xl px-4 py-3 outline-none placeholder-white/40"
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              value={addr.province}
              onChange={(e) => setAddr({ ...addr, province: e.target.value })}
              placeholder="省"
              className="bg-white/10 text-white rounded-xl px-3 py-3 outline-none placeholder-white/40"
            />
            <input
              value={addr.city}
              onChange={(e) => setAddr({ ...addr, city: e.target.value })}
              placeholder="市"
              className="bg-white/10 text-white rounded-xl px-3 py-3 outline-none placeholder-white/40"
            />
            <input
              value={addr.district}
              onChange={(e) => setAddr({ ...addr, district: e.target.value })}
              placeholder="区/县"
              className="bg-white/10 text-white rounded-xl px-3 py-3 outline-none placeholder-white/40"
            />
          </div>
          <textarea
            value={addr.detail}
            onChange={(e) => setAddr({ ...addr, detail: e.target.value })}
            placeholder="详细地址（街道、门牌号等）"
            rows={2}
            className="w-full bg-white/10 text-white rounded-xl px-4 py-3 outline-none placeholder-white/40 resize-none"
          />
        </div>

        <button
          onClick={() => {
            if (!addr.name.trim() || !addr.phone.trim() || !addr.detail.trim()) {
              toast.error('姓名 / 手机 / 详细地址为必填')
              return
            }
            onSubmit(addr)
          }}
          disabled={submitting}
          className="w-full mt-5 bg-brand-pink text-white font-black py-3.5 rounded-2xl disabled:opacity-60"
        >
          {submitting ? '保存中...' : '保存地址'}
        </button>
      </motion.div>
    </motion.div>
  )
}
