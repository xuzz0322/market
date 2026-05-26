import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { motion, AnimatePresence } from 'framer-motion'
import { Package, Clock, DollarSign, TrendingUp, Crown, Zap } from 'lucide-react'
import { createProduct, createAuction, startAuction } from '../services/api'

export default function CreateAuction() {
  const navigate = useNavigate()
  const [step, setStep] = useState<'product' | 'auction'>('product')
  const [loading, setLoading] = useState(false)

  // Product form
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [imagesInput, setImagesInput] = useState('')

  // Auction form
  const [productId, setProductId] = useState<number | null>(null)
  const [startPrice, setStartPrice] = useState('100')
  const [zeroStart, setZeroStart] = useState(false)
  const [minIncrement, setMinIncrement] = useState('10')
  const [hasBuyNow, setHasBuyNow] = useState(false)
  const [buyNowPrice, setBuyNowPrice] = useState('')
  const [duration, setDuration] = useState('300')
  const [autoStart, setAutoStart] = useState(true)

  const categories = ['电子', '时尚', '美妆', '家居', '收藏品', '珠宝', '艺术', '其他']
  const durationOptions = [
    { label: '5分钟', value: 300 },
    { label: '10分钟', value: 600 },
    { label: '30分钟', value: 1800 },
    { label: '1小时', value: 3600 },
    { label: '3小时', value: 10800 },
    { label: '24小时', value: 86400 },
  ]
  // Common bid increments. Pick one that suits the price band; users can
  // also type a custom value in the input below.
  const incrementPresets = [1, 5, 10, 50, 100, 500, 1000]

  const handleCreateProduct = async () => {
    if (!title.trim()) { toast.error('请输入商品标题'); return }
    setLoading(true)
    try {
      const images = imagesInput.trim()
        ? JSON.stringify(imagesInput.split(',').map(s => s.trim()).filter(Boolean))
        : '[]'
      const product = await createProduct({ title, description, category, images, status: 'active' } as Parameters<typeof createProduct>[0])
      setProductId(product.id)
      setStep('auction')
      toast.success('商品创建成功！')
    } catch {
      toast.error('创建商品失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateAuction = async () => {
    if (!productId) return
    const sp = zeroStart ? 0 : parseFloat(startPrice)
    const mi = parseFloat(minIncrement)
    const d = parseInt(duration)
    if (isNaN(sp) || sp < 0) { toast.error('起拍价不能为负数'); return }
    if (isNaN(mi) || mi <= 0) { toast.error('请输入有效最低加价幅度'); return }

    let bnp = 0
    if (hasBuyNow) {
      bnp = parseFloat(buyNowPrice)
      if (isNaN(bnp) || bnp <= sp) {
        toast.error('封顶价必须大于起拍价')
        return
      }
    }

    setLoading(true)
    try {
      const auction = await createAuction({
        product_id: productId,
        start_price: sp,
        min_increment: mi,
        has_buy_now: hasBuyNow,
        buy_now_price: hasBuyNow ? bnp : undefined,
        duration: d,
      })

      if (autoStart) {
        await startAuction(auction.id)
        toast.success('拍卖已开始！')
      } else {
        toast.success('拍卖创建成功！')
      }

      navigate('/')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '创建失败'
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white">
      {/* Header */}
      <div className="sticky top-0 bg-brand-dark/95 backdrop-blur-sm border-b border-white/10 px-4 py-3 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-white/60 hover:text-white">←</button>
          <h1 className="font-black text-lg">{step === 'product' ? '上架商品' : '配置拍卖'}</h1>
        </div>
        {/* Step indicator */}
        <div className="flex gap-2 mt-2">
          {(['product', 'auction'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step === s || (s === 'product' && productId) ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/40'}`}>
                {i + 1}
              </div>
              <span className={`text-xs ${step === s ? 'text-white' : 'text-white/40'}`}>
                {s === 'product' ? '商品信息' : '拍卖规则'}
              </span>
              {i === 0 && <span className="text-white/20 text-xs mx-1">→</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-4 max-w-lg mx-auto">
        {step === 'product' ? (
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            <div className="bg-white/5 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-brand-pink font-bold mb-2">
                <Package size={18} /> 商品信息
              </div>

              <div>
                <label className="text-white/60 text-sm">商品标题 *</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例：限量版 Air Jordan 1 US10"
                  className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none placeholder-white/30 focus:ring-1 focus:ring-brand-pink"
                />
              </div>

              <div>
                <label className="text-white/60 text-sm">商品描述</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述商品的品牌、成色、包装等信息..."
                  rows={3}
                  className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none placeholder-white/30 resize-none focus:ring-1 focus:ring-brand-pink"
                />
              </div>

              <div>
                <label className="text-white/60 text-sm">分类</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {categories.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${category === c ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-white/60 text-sm">图片链接（多个用逗号分隔）</label>
                <input
                  value={imagesInput}
                  onChange={(e) => setImagesInput(e.target.value)}
                  placeholder="https://example.com/img1.jpg, https://..."
                  className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none placeholder-white/30 focus:ring-1 focus:ring-brand-pink"
                />
              </div>
            </div>

            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleCreateProduct}
              disabled={loading}
              className="w-full bg-brand-pink text-white font-black py-4 rounded-2xl text-lg disabled:opacity-50"
            >
              {loading ? '创建中...' : '下一步：配置拍卖 →'}
            </motion.button>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            <div className="bg-white/5 rounded-2xl p-4 space-y-4">
              <div className="flex items-center gap-2 text-brand-pink font-bold mb-2">
                <DollarSign size={18} /> 起拍价
              </div>

              {/* 0元起拍 toggle — high-conversion option for sellers willing
                  to let the market set the price from scratch */}
              <label className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2.5 cursor-pointer">
                <div className="flex items-center gap-2">
                  <Zap size={16} className="text-yellow-400" />
                  <div>
                    <div className="text-white font-medium text-sm">0元起拍</div>
                    <div className="text-white/40 text-xs">让市场决定价格，吸引更多围观</div>
                  </div>
                </div>
                <div
                  onClick={() => setZeroStart(!zeroStart)}
                  className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${zeroStart ? 'bg-brand-pink' : 'bg-white/20'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${zeroStart ? 'translate-x-7' : 'translate-x-1'}`} />
                </div>
              </label>

              <AnimatePresence initial={false}>
                {!zeroStart && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <label className="text-white/60 text-sm">起拍价 (¥)</label>
                    <input
                      type="number"
                      value={startPrice}
                      onChange={(e) => setStartPrice(e.target.value)}
                      min={0}
                      className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none focus:ring-1 focus:ring-brand-pink"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="bg-white/5 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-brand-pink font-bold mb-2">
                <TrendingUp size={18} /> 加价幅度
              </div>
              <div className="text-white/40 text-xs">每次出价至少高于当前价多少元</div>

              <div className="grid grid-cols-4 gap-2">
                {incrementPresets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMinIncrement(String(v))}
                    className={`py-2 rounded-xl text-sm font-bold transition-colors ${parseFloat(minIncrement) === v ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    +¥{v}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-white/60 text-sm">自定义幅度 (¥)</label>
                <input
                  type="number"
                  value={minIncrement}
                  onChange={(e) => setMinIncrement(e.target.value)}
                  min={0.01}
                  step={0.01}
                  className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none focus:ring-1 focus:ring-brand-pink"
                />
              </div>
            </div>

            <div className="bg-white/5 rounded-2xl p-4 space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-2">
                  <Crown size={18} className="text-yellow-400" />
                  <div>
                    <div className="text-white font-bold">设置封顶价（一口价）</div>
                    <div className="text-white/40 text-xs">达到此价格立即成交，结束拍卖</div>
                  </div>
                </div>
                <div
                  onClick={() => setHasBuyNow(!hasBuyNow)}
                  className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${hasBuyNow ? 'bg-yellow-500' : 'bg-white/20'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${hasBuyNow ? 'translate-x-7' : 'translate-x-1'}`} />
                </div>
              </label>

              <AnimatePresence initial={false}>
                {hasBuyNow && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <label className="text-white/60 text-sm">封顶价 (¥) — 必须大于起拍价</label>
                    <input
                      type="number"
                      value={buyNowPrice}
                      onChange={(e) => setBuyNowPrice(e.target.value)}
                      placeholder="例如 5000"
                      min={0}
                      className="w-full bg-white/10 text-white rounded-xl px-3 py-2.5 mt-1 outline-none placeholder-white/30 focus:ring-1 focus:ring-yellow-500"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="bg-white/5 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-brand-pink font-bold mb-2">
                <Clock size={18} /> 竞拍时长
              </div>
              <div className="grid grid-cols-3 gap-2">
                {durationOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDuration(String(opt.value))}
                    className={`py-2 rounded-xl text-sm font-bold transition-colors ${parseInt(duration) === opt.value ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/60'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white/5 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-brand-pink font-bold mb-3">
                <TrendingUp size={18} /> 开始方式
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => setAutoStart(!autoStart)}
                  className={`w-12 h-6 rounded-full transition-colors relative ${autoStart ? 'bg-brand-pink' : 'bg-white/20'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${autoStart ? 'translate-x-7' : 'translate-x-1'}`} />
                </div>
                <div>
                  <div className="text-white font-medium">立即开始竞拍</div>
                  <div className="text-white/50 text-xs">创建后自动开始，关闭则需要手动开始</div>
                </div>
              </label>
            </div>

            {/* Preview */}
            <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
              <div className="text-white/60 text-sm mb-2">预览</div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">起拍价</span>
                <span className={`font-bold ${zeroStart ? 'text-yellow-400' : 'text-white'}`}>
                  {zeroStart ? '⚡ 0元起拍' : `¥${startPrice || 0}`}
                </span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-white/60">每次加价</span>
                <span className="text-white font-bold">+¥{minIncrement || 0}</span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-white/60">封顶价</span>
                <span className={`font-bold ${hasBuyNow ? 'text-yellow-400' : 'text-white/40'}`}>
                  {hasBuyNow ? `👑 ¥${buyNowPrice || 0}` : '不设置'}
                </span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-white/60">竞拍时长</span>
                <span className="text-white font-bold">{durationOptions.find(d => parseInt(duration) === d.value)?.label || duration + '秒'}</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep('product')} className="flex-1 bg-white/10 text-white font-bold py-3.5 rounded-2xl">
                ← 返回
              </button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleCreateAuction}
                disabled={loading}
                className="flex-[2] bg-brand-pink text-white font-black py-3.5 rounded-2xl text-base disabled:opacity-50"
              >
                {loading ? '创建中...' : autoStart ? '🚀 立即开拍！' : '✓ 创建拍卖'}
              </motion.button>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}
