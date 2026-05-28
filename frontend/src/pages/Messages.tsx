import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { getDMInbox, type DMConversation } from '../services/api'
import wsClient from '../services/websocket'

function timeAgo(iso: string) {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN')
}

export default function Messages() {
  const navigate = useNavigate()
  const [convos, setConvos] = useState<DMConversation[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try { setConvos(await getDMInbox()) }
    catch { toast.error('加载失败') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    // When a new DM arrives via WS, refresh inbox so unread badges update.
    const off = wsClient.on('dm_received', () => load())
    return off
  }, [load])

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-black text-lg flex-1">私信</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        </div>
      ) : convos.length === 0 ? (
        <div className="py-20 text-center">
          <MessageSquare size={48} className="mx-auto mb-3 text-white/20" />
          <div className="text-white/50">还没有私信</div>
          <div className="text-white/30 text-xs mt-1">在拍卖详情页点击卖家名字可以发送私信</div>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {convos.map((c) => (
            <motion.button
              key={c.peer_id}
              whileTap={{ scale: 0.98 }}
              onClick={() => navigate(`/messages/${c.peer_id}`)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
            >
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                {c.username[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm truncate">@{c.username}</span>
                  <span className="text-white/40 text-[10px] flex-shrink-0 ml-2">{timeAgo(c.last_at)}</span>
                </div>
                <div className="text-white/50 text-xs mt-0.5 truncate">{c.last_body}</div>
              </div>
              {c.unread_count > 0 && (
                <span className="flex-shrink-0 bg-brand-pink text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                  {c.unread_count > 9 ? '9+' : c.unread_count}
                </span>
              )}
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )
}
