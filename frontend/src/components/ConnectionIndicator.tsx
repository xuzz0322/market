import { motion } from 'framer-motion'
import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useConnectionState } from '../hooks/useConnectionState'

/**
 * Small floating badge that shows the live websocket connection state.
 * Hidden when state is "connected" so the UI stays clean — only surfaces
 * when something needs user attention.
 */
export default function ConnectionIndicator() {
  const state = useConnectionState()

  if (state === 'connected' || state === 'idle') return null

  const config = {
    connecting:   { icon: Loader2,  text: '连接中...',     bg: 'bg-blue-500/90',   spin: true  },
    reconnecting: { icon: Loader2,  text: '正在重连...',   bg: 'bg-yellow-500/90', spin: true  },
    offline:      { icon: WifiOff,  text: '网络已断开',    bg: 'bg-red-500/90',    spin: false },
    failed:       { icon: WifiOff,  text: '连接失败 重试', bg: 'bg-red-600/90',    spin: false },
  }[state]

  if (!config) return null
  const Icon = config.icon

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -50, opacity: 0 }}
      className={`fixed top-3 left-1/2 -translate-x-1/2 z-[100] ${config.bg} text-white text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg backdrop-blur-sm`}
    >
      <Icon size={14} className={config.spin ? 'animate-spin' : ''} />
      <span>{config.text}</span>
    </motion.div>
  )
}
