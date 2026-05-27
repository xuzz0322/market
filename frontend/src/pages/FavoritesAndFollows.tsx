import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Heart, Users, Radio } from 'lucide-react'
import toast from 'react-hot-toast'
import { myFavorites, myFollows, type FollowedHost } from '../services/api'
import type { Auction } from '../types'

type Tab = 'favorites' | 'follows'

export default function FavoritesAndFollows() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('favorites')
  const [favorites, setFavorites] = useState<Auction[]>([])
  const [follows, setFollows] = useState<FollowedHost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const fetcher = tab === 'favorites' ? myFavorites() : myFollows()
    fetcher
      .then((data) => {
        if (tab === 'favorites') setFavorites(data as Auction[])
        else setFollows(data as FollowedHost[])
      })
      .catch(() => toast.error('加载失败'))
      .finally(() => setLoading(false))
  }, [tab])

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 flex bg-white/5 rounded-full p-1">
          <TabButton active={tab === 'favorites'} onClick={() => setTab('favorites')}>
            <Heart size={14} /> 收藏
          </TabButton>
          <TabButton active={tab === 'follows'} onClick={() => setTab('follows')}>
            <Users size={14} /> 关注
          </TabButton>
        </div>
      </div>

      {loading ? (
        <div className="py-16 flex justify-center">
          <div className="w-7 h-7 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        </div>
      ) : tab === 'favorites' ? (
        favorites.length === 0 ? (
          <Empty emoji="💔" title="还没有收藏" sub="在拍卖间点 ❤ 把喜欢的拍品收下来" />
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3">
            {favorites.map((a) => <FavoriteCard key={a.id} auction={a} onClick={() => navigate(`/auction/${a.id}`)} />)}
          </div>
        )
      ) : (
        follows.length === 0 ? (
          <Empty emoji="👋" title="还没有关注的主播" sub="在拍卖间点头像旁的 +关注 来订阅开播提醒" />
        ) : (
          <div className="divide-y divide-white/5">
            {follows.map((h) => <FollowRow key={h.id} host={h} onClick={() => navigate(`/`)} />)}
          </div>
        )
      )}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-1.5 rounded-full text-sm font-bold flex items-center justify-center gap-1 transition-colors ${active ? 'bg-brand-pink text-white' : 'text-white/60'}`}
    >
      {children}
    </button>
  )
}

function Empty({ emoji, title, sub }: { emoji: string; title: string; sub: string }) {
  return (
    <div className="px-6 py-20 text-center">
      <div className="text-5xl mb-3">{emoji}</div>
      <div className="text-white/70">{title}</div>
      <div className="text-white/30 text-xs mt-1">{sub}</div>
    </div>
  )
}

function FavoriteCard({ auction, onClick }: { auction: Auction; onClick: () => void }) {
  let img = ''
  try {
    const arr = JSON.parse(auction.product?.images || '[]')
    img = Array.isArray(arr) ? arr[0] : ''
  } catch { /* ignore */ }
  if (!img) img = `https://picsum.photos/seed/fav${auction.id}/400/500`
  const ended = auction.status === 'ended' || auction.status === 'cancelled'
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="text-left bg-white/5 rounded-xl overflow-hidden"
    >
      <div className="relative aspect-[4/5]">
        <img src={img} alt={auction.product?.title} className={`w-full h-full object-cover ${ended ? 'opacity-50' : ''}`} loading="lazy" />
        <span className="absolute top-1.5 left-1.5 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
          <Heart size={10} fill="currentColor" />
        </span>
        {auction.status === 'active' && (
          <span className="absolute top-1.5 right-1.5 bg-brand-pink text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">直播中</span>
        )}
        {ended && (
          <span className="absolute top-1.5 right-1.5 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">已结束</span>
        )}
      </div>
      <div className="p-2">
        <div className="text-white text-sm font-bold line-clamp-1">{auction.product?.title}</div>
        <div className="text-brand-pink text-sm font-black mt-0.5">¥{auction.current_price.toLocaleString()}</div>
      </div>
    </motion.button>
  )
}

function FollowRow({ host, onClick }: { host: FollowedHost; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 hover:bg-white/5 text-left"
    >
      <div className="relative">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center text-white font-bold text-lg">
          {host.username[0]?.toUpperCase()}
        </div>
        {host.live && (
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-red-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
            <Radio size={8} /> LIVE
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-white font-bold truncate">@{host.username}</div>
        <div className={`text-xs ${host.live ? 'text-red-400' : 'text-white/40'}`}>
          {host.live ? '正在直播 — 点击围观' : '不在线'}
        </div>
      </div>
    </button>
  )
}
