import { useEffect } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import wsClient from '../services/websocket'
import type { BidOutbidData, WSMessage } from '../types'

/**
 * Global outbid handler.
 *
 * Mounted once at the app root so the user gets the alert wherever they
 * are — including when they've swiped past the auction in the feed, or
 * are on the orders page. The banner-style toast uses `toast.custom` so
 * we can include a "重新出价" CTA without writing a separate Toaster
 * variant; tapping the body navigates to the auction detail.
 *
 * We intentionally do NOT show this toast when the user is currently
 * looking at the same auction's detail page — they'll see the price
 * tick up in the visible UI and another loud toast would be redundant.
 * The detail page sets a window flag while mounted; we check it here.
 */
export function useOutbidNotifier() {
  const navigate = useNavigate()

  useEffect(() => {
    const unsub = wsClient.on('bid_outbid', (msg: WSMessage) => {
      const data = msg.data as BidOutbidData
      if (!data) return

      // Skip if the user is already looking at this auction.
      const focused = (window as unknown as { __auctionFocus?: number }).__auctionFocus
      if (focused === data.auction_id) {
        // Subtler in-context nudge instead of the full banner.
        toast.error(`你被 @${data.new_leader} 反超了！`, { duration: 3000 })
        return
      }

      // Browser notification permission — best-effort, no prompt spam.
      // We only TRY when the document is hidden (user is on another tab),
      // since visible toasts already cover the visible-tab case.
      if (document.visibilityState === 'hidden' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification('你被反超了！', {
            body: `《${data.product_title}》当前 ¥${data.current_price.toFixed(0)} (${data.seconds_left}s 后结束)`,
            tag: `outbid-${data.auction_id}`, // dedupe rapid alerts
          })
        }
      }

      toast.custom((t) => (
        <div
          onClick={() => {
            toast.dismiss(t.id)
            navigate(`/auction/${data.auction_id}`)
          }}
          className={`pointer-events-auto cursor-pointer rounded-2xl bg-gradient-to-r from-red-600 to-rose-700 text-white shadow-2xl px-4 py-3 max-w-sm flex items-center gap-3 ${
            t.visible ? 'animate-slide-up' : 'opacity-0'
          }`}
        >
          <div className="text-2xl flex-shrink-0">⚡</div>
          <div className="flex-1 min-w-0">
            <div className="font-black text-sm">你被反超了！</div>
            <div className="text-white/90 text-xs truncate mt-0.5">
              《{data.product_title}》现价 ¥{data.current_price.toLocaleString()}
            </div>
            <div className="text-white/70 text-[10px] mt-0.5">
              点击重新出价 · 还剩 {data.seconds_left}s
            </div>
          </div>
        </div>
      ), { duration: 6000, position: 'top-center' })
    })
    return unsub
  }, [navigate])
}

/**
 * Asks the OS for notification permission once, after the first user
 * interaction. We don't request on mount because Chrome punishes sites
 * that ask before any engagement.
 */
export function ensureNotificationPermission() {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'default') return
  // Defer the actual prompt — fire-and-forget; nothing to do with result.
  Notification.requestPermission().catch(() => { /* user dismissed */ })
}
