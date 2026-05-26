import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'

interface CountdownTimerProps {
  /** Absolute auction-end time, in server-ms. Falsy → show "preparing". */
  endAtMs: number
  /** Server clock skew (server_now - local_now) in ms. From wsClient.getClockSkew(). */
  clockSkewMs?: number
  /** Total auction duration in seconds, used to render the progress arc. */
  totalSeconds: number
  onEnd?: () => void
}

/**
 * Cyber-style countdown — millisecond precision.
 *
 * Why we drive this off requestAnimationFrame and an absolute end timestamp
 * rather than a setInterval(1000) decrementing a local int:
 *
 *   1. Tab throttling: setInterval gets clamped to ~1 Hz when the tab is
 *      backgrounded; on return, your timer is wildly out of sync.
 *   2. Sleep: setInterval doesn't fire while the laptop is asleep. With
 *      absolute time, the countdown jumps to the correct value on wake.
 *   3. Clock drift: the user's device clock can be minutes off. By feeding
 *      in `clockSkewMs` measured from server messages, we render the same
 *      remaining time the server thinks remains, regardless of user clock.
 *   4. Sub-second display: RAF gives 60fps updates, so the centiseconds
 *      tick smoothly. Critical for the last-10-seconds "FINAL" experience.
 */
export default function CountdownTimer({ endAtMs, clockSkewMs = 0, totalSeconds, onEnd }: CountdownTimerProps) {
  // remainingMs is updated every animation frame. We keep it in state so
  // tier/color/digit changes trigger React re-renders, but write to it at
  // ~60fps via the RAF loop below.
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, endAtMs - (Date.now() + clockSkewMs)))
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd

  useEffect(() => {
    let raf = 0
    let lastEmit = 0
    const tick = () => {
      const now = Date.now() + clockSkewMs
      const left = Math.max(0, endAtMs - now)
      // Throttle React re-renders to ~30fps. RAF would give 60 but we
      // don't need digit updates that fast — and 30fps halves render cost
      // when many timers exist on screen.
      if (now - lastEmit >= 33) {
        setRemainingMs(left)
        lastEmit = now
      }
      if (left <= 0) {
        setRemainingMs(0)
        onEndRef.current?.()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [endAtMs, clockSkewMs])

  const safeTotal = Math.max(totalSeconds, 1)
  const remainingSec = remainingMs / 1000
  const progress = Math.max(0, Math.min(1, remainingSec / safeTotal))

  const tier = remainingSec <= 10 ? 'critical' : remainingSec <= 30 ? 'urgent' : remainingSec <= 60 ? 'warning' : 'normal'

  const colors = useMemo(() => {
    switch (tier) {
      case 'critical': return { ring: '#ff2d55', glow: '#ff2d55', text: '#ffffff', accent: '#ff5577' }
      case 'urgent':   return { ring: '#ff8a00', glow: '#ff6a00', text: '#ffffff', accent: '#ffaa33' }
      case 'warning':  return { ring: '#ffd43b', glow: '#facc15', text: '#ffffff', accent: '#fde047' }
      default:         return { ring: '#00d9ff', glow: '#22d3ee', text: '#ffffff', accent: '#67e8f9' }
    }
  }, [tier])

  // Time decomposition for display.
  const totalCs = Math.floor(remainingMs / 10)             // hundredths
  const m = Math.floor(remainingSec / 60)
  const s = Math.floor(remainingSec) % 60
  const cs = totalCs % 100
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  const ccs = String(cs).padStart(2, '0')

  const size = 160
  const stroke = 6
  const radius = (size - stroke) / 2 - 6
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progress)

  const pulseDuration = tier === 'critical' ? 0.5 : tier === 'urgent' ? 0.8 : tier === 'warning' ? 1.2 : 2

  // Shake re-key on each whole second when critical, for a subtle "tick" feel.
  const shakeKey = tier === 'critical' ? Math.floor(remainingSec) : 0

  // Burst particles re-emitted each whole second in critical tier.
  const burstParticles = useMemo(() => {
    if (tier !== 'critical') return []
    return Array.from({ length: 8 }, (_, i) => ({ id: i, angle: (i / 8) * Math.PI * 2 }))
  }, [tier, shakeKey])

  return (
    <motion.div
      key={shakeKey}
      animate={tier === 'critical' ? { x: [0, -2, 2, -1, 1, 0] } : {}}
      transition={{ duration: 0.4 }}
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      {tier === 'critical' && (
        <motion.div
          className="absolute inset-[-20px] rounded-full"
          style={{ background: `radial-gradient(circle, ${colors.glow}66 0%, transparent 70%)` }}
          animate={{ opacity: [0.3, 0.9, 0.3], scale: [1, 1.15, 1] }}
          transition={{ duration: 0.7, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}

      <motion.div
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: `0 0 30px ${colors.glow}80, 0 0 60px ${colors.glow}40, inset 0 0 20px ${colors.glow}30` }}
        animate={{ opacity: [0.6, 1, 0.6] }}
        transition={{ duration: pulseDuration, repeat: Infinity, ease: 'easeInOut' }}
      />

      {burstParticles.map((p) => (
        <motion.div
          key={`${shakeKey}-${p.id}`}
          className="absolute w-1.5 h-1.5 rounded-full pointer-events-none"
          style={{ background: colors.glow, left: '50%', top: '50%' }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: Math.cos(p.angle) * 90, y: Math.sin(p.angle) * 90, opacity: 0, scale: 0.2 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      ))}

      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <defs>
          <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={colors.ring} stopOpacity="1" />
            <stop offset="100%" stopColor={colors.accent} stopOpacity="0.6" />
          </linearGradient>
          <filter id="ring-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />

        {Array.from({ length: 60 }).map((_, i) => {
          const a = (i / 60) * Math.PI * 2
          const inner = radius - stroke / 2 - 4
          const outer = radius - stroke / 2 - 1
          const x1 = size / 2 + Math.cos(a) * inner
          const y1 = size / 2 + Math.sin(a) * inner
          const x2 = size / 2 + Math.cos(a) * outer
          const y2 = size / 2 + Math.sin(a) * outer
          const isMajor = i % 5 === 0
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isMajor ? colors.ring : 'rgba(255,255,255,0.2)'}
              strokeWidth={isMajor ? 1.2 : 0.5}
              opacity={isMajor ? 0.6 : 0.3}
            />
          )
        })}

        {/* Smoothly-drawn progress arc. We use a static dashOffset (not
            animated by framer-motion) because RAF is already updating it
            every frame via the parent re-render — animating it again would
            cause "rubber band" lag. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#ring-gradient)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          filter="url(#ring-glow)"
        />
      </svg>

      <motion.div
        className="relative z-10 flex flex-col items-center"
        animate={tier === 'critical' ? { scale: [1, 1.08, 1] } : {}}
        transition={{ duration: 0.5, repeat: Infinity }}
      >
        <div className="text-[10px] font-bold tracking-[0.3em] uppercase mb-1" style={{ color: colors.accent }}>
          {tier === 'critical' ? '⚡ FINAL' : tier === 'urgent' ? 'HURRY' : tier === 'warning' ? 'ENDING' : 'LIVE'}
        </div>

        {/* Digital time. In critical tier we replace the seconds with a
            running mm:ss.cs (centiseconds) so the user sees real-time decay
            — the difference between "10s" and "9.43s" is what makes the
            urgency feel real. */}
        <div className="flex items-baseline gap-0.5 font-mono font-black tabular-nums" style={{ color: colors.text }}>
          <FlipDigit value={mm[0]} color={colors.text} />
          <FlipDigit value={mm[1]} color={colors.text} />
          <span className="text-3xl mx-0.5" style={{ color: colors.accent, opacity: 0.8 }}>:</span>
          <FlipDigit value={ss[0]} color={colors.text} />
          <FlipDigit value={ss[1]} color={colors.text} />
          {tier === 'critical' && (
            <>
              <span className="text-xl mx-0.5" style={{ color: colors.accent, opacity: 0.6 }}>.</span>
              <span className="text-xl tabular-nums" style={{ color: colors.accent }}>{ccs}</span>
            </>
          )}
        </div>

        <div className="text-[9px] tracking-widest mt-1 uppercase" style={{ color: 'rgba(255,255,255,0.5)' }}>
          {remainingMs > 0 ? 'time remaining' : 'auction ended'}
        </div>
      </motion.div>

      <motion.div
        className="absolute inset-[-10px] rounded-full pointer-events-none"
        style={{ border: `1px dashed ${colors.ring}40` }}
        animate={{ rotate: 360 }}
        transition={{ duration: tier === 'critical' ? 4 : 12, repeat: Infinity, ease: 'linear' }}
      />
    </motion.div>
  )
}

function FlipDigit({ value, color }: { value: string; color: string }) {
  return (
    <div className="relative inline-block w-[1ch] h-[36px] overflow-hidden">
      <AnimatePresence mode="popLayout">
        <motion.span
          key={value}
          initial={{ y: -36, opacity: 0, rotateX: -90 }}
          animate={{ y: 0, opacity: 1, rotateX: 0 }}
          exit={{ y: 36, opacity: 0, rotateX: 90 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 flex items-center justify-center text-3xl font-black"
          style={{ color }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
