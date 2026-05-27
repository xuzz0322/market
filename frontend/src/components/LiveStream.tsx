import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic, MicOff, Video, VideoOff, Maximize2, Minimize2, Volume2, VolumeX, Users } from 'lucide-react'
import { useLiveStream } from '../hooks/useLiveStream'
import { useAuthStore } from '../services/store'

interface LiveStreamProps {
  roomId: number
  hostUserId: number
  isHostMode: boolean // true when this user is the host of this room
  hostUsername?: string
}

// LivePanel — floating draggable A/V panel. Renders host's local preview
// when isHostMode, otherwise renders the incoming remote stream once the
// host is broadcasting. Collapsible to a tile to give the user control
// over screen real estate during bidding.
export default function LiveStream({ roomId, hostUserId, isHostMode, hostUsername }: LiveStreamProps) {
  const { user } = useAuthStore()
  const selfUserId = user?.id ?? 0

  const {
    isHost, hostStreaming, localStream, remoteStream,
    startHosting, stopHosting,
    viewerAudioOn, toggleViewerAudio,
    viewerCount, error,
  } = useLiveStream({ roomId, hostUserId, selfUserId })

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)

  // Bind whichever stream is relevant for this role to the <video> element.
  // Host sees their preview; viewer sees the remote feed.
  useEffect(() => {
    const stream = isHost ? localStream : remoteStream
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
  }, [isHost, localStream, remoteStream])

  // Apply mic/cam toggles to the host's local stream.
  useEffect(() => {
    if (!isHost || !localStream) return
    localStream.getAudioTracks().forEach((t) => { t.enabled = micOn })
  }, [isHost, localStream, micOn])
  useEffect(() => {
    if (!isHost || !localStream) return
    localStream.getVideoTracks().forEach((t) => { t.enabled = camOn })
  }, [isHost, localStream, camOn])

  // Host-mode pre-stream: just shows the "开始讲解" button. Once started,
  // the floating tile appears with controls.
  if (isHostMode && !hostStreaming) {
    return (
      <div className="absolute top-16 right-3 z-30">
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={startHosting}
          className="bg-gradient-to-r from-red-500 to-pink-600 text-white text-xs font-black px-3 py-2 rounded-full shadow-lg flex items-center gap-1.5"
        >
          <Video size={14} /> 开始讲解
        </motion.button>
        {error && <div className="mt-1 bg-red-600/90 text-white text-[10px] px-2 py-1 rounded">{error}</div>}
      </div>
    )
  }

  // Viewer-mode pre-stream: nothing (host hasn't started yet).
  if (!isHostMode && !hostStreaming) return null

  return (
    <AnimatePresence>
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        className={`absolute z-30 rounded-2xl overflow-hidden bg-black shadow-2xl border border-white/20 ${
          expanded
            ? 'inset-4 max-w-md max-h-[60vh] mx-auto'
            : 'top-16 right-3 w-32 aspect-[3/4]'
        }`}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Host's own preview is muted to avoid echo. Viewers default to
          // muted too so autoplay isn't blocked; they tap the speaker icon
          // to unmute.
          muted={isHost ? true : !viewerAudioOn}
          className="w-full h-full object-cover"
        />

        {/* LIVE badge */}
        <div className="absolute top-1.5 left-1.5 bg-red-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
          <span className="w-1.5 h-1.5 rounded-full bg-white" /> LIVE
        </div>

        {/* Viewer count (host only) */}
        {isHost && (
          <div className="absolute top-1.5 right-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
            <Users size={10} /> {viewerCount}
          </div>
        )}

        {/* Host name overlay (viewer only) */}
        {!isHost && hostUsername && !expanded && (
          <div className="absolute bottom-1 left-1 right-1 bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded text-center truncate">
            @{hostUsername}
          </div>
        )}

        {/* Controls */}
        <div className="absolute bottom-1.5 right-1.5 flex gap-1">
          {isHost ? (
            <>
              <ControlButton onClick={() => setMicOn(!micOn)} title={micOn ? '静音' : '取消静音'}>
                {micOn ? <Mic size={12} /> : <MicOff size={12} className="text-red-400" />}
              </ControlButton>
              <ControlButton onClick={() => setCamOn(!camOn)} title={camOn ? '关闭摄像头' : '开启摄像头'}>
                {camOn ? <Video size={12} /> : <VideoOff size={12} className="text-red-400" />}
              </ControlButton>
              <ControlButton onClick={() => setExpanded(!expanded)} title={expanded ? '缩小' : '放大'}>
                {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </ControlButton>
              <ControlButton onClick={stopHosting} title="停止讲解" danger>
                ✕
              </ControlButton>
            </>
          ) : (
            <>
              <ControlButton onClick={toggleViewerAudio} title={viewerAudioOn ? '静音' : '播放声音'}>
                {viewerAudioOn ? <Volume2 size={12} /> : <VolumeX size={12} className="text-yellow-300" />}
              </ControlButton>
              <ControlButton onClick={() => setExpanded(!expanded)} title={expanded ? '缩小' : '放大'}>
                {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </ControlButton>
            </>
          )}
        </div>

        {/* Viewer-side: hint to tap to unmute since most browsers autoplay-mute */}
        {!isHost && !viewerAudioOn && remoteStream && (
          <button
            onClick={toggleViewerAudio}
            className="absolute inset-0 flex items-center justify-center bg-black/30"
          >
            <div className="bg-white/90 text-black text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1">
              <VolumeX size={14} /> 点击听讲解
            </div>
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  )
}

function ControlButton({
  onClick, children, title, danger,
}: { onClick: () => void; children: React.ReactNode; title?: string; danger?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className={`w-6 h-6 rounded-full flex items-center justify-center text-white ${
        danger ? 'bg-red-600/90' : 'bg-black/60 hover:bg-black/80'
      }`}
    >
      {children}
    </button>
  )
}
