import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { ArrowLeft, Send } from 'lucide-react'
import { getDMThread, sendDM, type DirectMessage } from '../services/api'
import { useAuthStore } from '../services/store'
import wsClient from '../services/websocket'

export default function DMThread() {
  const { id } = useParams()
  const peerId = Number(id)
  const navigate = useNavigate()
  const { user } = useAuthStore()

  const [msgs, setMsgs] = useState<DirectMessage[]>([])
  const [peerName, setPeerName] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async (before?: number) => {
    try {
      const data = await getDMThread(peerId, { before, limit: 50 })
      if (data.length > 0) {
        // Extract peer name from messages.
        const sample = data.find((m) => m.sender_id === peerId)
        if (sample?.sender) setPeerName(sample.sender.username)
      }
      setMsgs((prev) => before ? [...data, ...prev] : data)
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [peerId])

  useEffect(() => {
    load()
  }, [load])

  // Scroll to bottom on first load and each new message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: msgs.length <= 50 ? 'instant' : 'smooth' })
  }, [msgs])

  // Listen for incoming DMs in this thread via WS.
  useEffect(() => {
    const off = wsClient.on('dm_received', (msg) => {
      const data = msg.data as { sender_id: number; msg_id: number; body: string; created_at: string; sender_name: string }
      if (data.sender_id !== peerId) return
      const newMsg: DirectMessage = {
        id: data.msg_id,
        sender_id: data.sender_id,
        receiver_id: user?.id ?? 0,
        body: data.body,
        created_at: data.created_at,
        sender: { id: data.sender_id, username: data.sender_name, avatar: '' },
      }
      setMsgs((prev) => [...prev, newMsg])
    })
    return off
  }, [peerId, user?.id])

  const onSend = async () => {
    const trimmed = body.trim()
    if (!trimmed) return
    setSending(true)
    try {
      const sent = await sendDM(peerId, trimmed)
      setMsgs((prev) => [...prev, sent])
      setBody('')
      inputRef.current?.focus()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? '发送失败'
      toast.error(msg)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  // Group messages by date for date separators.
  type MsgOrDate = { kind: 'msg'; msg: DirectMessage } | { kind: 'date'; label: string }
  const items: MsgOrDate[] = []
  let lastDate = ''
  for (const m of msgs) {
    const d = new Date(m.created_at).toLocaleDateString('zh-CN')
    if (d !== lastDate) {
      items.push({ kind: 'date', label: d })
      lastDate = d
    }
    items.push({ kind: 'msg', msg: m })
  }

  return (
    <div className="h-screen bg-brand-dark text-white flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 bg-brand-dark/95 backdrop-blur-md border-b border-white/10 px-3 py-3 flex items-center gap-2 z-10">
        <button onClick={() => navigate(-1)} className="p-1.5 text-white/70">
          <ArrowLeft size={20} />
        </button>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center text-white font-bold text-sm">
          {peerName[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="font-bold flex-1">@{peerName || `用户${peerId}`}</span>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-7 h-7 border-2 border-brand-pink border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.map((item, i) => {
          if (item.kind === 'date') {
            return (
              <div key={`date-${i}`} className="text-center text-white/30 text-[10px] py-2">{item.label}</div>
            )
          }
          const m = item.msg
          const isMine = m.sender_id === user?.id
          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm leading-relaxed break-words ${
                  isMine
                    ? 'bg-brand-pink text-white rounded-tr-sm'
                    : 'bg-white/10 text-white rounded-tl-sm'
                }`}
              >
                {m.body}
                <div className={`text-[9px] mt-0.5 ${isMine ? 'text-white/60' : 'text-white/40'} text-right`}>
                  {new Date(m.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </motion.div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="flex-shrink-0 bg-brand-dark border-t border-white/10 px-3 py-2 flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="发送消息…"
          rows={1}
          className="flex-1 bg-white/10 text-white placeholder-white/40 rounded-xl px-3 py-2 text-sm outline-none resize-none max-h-32"
          style={{ height: 'auto' }}
          onInput={(e) => {
            const t = e.currentTarget
            t.style.height = 'auto'
            t.style.height = t.scrollHeight + 'px'
          }}
        />
        <button
          onClick={onSend}
          disabled={sending || !body.trim()}
          className="bg-brand-pink text-white w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 disabled:opacity-40"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}
