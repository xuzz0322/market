import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, MessageCircle, Crown } from 'lucide-react'
import wsClient from '../services/websocket'
import type { WSMessage, ChatMessageData } from '../types'
import { useAuthStore } from '../services/store'

interface ChatProps {
  roomId: number
}

const MAX_BUFFER = 80           // hard cap on retained messages
const DANMAKU_DURATION_MS = 6000

interface ChatLine extends ChatMessageData {
  /** Local id — Date.now() can collide if two messages arrive in the same ms */
  _id: string
}

/**
 * RoomChat — slim chat panel + danmaku overlay for an auction room.
 *
 * Two simultaneous renders of the same message stream:
 *   1. Bottom-docked panel: collapsible, scrollable, classic IM layout.
 *   2. Danmaku layer: messages float across the upper half of the room as
 *      semi-transparent text strips, fading out after a few seconds.
 *
 * Messages are NOT persisted — joining mid-conversation, you only see what
 * arrives from this point forward. That's intentional (cheap, ephemeral).
 */
export default function RoomChat({ roomId }: ChatProps) {
  const { user } = useAuthStore()
  const [messages, setMessages] = useState<ChatLine[]>([])
  const [danmaku, setDanmaku] = useState<ChatLine[]>([])
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(true)
  const [showDanmaku, setShowDanmaku] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Subscribe to chat messages targeting THIS room only.
  useEffect(() => {
    const off = wsClient.on('chat_message', (msg: WSMessage) => {
      const data = msg.data as ChatMessageData | undefined
      if (!data || data.room_id !== roomId) return
      const line: ChatLine = { ...data, _id: `${data.timestamp}-${data.user_id}-${Math.random().toString(36).slice(2, 6)}` }
      setMessages((prev) => {
        const next = [...prev, line]
        return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
      })
      if (showDanmaku) {
        setDanmaku((prev) => [...prev, line])
        // Auto-evict after danmaku animation. Using a fresh closure
        // because state setters are stable.
        setTimeout(() => {
          setDanmaku((prev) => prev.filter((m) => m._id !== line._id))
        }, DANMAKU_DURATION_MS)
      }
    })
    return off
  }, [roomId, showDanmaku])

  // Auto-scroll to bottom on new message — but only if the user is already
  // near the bottom. Avoids hijacking scroll while they're reading history.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const send = () => {
    const t = input.trim()
    if (!t) return
    wsClient.sendChat(roomId, t)
    setInput('')
  }

  return (
    <>
      {/* Danmaku overlay — covers the upper portion of the room so the
          bidding UI at the bottom isn't obstructed. pointer-events-none so
          taps fall through to the underlying auction. */}
      {showDanmaku && (
        <div className="absolute top-12 left-0 right-0 h-2/5 z-25 pointer-events-none overflow-hidden">
          <AnimatePresence>
            {danmaku.map((m, idx) => (
              <motion.div
                key={m._id}
                initial={{ x: '110vw', opacity: 1 }}
                animate={{ x: '-110vw' }}
                exit={{ opacity: 0 }}
                transition={{ duration: DANMAKU_DURATION_MS / 1000, ease: 'linear' }}
                // Stagger vertical offset so multiple danmaku don't overlap
                // perfectly. Modulo cycles through 5 lanes.
                style={{ top: `${(idx % 5) * 28 + 8}px` }}
                className={`absolute whitespace-nowrap text-sm font-bold px-3 py-0.5 rounded-full ${
                  m.is_host
                    ? 'bg-brand-pink/30 text-white border border-brand-pink/60'
                    : 'bg-black/30 text-white'
                }`}
              >
                {m.is_host && '👑 '}
                <span className="opacity-80">{m.username}:</span> {m.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Chat panel — pinned to bottom; collapses to a small button. */}
      <div className="absolute bottom-20 left-3 right-20 z-30">
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="bg-black/50 backdrop-blur-md text-white w-10 h-10 rounded-full flex items-center justify-center border border-white/10"
            aria-label="展开聊天"
          >
            <MessageCircle size={16} />
          </button>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="bg-black/55 backdrop-blur-md rounded-2xl border border-white/10 overflow-hidden flex flex-col max-w-md"
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
              <span className="text-white/70 text-xs font-bold flex items-center gap-1"><MessageCircle size={12} /> 聊天</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowDanmaku(!showDanmaku)}
                  className={`text-[10px] px-2 py-0.5 rounded-full ${showDanmaku ? 'bg-brand-pink/30 text-white' : 'bg-white/10 text-white/40'}`}
                >
                  弹幕{showDanmaku ? '开' : '关'}
                </button>
                <button onClick={() => setOpen(false)} className="text-white/50 text-xs px-1.5">收起</button>
              </div>
            </div>

            <div ref={listRef} className="max-h-32 overflow-y-auto px-3 py-1.5 space-y-1 text-xs">
              {messages.length === 0 ? (
                <div className="text-white/30 py-2 text-center">还没有人说话…</div>
              ) : messages.map((m) => (
                <div key={m._id} className="flex gap-1.5 items-start">
                  <span className={`font-bold flex-shrink-0 ${m.is_host ? 'text-yellow-400' : m.user_id === user?.id ? 'text-brand-pink' : 'text-cyan-300'}`}>
                    {m.is_host && <Crown size={10} className="inline mr-0.5" />}
                    {m.username}:
                  </span>
                  <span className="text-white/90 break-words min-w-0">{m.text}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1.5 p-2 border-t border-white/10">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send() }}
                placeholder="说点什么…"
                maxLength={200}
                className="flex-1 bg-white/10 text-white placeholder-white/30 text-xs rounded-full px-3 py-1.5 outline-none focus:bg-white/15"
              />
              <button
                onClick={send}
                disabled={!input.trim()}
                className="bg-brand-pink text-white rounded-full w-7 h-7 flex items-center justify-center disabled:opacity-40"
              >
                <Send size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </>
  )
}
