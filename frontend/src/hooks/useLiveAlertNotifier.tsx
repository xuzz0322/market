import { useEffect } from 'react'
import toast from 'react-hot-toast'
import wsClient from '../services/websocket'
import type { WSMessage, HostLiveData, AuctionStartingData } from '../types'

/**
 * useLiveAlertNotifier — global listener for follow-related push messages.
 *
 * Two events:
 *   1. host_live: a followed host just started broadcasting → toast +
 *      browser notification with a "watch" CTA that deep-links to the room.
 *   2. auction_starting: a followed host opened a new auction (typically
 *      inside their room queue auto-promoting) → toast that links into the
 *      auction.
 *
 * Mounted once in App.tsx so the alerts fire regardless of which page the
 * user is currently on.
 */
export function useLiveAlertNotifier() {
  useEffect(() => {
    const offLive = wsClient.on('host_live', (msg: WSMessage) => {
      const data = msg.data as HostLiveData | undefined
      if (!data) return
      const link = `/rooms/${data.room_id}`
      toast(
        (t) => (
          <div className="flex items-center gap-2 min-w-0" onClick={() => { window.location.href = link; toast.dismiss(t.id) }}>
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <div className="min-w-0">
              <div className="font-bold text-sm">@{data.username} 开播了</div>
              <div className="text-xs text-gray-500 truncate">{data.room_title} · 点击进入</div>
            </div>
          </div>
        ),
        { duration: 6000, icon: '🔴' }
      )
      maybePushBrowserNotification(`@${data.username} 开播了`, data.room_title, link)
    })

    const offAuction = wsClient.on('auction_starting', (msg: WSMessage) => {
      const data = msg.data as AuctionStartingData | undefined
      if (!data) return
      const link = data.room_id ? `/rooms/${data.room_id}` : `/auction/${data.auction_id}`
      toast(`@${data.username} 上新拍品：${data.product_title}`, {
        duration: 5000, icon: '🆕',
      })
      maybePushBrowserNotification(`@${data.username} 上新拍品`, data.product_title, link)
    })

    return () => { offLive(); offAuction() }
  }, [])
}

function maybePushBrowserNotification(title: string, body: string, link: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // visibilitychange: only push when user is NOT actively on the tab —
  // otherwise the in-app toast is enough and stacking both is annoying.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    const n = new Notification(title, { body, tag: link })
    n.onclick = () => {
      window.focus()
      window.location.href = link
      n.close()
    }
  } catch {
    /* ignore — some browsers block constructor in service-worker-only mode */
  }
}
