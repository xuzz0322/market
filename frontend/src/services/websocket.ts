import type { WSMessage, WSMessageType } from '../types'

type MessageHandler = (data: WSMessage) => void

export type ConnectionState =
  | 'idle'         // never connected
  | 'connecting'   // socket opening
  | 'connected'    // open & healthy
  | 'reconnecting' // disconnected, backoff timer running
  | 'offline'      // browser reports navigator.onLine === false
  | 'failed'       // gave up after maxAttempts (manual reconnect needed)

type StateListener = (state: ConnectionState) => void

/**
 * Reliable WebSocket client for the auction stream.
 *
 * Reliability features:
 *   1. Exponential backoff with jitter (1s → 2s → 4s → 8s → 16s → 30s cap).
 *      Prevents thundering-herd reconnects when a server restarts and 1000s
 *      of clients all try to reconnect at the same instant.
 *   2. Browser online/offline event integration. When the OS reports the
 *      network came back, we reconnect immediately instead of waiting for
 *      the next backoff tick.
 *   3. Heartbeat watchdog. Server sends WS pings every 54s; the browser
 *      auto-replies with pong (we don't see it). If we receive zero traffic
 *      (no message, no ping) for 90s we assume the conn is silently dead
 *      (NAT timeout, half-open TCP) and force-reconnect.
 *   4. Room state restoration. We track which auctions the user joined and
 *      automatically re-join them on reconnect — the server sends a fresh
 *      state snapshot in response, so the UI catches up to the latest
 *      current_price / rankings without app-level retry logic.
 *   5. State observability. Components subscribe to onStateChange to render
 *      a connection indicator ("● Live" / "● Reconnecting...").
 */
class AuctionWebSocket {
  private ws: WebSocket | null = null
  private handlers: Map<WSMessageType, Set<MessageHandler>> = new Map()
  private stateListeners: Set<StateListener> = new Set()
  private state: ConnectionState = 'idle'

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private currentAuctions: Set<number> = new Set()
  // Auction-room channels the user is subscribed to. Re-joined on reconnect
  // alongside currentAuctions so live-stream signaling resumes seamlessly
  // after a transient WS drop.
  private currentRooms: Set<number> = new Set()
  private shouldReconnect = true
  private attempts = 0

  // Tunables. Defaults chosen for a typical user-facing app where a 30s
  // outage is the longest we want to make a user wait without a reconnect.
  private readonly baseDelayMs = 1000
  private readonly maxDelayMs = 30_000
  private readonly maxAttempts = 0          // 0 = retry forever
  private readonly watchdogMs = 90_000      // expect server traffic at least this often

  // Server clock skew (serverNow - localNow) in ms. Updated from every
  // bid_update message. Used by countdown timers to stay accurate even
  // when the user's device clock is wrong.
  private clockSkewMs = 0

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    const token = localStorage.getItem('token')
    if (!token) return

    this.shouldReconnect = true
    this.setState('connecting')

    // Browser network listeners — registered once, idempotent.
    this.ensureNetworkListeners()

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    const url = `${protocol}://${host}/ws?token=${token}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      console.error('WS construct failed:', e)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      console.log('[WS] connected')
      this.attempts = 0
      this.setState('connected')
      this.armWatchdog()
      // Re-join all rooms — server responds with fresh state snapshots,
      // so any state we missed while disconnected is reconciled here.
      this.currentAuctions.forEach((id) => {
        this.sendRaw({ type: 'join_auction', auction_id: id })
      })
      this.currentRooms.forEach((id) => {
        this.sendRaw({ type: 'join_room', room_id: id })
      })
    }

    ws.onmessage = (event) => {
      // Any traffic resets the watchdog. The browser handles ping/pong
      // automatically so we don't see those frames here, but server
      // bid_update / countdown messages count.
      this.armWatchdog()
      try {
        const lines = (event.data as string).split('\n').filter(Boolean)
        for (const line of lines) {
          const msg = JSON.parse(line) as WSMessage<{ server_time_ms?: number }>
          this.maybeUpdateClockSkew(msg)
          this.dispatch(msg)
        }
      } catch (e) {
        console.error('[WS] parse error:', e)
      }
    }

    ws.onclose = (event) => {
      console.log(`[WS] closed code=${event.code} reason=${event.reason}`)
      this.clearWatchdog()
      this.ws = null
      if (!this.shouldReconnect) {
        this.setState('idle')
        return
      }
      // Code 1008 (policy) = auth failure; don't loop reconnecting on bad
      // tokens — the user needs to re-login.
      if (event.code === 1008) {
        this.setState('failed')
        return
      }
      this.scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.warn('[WS] error:', err)
      // onerror is followed by onclose — let onclose drive reconnect logic.
    }
  }

  disconnect() {
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.clearWatchdog()
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect') } catch { /* ignore */ }
      this.ws = null
    }
    this.setState('idle')
  }

  /**
   * Force an immediate reconnect attempt — useful after a manual login or
   * when the user explicitly retries.
   */
  retry() {
    this.attempts = 0
    this.clearReconnectTimer()
    if (this.ws) {
      try { this.ws.close() } catch { /* will trigger onclose → scheduleReconnect */ }
    } else {
      this.connect()
    }
  }

  send(msg: WSMessage) {
    this.sendRaw(msg)
  }

  private sendRaw(msg: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
    // If not open, the message is dropped. For our use case (join/leave/bid)
    // this is the right behavior: re-joining is automatic on reconnect, and
    // bids should always go through HTTP (which has its own retry/idempotency).
  }

  joinAuction(auctionId: number) {
    this.currentAuctions.add(auctionId)
    this.sendRaw({ type: 'join_auction', auction_id: auctionId })
  }

  leaveAuction(auctionId: number) {
    this.currentAuctions.delete(auctionId)
    this.sendRaw({ type: 'leave_auction', auction_id: auctionId })
  }

  joinRoom(roomId: number) {
    this.currentRooms.add(roomId)
    this.sendRaw({ type: 'join_room', room_id: roomId })
  }

  leaveRoom(roomId: number) {
    this.currentRooms.delete(roomId)
    this.sendRaw({ type: 'leave_room', room_id: roomId })
  }

  /** Host: announce live-commentary stream is starting. */
  sendStreamStart(roomId: number) {
    this.sendRaw({ type: 'stream_start', room_id: roomId })
  }

  /** Host: announce live-commentary stream stopped. */
  sendStreamStop(roomId: number) {
    this.sendRaw({ type: 'stream_stop', room_id: roomId })
  }

  /** Send a chat message to a room. Server validates + rate-limits. */
  sendChat(roomId: number, text: string) {
    this.sendRaw({ type: 'chat_send', room_id: roomId, data: { text } })
  }

  /**
   * Forward a WebRTC signaling envelope (offer/answer/ICE) to a specific peer.
   * Server stamps `from` server-side; the value passed here is ignored by the
   * server but kept for client-side debugging.
   */
  sendWebRTCSignal(roomId: number, toUserId: number, signalType: 'offer' | 'answer' | 'ice' | 'request' | 'bye', payload: unknown) {
    this.sendRaw({
      type: 'webrtc_signal',
      room_id: roomId,
      data: { from: 0, to: toUserId, signal_type: signalType, payload, room_id: roomId },
    })
  }

  on(type: WSMessageType, handler: MessageHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
    return () => this.off(type, handler)
  }

  off(type: WSMessageType, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler)
  }

  /** Subscribe to connection state changes. Returns an unsubscribe fn. */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    listener(this.state) // emit current state immediately
    return () => { this.stateListeners.delete(listener) }
  }

  getState(): ConnectionState {
    return this.state
  }

  /** server time delta — `Date.now() + getClockSkew()` ≈ server now (ms). */
  getClockSkew(): number {
    return this.clockSkewMs
  }

  // --- internals ---

  private dispatch(msg: WSMessage) {
    this.handlers.get(msg.type)?.forEach((h) => h(msg))
  }

  private maybeUpdateClockSkew(msg: WSMessage<{ server_time_ms?: number }>) {
    const t = msg.data?.server_time_ms
    if (typeof t === 'number' && t > 0) {
      // Note: this ignores network latency (RTT/2 would be a better
      // estimate), but since we use this only for human-visible countdowns
      // a few hundred ms of bias is invisible.
      this.clockSkewMs = t - Date.now()
    }
  }

  private setState(s: ConnectionState) {
    if (this.state === s) return
    this.state = s
    this.stateListeners.forEach((l) => l(s))
  }

  private scheduleReconnect() {
    this.clearReconnectTimer()

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Don't burn attempts while offline — the online listener will
      // trigger a reconnect when the network comes back.
      this.setState('offline')
      return
    }

    if (this.maxAttempts > 0 && this.attempts >= this.maxAttempts) {
      this.setState('failed')
      return
    }

    this.attempts++
    // Exponential backoff: 1, 2, 4, 8, 16, 30, 30, 30...
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.attempts - 1))
    // Full jitter: random in [0, exp]. Smooths out thundering herd at the
    // cost of occasionally reconnecting faster than backoff would suggest.
    const delay = Math.floor(Math.random() * exp)
    this.setState('reconnecting')
    console.log(`[WS] reconnect in ${delay}ms (attempt ${this.attempts})`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private armWatchdog() {
    this.clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      console.warn('[WS] watchdog fired — no traffic for 90s, forcing reconnect')
      // Force-close the silently-dead conn; onclose schedules a reconnect.
      try { this.ws?.close() } catch { /* ignore */ }
    }, this.watchdogMs)
  }

  private clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private networkListenersInstalled = false
  private ensureNetworkListeners() {
    if (this.networkListenersInstalled) return
    this.networkListenersInstalled = true

    // Reconnect immediately when the OS reports network is back. This
    // beats the backoff timer by potentially many seconds.
    window.addEventListener('online', () => {
      console.log('[WS] online event — retrying')
      this.attempts = 0
      this.clearReconnectTimer()
      if (this.shouldReconnect) this.connect()
    })

    window.addEventListener('offline', () => {
      console.log('[WS] offline event')
      this.setState('offline')
      // Close the existing socket so it doesn't sit half-open while
      // packets quietly black-hole.
      try { this.ws?.close() } catch { /* ignore */ }
    })

    // When the tab regains focus after being backgrounded, the browser may
    // have suspended the socket. Force a state check.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.shouldReconnect) {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.attempts = 0
          this.clearReconnectTimer()
          this.connect()
        }
      }
    })
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const wsClient = new AuctionWebSocket()
export default wsClient
