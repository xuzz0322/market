import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ShieldCheck, ShieldAlert, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { myCredit, type CreditEvent } from '../services/api'

interface CreditState {
  score: number
  min_to_bid: number
  max_score: number
  can_bid: boolean
  events: CreditEvent[]
}

const REASON_LABEL: Record<string, string> = {
  order_completed: '交易完成',
  order_shipped: '订单发货',
  seller_cancelled: '取消活跃拍卖',
  admin_adjust: '管理员调整',
  new_user_bonus: '新用户奖励',
}

export default function CreditPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<CreditState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    myCredit()
      .then(setData)
      .catch(() => toast.error('加载失败'))
      .finally(() => setLoading(false))
  }, [])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-brand-dark flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Visual band: 0..min(red), min..100(yellow), 100..max(green). Mirror
  // the threshold language users will see across the app.
  const band: 'red' | 'yellow' | 'green' =
    data.score < data.min_to_bid ? 'red'
    : data.score < 100 ? 'yellow'
    : 'green'
  const bandColors = {
    red:    { ring: 'ring-red-500',    text: 'text-red-400',    bar: 'bg-red-500' },
    yellow: { ring: 'ring-yellow-500', text: 'text-yellow-400', bar: 'bg-yellow-500' },
    green:  { ring: 'ring-emerald-500', text: 'text-emerald-400', bar: 'bg-emerald-500' },
  }[band]

  // Bar fill: percentage relative to 0..max_score scale.
  const fillPct = Math.max(0, Math.min(100, (data.score / data.max_score) * 100))

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-black text-lg">信用分</h1>
      </div>

      {/* Score card */}
      <div className="px-4 pt-5">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className={`bg-gradient-to-br from-white/10 to-white/5 border border-white/10 rounded-3xl p-5 ring-1 ${bandColors.ring}`}
        >
          <div className="flex items-center gap-2 text-white/60 text-xs">
            {band === 'red' ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
            当前信用分
          </div>
          <div className={`text-5xl font-black mt-1 ${bandColors.text}`}>{data.score}</div>
          <div className="text-white/40 text-xs mt-0.5">满分 {data.max_score} · 出价门槛 {data.min_to_bid}</div>

          {/* Progress bar */}
          <div className="mt-4 relative h-2 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${fillPct}%` }}
              transition={{ duration: 0.6 }}
              className={`absolute inset-y-0 left-0 ${bandColors.bar}`}
            />
            {/* Threshold marker */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white/60"
              style={{ left: `${(data.min_to_bid / data.max_score) * 100}%` }}
              title={`出价门槛 ${data.min_to_bid}`}
            />
          </div>

          {/* Status pill */}
          <div className={`mt-4 inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${
            data.can_bid ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
          }`}>
            {data.can_bid ? '✓ 可正常参与拍卖' : '✕ 暂时无法参与拍卖'}
          </div>

          {!data.can_bid && (
            <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-red-100/90 text-xs leading-relaxed">
                你的信用分低于 {data.min_to_bid}。完成已发货订单的"确认收货"可以恢复信用分。
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* Rules card */}
      <div className="px-4 mt-5">
        <h3 className="font-bold text-sm text-white/70 mb-2">规则说明</h3>
        <div className="bg-white/5 rounded-2xl p-4 text-white/80 text-sm space-y-2 leading-relaxed">
          <div>· <span className="text-emerald-400">+5</span> 买家确认收货</div>
          <div>· <span className="text-emerald-400">+3</span> 卖家订单成交完成</div>
          <div>· <span className="text-red-400">-5</span> 卖家中途取消有人出价的拍卖</div>
          <div className="text-white/40 text-xs pt-1">分数自动 clamp 在 0 ~ {data.max_score} 之间。</div>
        </div>
      </div>

      {/* History */}
      <div className="px-4 mt-5">
        <h3 className="font-bold text-sm text-white/70 mb-2">变更记录</h3>
        {data.events.length === 0 ? (
          <div className="text-white/30 text-xs py-4 text-center">还没有信用分记录</div>
        ) : (
          <div className="space-y-2">
            {data.events.map((e) => (
              <div key={e.id} className="bg-white/5 rounded-xl p-3 flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  e.delta > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                }`}>
                  {e.delta > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm">
                    {REASON_LABEL[e.reason] ?? e.reason}
                    {e.note && <span className="text-white/40"> · {e.note}</span>}
                  </div>
                  <div className="text-white/40 text-[10px]">
                    {new Date(e.created_at).toLocaleString('zh-CN')} · 调整后 {e.after}
                  </div>
                </div>
                <div className={`font-black text-sm ${e.delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {e.delta > 0 ? '+' : ''}{e.delta}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
