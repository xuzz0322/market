import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Search as SearchIcon, X, Tag, Zap } from 'lucide-react'
import { searchProducts, type ProductSearchResult } from '../services/api'

const QUICK_CATEGORIES = ['手办', '潮玩', '数码', '球鞋', '腕表', '珠宝', '艺术品', '其他']

export default function Search() {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<string>('')
  const [results, setResults] = useState<ProductSearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<number | undefined>(undefined)

  const runSearch = useCallback(async (q: string, cat: string) => {
    if (!q.trim() && !cat) {
      setResults([])
      setTotal(0)
      setSearched(false)
      return
    }
    setLoading(true)
    try {
      const data = await searchProducts({ q: q.trim() || undefined, category: cat || undefined, limit: 30 })
      setResults(data.products)
      setTotal(data.total)
      setSearched(true)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced search on keyword change. Category click triggers immediately.
  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => runSearch(keyword, category), 300)
    return () => window.clearTimeout(debounceRef.current)
  }, [keyword, category, runSearch])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const parseImages = (s: string): string[] => {
    try { return JSON.parse(s) || [] } catch { return s ? [s] : [] }
  }

  const onResultClick = (p: ProductSearchResult) => {
    if (p.auction_id) {
      navigate(`/auction/${p.auction_id}`)
    }
    // Products without an active auction are display-only — clicking does
    // nothing for now. Future: open a product detail page or "提醒我开拍".
  }

  return (
    <div className="min-h-screen bg-brand-dark pb-20">
      {/* Search bar header */}
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-2.5 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 relative">
          <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            ref={inputRef}
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索商品名称、描述..."
            className="w-full bg-white/10 text-white placeholder-white/40 rounded-full pl-9 pr-9 py-2 text-sm outline-none focus:bg-white/15"
          />
          {keyword && (
            <button
              onClick={() => setKeyword('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Category quick filters */}
      <div className="px-3 py-3 flex gap-2 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setCategory('')}
          className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-bold ${category === '' ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/70'}`}
        >
          全部
        </button>
        {QUICK_CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c === category ? '' : c)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 ${c === category ? 'bg-brand-pink text-white' : 'bg-white/10 text-white/70'}`}
          >
            <Tag size={12} /> {c}
          </button>
        ))}
      </div>

      {/* Result body */}
      {loading && (
        <div className="py-16 flex justify-center">
          <div className="w-7 h-7 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && !searched && (
        <div className="px-6 py-20 text-center text-white/40 text-sm">
          输入关键词或选择分类开始搜索
        </div>
      )}

      {!loading && searched && results.length === 0 && (
        <div className="px-6 py-20 text-center">
          <div className="text-5xl mb-3">🔍</div>
          <div className="text-white/60">没有找到相关商品</div>
          <div className="text-white/30 text-xs mt-1">换个关键词或者类目试试</div>
        </div>
      )}

      {!loading && results.length > 0 && (
        <>
          <div className="px-3 text-white/40 text-xs mb-2">共 {total} 件商品</div>
          <div className="grid grid-cols-2 gap-2 px-3">
            {results.map((p) => {
              const images = parseImages(p.images)
              const cover = images[0] || `https://picsum.photos/seed/p${p.id}/400/400`
              return (
                <motion.div
                  key={p.id}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onResultClick(p)}
                  className={`relative bg-white/5 rounded-xl overflow-hidden ${p.auction_id ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <div className="relative aspect-[4/5]">
                    <img src={cover} alt={p.title} className="w-full h-full object-cover" loading="lazy" />
                    {p.auction_id && (
                      <span className="absolute top-1.5 left-1.5 bg-brand-pink text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                        <Zap size={10} /> 拍卖中
                      </span>
                    )}
                    {p.status === 'active' && !p.auction_id && (
                      <span className="absolute top-1.5 left-1.5 bg-white/20 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        待开拍
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-white text-sm font-bold line-clamp-1">{p.title}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-white/40 text-[10px]">@{p.seller?.username ?? '—'}</span>
                      {p.category && <span className="text-white/40 text-[10px]">{p.category}</span>}
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
