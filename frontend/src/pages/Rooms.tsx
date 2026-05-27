import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Plus, Radio, Users } from 'lucide-react'
import { listRooms, createRoom } from '../services/api'
import type { AuctionRoom } from '../types'

export default function Rooms() {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<AuctionRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [coverURL, setCoverURL] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      setRooms(await listRooms({ limit: 50 }))
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

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

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-black text-lg flex-1">拍卖间</h1>
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
          {rooms.map((r) => {
            const live = !!r.current_auction_id
            return (
              <motion.button
                key={r.id}
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
                  {live && (
                    <span className="absolute top-2 left-2 bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                      <Radio size={10} /> LIVE
                    </span>
                  )}
                  <div className="absolute bottom-2 left-2 right-2">
                    <div className="text-white font-black text-sm line-clamp-1">{r.title}</div>
                    <div className="flex items-center justify-between mt-1 text-white/70 text-[10px]">
                      <span>@{r.host?.username ?? '—'}</span>
                      <span className="flex items-center gap-0.5">
                        <Users size={10} /> {r.total_auctions}
                      </span>
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
