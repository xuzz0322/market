import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Plus, Radio, Users, Flame, LayoutGrid, ListOrdered } from 'lucide-react'
import { listRooms, listHotRooms, createRoom } from '../services/api'
import type { AuctionRoom, WSMessage } from '../types'
import wsClient from '../services/websocket'

type SortMode = 'hot' | 'new'

export default function Rooms() {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<AuctionRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('hot')
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [coverURL, setCoverURL] = useState('')

  const load = useCallback(async (mode: SortMode) => {
    setLoading(true)
    try {
      setRooms(mode === 'hot' ? await listHotRooms(50) : await listRooms({ limit: 50 }))
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(sortMode) }, [sortMode, load])

  // Live reorder on WS heat_update — apply the new ranking to the
  // current rooms list without a full reload (avoids flash / scroll jump).
  useEffect(() => {
    if (sortMode !== 'hot') return
    const off = wsClient.on('heat_update', (msg: WSMessage) => {
      const data = msg.data as Array<{ room_id: number; score: number }> | undefined
      if (!data) return
      setRooms((prev) => {
        const scoreMap = new Map(data.map((d) => [d.room_id, d.score]))
        // Update heat_score on known rooms, then re-sort.
        const updated = prev.map((r) =>
          scoreMap.has(r.id) ? { ...r, heat_score: scoreMap.get(r.id)! } : r
        )
        updated.sort((a, b) => (b.heat_score ?? 0) - (a.heat_score ?? 0))
        return updated
      })
    })
    return off
  }, [sortMode])

  const onCreate = async () => {
    if (!title.trim()) { toast.error('请填写拍卖间标题'); return }
    setCreating(true)
    try {
      const room = await createRoom({ title: title.trim(), description, cover_url: coverURL })
      toast.success('拍卖间已创建')
      navigate(`/rooms/${room.id}`)
    } catch {
      toast.error('创建失败')
    } finally {
      setCreating(false)
    }
  }

  // Heat badge color — mirrors 3-band system used elsewhere in the app.
  const heatColor = (score: number) =>
    score >= 60 ? 'text-red-400' : score >= 20 ? 'text-orange-400' : 'text-white/40'

  const heatLabel = (score: number) => {
    if (score >= 100) return '🔥 超火'
    if (score >= 60)  return '热'
    if (score >= 20)  return '暖'
    return null
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-black text-lg flex-1">拍卖间</h1>

        {/* Sort toggle */}
        <div className="flex gap-1 bg-white/10 rounded-full p-0.5">
          <button
            onClick={() => setSortMode('hot')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${
              sortMode === 'hot' ? 'bg-brand-pink text-white' : 'text-white/60'
            }`}
          >
            <Flame size={12} /> 热度
          </button>
          <button
            onClick={() => setSortMode('new')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${
              sortMode === 'new' ? 'bg-brand-pink text-white' : 'text-white/60'
            }`}
          >
            <ListOrdered size={12} /> 最新
          </button>
        </div>

        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1.5 bg-brand-pink text-white text-sm font-bold rounded-full flex items-center gap-1"
        >
          <Plus size={14} /> 新建
        </button>
      </div>

      {showCreate && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="overflow-hidden border-b border-white/10"
        >
          <div className="p-4 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="拍卖间标题（如：老王的潮玩拍卖间）"
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 outline-none"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="介绍下这个拍卖间..."
              rows={2}
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 resize-none outline-none"
            />
            <input
              value={coverURL}
              onChange={(e) => setCoverURL(e.target.value)}
              placeholder="封面图链接（可选）"
              className="w-full bg-white/10 text-white placeholder-white/30 rounded-xl px-3 py-2.5 outline-none"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowCreate(false)} className="flex-1 bg-white/10 text-white font-bold py-2.5 rounded-xl">取消</button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={onCreate}
                disabled={creating}
                className="flex-[2] bg-brand-pink text-white font-black py-2.5 rounded-xl disabled:opacity-50"
              >
                {creating ? '创建中...' : '创建拍卖间'}
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}

      {loading ? (
        <div className="py-16 flex justify-center">
          <div className="w-7 h-7 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rooms.length === 0 ? (
        <div className="px-6 py-20 text-center">
          <div className="text-5xl mb-3">🎪</div>
          <div className="text-white/60">还没有人开拍卖间</div>
          <div className="text-white/30 text-xs mt-1">点击右上角 "新建" 来开一个</div>
        </div>
      ) : (
        <div className="p-3 grid grid-cols-2 gap-3">
          {rooms.map((r, idx) => {
            const live = !!r.current_auction_id
            const label = heatLabel(r.heat_score ?? 0)
            return (
              <motion.button
                key={r.id}
                layout
                whileTap={{ scale: 0.97 }}
                onClick={() => navigate(`/rooms/${r.id}`)}
                className="text-left bg-white/5 rounded-2xl overflow-hidden"
              >
                <div className="relative aspect-[4/5]">
                  <img
                    src={r.cover_url || `https://picsum.photos/seed/room${r.id}/400/500`}
                    alt={r.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

                  {/* Top badges row */}
                  <div className="absolute top-1.5 left-1.5 right-1.5 flex items-start justify-between">
                    <div className="flex flex-col gap-1">
                      {live && (
                        <span className="bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 animate-pulse w-fit">
                          <Radio size={10} /> LIVE
                        </span>
                      )}
                      {label && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full w-fit bg-black/50 ${heatColor(r.heat_score ?? 0)}`}>
                          {label}
                        </span>
                      )}
                    </div>
                    {/* Rank badge — shown in hot sort mode */}
                    {sortMode === 'hot' && (
                      <span className="bg-black/60 text-white/80 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        #{idx + 1}
                      </span>
                    )}
                  </div>

                  <div className="absolute bottom-2 left-2 right-2">
                    <div className="text-white font-black text-sm line-clamp-1">{r.title}</div>
                    <div className="flex items-center justify-between mt-1 text-white/70 text-[10px]">
                      <span>@{r.host?.username ?? '—'}</span>
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-0.5">
                          <Users size={10} /> {r.total_auctions}
                        </span>
                        {sortMode === 'hot' && (r.heat_score ?? 0) > 0 && (
                          <span className={`flex items-center gap-0.5 ${heatColor(r.heat_score ?? 0)}`}>
                            <Flame size={10} /> {Math.round(r.heat_score ?? 0)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}
