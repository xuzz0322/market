import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, UserX, Trash2 } from 'lucide-react'
import { myBlocks, unblockUser, type BlockedUser } from '../services/api'

export default function BlocksPage() {
  const navigate = useNavigate()
  const [list, setList] = useState<BlockedUser[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    myBlocks().then(setList).catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const onUnblock = async (u: BlockedUser) => {
    if (!confirm(`解除对 @${u.username} 的拉黑？`)) return
    try {
      await unblockUser(u.id)
      setList((prev) => prev.filter((x) => x.id !== u.id))
      toast.success(`已解除拉黑 @${u.username}`)
    } catch {
      toast.error('操作失败')
    }
  }

  return (
    <div className="min-h-screen bg-brand-dark text-white pb-20">
      <div className="sticky top-0 z-10 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70"><ArrowLeft size={20} /></button>
        <h1 className="font-black text-lg flex-1">黑名单</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
        </div>
      ) : list.length === 0 ? (
        <div className="py-20 text-center">
          <UserX size={48} className="mx-auto mb-3 text-white/20" />
          <div className="text-white/50">还没有拉黑任何人</div>
        </div>
      ) : (
        <div className="p-4 space-y-2">
          {list.map((u) => (
            <motion.div
              key={u.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-3 bg-white/5 rounded-2xl p-3"
            >
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-500 to-gray-700 flex items-center justify-center text-white font-bold flex-shrink-0">
                {u.username[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-bold truncate">@{u.username}</div>
                <div className="text-white/40 text-xs">
                  {new Date(u.blocked_at).toLocaleDateString('zh-CN')} 拉黑
                </div>
              </div>
              <button
                onClick={() => onUnblock(u)}
                className="bg-white/10 text-white/70 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 flex-shrink-0"
              >
                <Trash2 size={12} /> 解除
              </button>
            </motion.div>
          ))}
        </div>
      )}

      <div className="px-4 mt-2 text-white/30 text-xs text-center leading-relaxed">
        被拉黑用户的拍卖和拍卖间不会出现在你的推荐中。
      </div>
    </div>
  )
}
