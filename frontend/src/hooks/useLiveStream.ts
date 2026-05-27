import { useEffect, useRef, useState, useCallback } from 'react'
import wsClient from '../services/websocket'
import type { WSMessage, WebRTCSignalData, StreamStateData } from '../types'

const ICE_SERVERS: RTCIceServer[] = [
  // Public Google STUN. Sufficient for most NAT traversal in this MVP;
  // symmetric NAT users will need a TURN server, which we don't run yet.
  // If reliability becomes an issue, drop in a coturn instance and add it
  // here with credentials.
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

interface UseLiveStreamOpts {
  roomId: number
  hostUserId: number
  selfUserId: number
}

interface UseLiveStreamReturn {
  /** True for the host UI; false for viewers. */
  isHost: boolean
  /** True once the host has toggled streaming on (room-wide). */
  hostStreaming: boolean
  /** Host's local preview stream (only set on host). */
  localStream: MediaStream | null
  /** Viewer's incoming stream from the host (only set on viewer once connected). */
  remoteStream: MediaStream | null
  /** Host action: start camera + mic and announce. */
  startHosting: () => Promise<void>
  /** Host action: stop and tear down all peer connections. */
  stopHosting: () => void
  /** Viewer action: toggle audio on the incoming stream (default muted to satisfy autoplay rules). */
  toggleViewerAudio: () => void
  viewerAudioOn: boolean
  /** Approximate viewer count (host-only — number of active peer connections). */
  viewerCount: number
  /** User-facing error string from getUserMedia / connection failures. */
  error: string | null
}

/**
 * useLiveStream — WebRTC mesh for an auction room.
 *
 * Roles & flow:
 *   - HOST sets up camera/mic via getUserMedia, broadcasts stream_start. For
 *     each viewer that requests the stream, the host creates a fresh
 *     RTCPeerConnection, attaches local tracks, sends an SDP offer, and
 *     trickles ICE candidates over the WS signaling channel.
 *   - VIEWER, upon receiving stream_start (or as a personal snapshot when
 *     joining a room that's already live), sends a 'request' signal. The
 *     viewer creates a single RTCPeerConnection, sets the remote description
 *     when the host's offer arrives, sends an SDP answer, and renders the
 *     incoming stream from `ontrack`.
 *
 * Mesh limitations:
 *   - This is host-fanout, not full mesh — viewers don't connect to each
 *     other, only to the host. Practical limit is ~10 viewers before the
 *     host's upstream bandwidth saturates. Beyond that, a media server
 *     (LiveKit/mediasoup) is required.
 *
 * Cleanup:
 *   - Closes all peer connections when the host stops or the component
 *     unmounts. Viewer also gracefully tears down on stream_stop.
 */
export function useLiveStream({ roomId, hostUserId, selfUserId }: UseLiveStreamOpts): UseLiveStreamReturn {
  const isHost = hostUserId === selfUserId

  const [hostStreaming, setHostStreaming] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [viewerCount, setViewerCount] = useState(0)
  const [viewerAudioOn, setViewerAudioOn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Host: viewerUserID -> RTCPeerConnection. Refs (not state) because we
  // never want the create/close lifecycle of these to trigger React renders.
  const hostPeersRef = useRef<Map<number, RTCPeerConnection>>(new Map())
  // Viewer: single connection back to the host.
  const viewerPeerRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)

  // ---------- Host helpers ----------

  const createHostPeer = useCallback((viewerId: number, stream: MediaStream) => {
    // Tear down any stale connection to this viewer (e.g., they reconnected).
    const prior = hostPeersRef.current.get(viewerId)
    if (prior) {
      try { prior.close() } catch { /* ignore */ }
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    hostPeersRef.current.set(viewerId, pc)
    setViewerCount(hostPeersRef.current.size)

    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        wsClient.sendWebRTCSignal(roomId, viewerId, 'ice', ev.candidate.toJSON())
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        hostPeersRef.current.delete(viewerId)
        setViewerCount(hostPeersRef.current.size)
      }
    }
    return pc
  }, [roomId])

  const sendOfferTo = useCallback(async (viewerId: number, stream: MediaStream) => {
    try {
      const pc = createHostPeer(viewerId, stream)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      wsClient.sendWebRTCSignal(roomId, viewerId, 'offer', { sdp: offer.sdp, type: offer.type })
    } catch (e) {
      console.warn('[live] sendOffer failed', e)
    }
  }, [createHostPeer, roomId])

  // ---------- Viewer helpers ----------

  const ensureViewerPeer = useCallback(() => {
    if (viewerPeerRef.current) return viewerPeerRef.current
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    viewerPeerRef.current = pc

    pc.ontrack = (ev) => {
      // ev.streams[0] is the remote MediaStream the host attached. We hold
      // a reference in state so the <video> element can bind to it.
      if (ev.streams && ev.streams[0]) {
        setRemoteStream(ev.streams[0])
      }
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        wsClient.sendWebRTCSignal(roomId, hostUserId, 'ice', ev.candidate.toJSON())
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        // Don't tear down on 'disconnected' — it's transient. Only clear
        // remoteStream on terminal states.
        if (pc.connectionState !== 'disconnected') {
          setRemoteStream(null)
        }
      }
    }
    return pc
  }, [roomId, hostUserId])

  const closeViewerPeer = useCallback(() => {
    const pc = viewerPeerRef.current
    if (pc) {
      try { pc.close() } catch { /* ignore */ }
      viewerPeerRef.current = null
    }
    setRemoteStream(null)
  }, [])

  // ---------- Public actions ----------

  const startHosting = useCallback(async () => {
    if (!isHost) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Constrain to keep CPU/bandwidth tame on mobile hosts. 480p audio
        // is enough for commentary-style streams; higher fidelity tanks
        // upload bandwidth in mesh topology.
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      localStreamRef.current = stream
      setLocalStream(stream)
      setHostStreaming(true)
      wsClient.sendStreamStart(roomId)
    } catch (e) {
      const msg = (e as Error)?.message ?? '获取摄像头失败'
      setError(msg)
    }
  }, [isHost, roomId])

  const stopHosting = useCallback(() => {
    if (!isHost) return
    // Notify viewers they should tear down their peers, then close ours.
    wsClient.sendStreamStop(roomId)
    hostPeersRef.current.forEach((pc) => { try { pc.close() } catch { /* ignore */ } })
    hostPeersRef.current.clear()
    setViewerCount(0)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }
    setLocalStream(null)
    setHostStreaming(false)
  }, [isHost, roomId])

  const toggleViewerAudio = useCallback(() => {
    setViewerAudioOn((v) => !v)
  }, [])

  // ---------- Signaling subscriptions ----------

  useEffect(() => {
    wsClient.joinRoom(roomId)
    return () => {
      wsClient.leaveRoom(roomId)
    }
  }, [roomId])

  // Stream_start / stream_stop room-level signals.
  useEffect(() => {
    const offStart = wsClient.on('stream_start', (msg: WSMessage) => {
      const data = msg.data as StreamStateData | undefined
      if (!data || data.room_id !== roomId) return
      setHostStreaming(true)
      // Viewer side: ask the host for an offer. The host will respond with
      // an SDP offer over the signaling channel.
      if (!isHost) {
        wsClient.sendWebRTCSignal(roomId, data.host_id, 'request', {})
      }
    })
    const offStop = wsClient.on('stream_stop', (msg: WSMessage) => {
      const data = msg.data as StreamStateData | undefined
      if (!data || data.room_id !== roomId) return
      setHostStreaming(false)
      if (!isHost) closeViewerPeer()
    })
    return () => { offStart(); offStop() }
  }, [roomId, isHost, closeViewerPeer])

  // WebRTC signaling — handles offer/answer/ICE/request/bye for both roles.
  useEffect(() => {
    const off = wsClient.on('webrtc_signal', async (msg: WSMessage) => {
      const sig = msg.data as WebRTCSignalData | undefined
      if (!sig || sig.room_id !== roomId || sig.to !== selfUserId) return

      if (isHost) {
        // Host receives: 'request' (start a fresh peer & offer), 'answer'
        // (set remote desc), or 'ice' (add candidate). 'bye' from a viewer
        // tears down their peer.
        switch (sig.signal_type) {
          case 'request': {
            const stream = localStreamRef.current
            if (!stream) return // host hasn't started yet
            await sendOfferTo(sig.from, stream)
            break
          }
          case 'answer': {
            const pc = hostPeersRef.current.get(sig.from)
            if (pc) await pc.setRemoteDescription(sig.payload as RTCSessionDescriptionInit)
            break
          }
          case 'ice': {
            const pc = hostPeersRef.current.get(sig.from)
            if (pc && sig.payload) {
              try { await pc.addIceCandidate(sig.payload as RTCIceCandidateInit) } catch { /* ignore late ICE */ }
            }
            break
          }
          case 'bye': {
            const pc = hostPeersRef.current.get(sig.from)
            if (pc) { try { pc.close() } catch { /* ignore */ } }
            hostPeersRef.current.delete(sig.from)
            setViewerCount(hostPeersRef.current.size)
            break
          }
        }
      } else {
        // Viewer side: 'offer' (set remote, answer back) or 'ice' (add
        // candidate). The host never sends 'request' to viewers.
        switch (sig.signal_type) {
          case 'offer': {
            const pc = ensureViewerPeer()
            await pc.setRemoteDescription(sig.payload as RTCSessionDescriptionInit)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            wsClient.sendWebRTCSignal(roomId, sig.from, 'answer', { sdp: answer.sdp, type: answer.type })
            break
          }
          case 'ice': {
            const pc = viewerPeerRef.current
            if (pc && sig.payload) {
              try { await pc.addIceCandidate(sig.payload as RTCIceCandidateInit) } catch { /* ignore late ICE */ }
            }
            break
          }
        }
      }
    })
    return off
  }, [roomId, isHost, selfUserId, ensureViewerPeer, sendOfferTo])

  // Final cleanup on unmount — close all peer connections and stop tracks
  // so we don't leak camera/mic permission or peer state.
  useEffect(() => {
    return () => {
      if (isHost) {
        // Tell viewers we're going away so they can stop their peers.
        if (hostPeersRef.current.size > 0) {
          wsClient.sendStreamStop(roomId)
        }
        hostPeersRef.current.forEach((pc) => { try { pc.close() } catch { /* ignore */ } })
        hostPeersRef.current.clear()
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((t) => t.stop())
        }
      } else {
        if (viewerPeerRef.current) {
          // Best-effort goodbye so the host can free the peer slot.
          wsClient.sendWebRTCSignal(roomId, hostUserId, 'bye', {})
          try { viewerPeerRef.current.close() } catch { /* ignore */ }
          viewerPeerRef.current = null
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    isHost,
    hostStreaming,
    localStream,
    remoteStream,
    startHosting,
    stopHosting,
    toggleViewerAudio,
    viewerAudioOn,
    viewerCount,
    error,
  }
}
