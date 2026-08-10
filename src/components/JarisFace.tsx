import { motion } from 'framer-motion'
import type { JarisEmotion } from '@/store/useJarisStore'

interface JarisFaceProps {
  emotion: JarisEmotion
  size?: number
}

interface EmotionStyle {
  glow: string
  ringDuration: number
  ringOpacity: number
  label: string
}

const EMOTION_STYLES: Record<JarisEmotion, EmotionStyle> = {
  idle: { glow: '#3a5a7a', ringDuration: 50, ringOpacity: 0.25, label: 'En veille' },
  listening: { glow: '#37e2ff', ringDuration: 18, ringOpacity: 0.6, label: "À l'écoute" },
  thinking: { glow: '#ffb648', ringDuration: 3.5, ringOpacity: 0.75, label: 'Réflexion...' },
  happy: { glow: '#4dffa6', ringDuration: 10, ringOpacity: 0.7, label: 'Content' },
  surprised: { glow: '#ff5d7a', ringDuration: 1.2, ringOpacity: 0.9, label: 'Surpris' }
}

/** Visibilité (0-1) de chaque variante d'œil/bouche selon l'émotion active. */
const EYE_SHAPE: Record<JarisEmotion, { closed: number; open: number; wide: number; happy: number }> = {
  idle: { closed: 1, open: 0, wide: 0, happy: 0 },
  listening: { closed: 0, open: 1, wide: 0, happy: 0 },
  thinking: { closed: 0, open: 0.6, wide: 0, happy: 0 },
  happy: { closed: 0, open: 0, wide: 0, happy: 1 },
  surprised: { closed: 0, open: 0, wide: 1, happy: 0 }
}

const MOUTH_SHAPE: Record<JarisEmotion, { neutral: number; smile: number; o: number }> = {
  idle: { neutral: 1, smile: 0, o: 0 },
  listening: { neutral: 1, smile: 0, o: 0 },
  thinking: { neutral: 1, smile: 0, o: 0 },
  happy: { neutral: 0, smile: 1, o: 0 },
  surprised: { neutral: 0, smile: 0, o: 1 }
}

const SPRING = { type: 'spring', stiffness: 260, damping: 22 } as const

function Eye({ emotion, glow }: { emotion: JarisEmotion; glow: string }): JSX.Element {
  const shape = EYE_SHAPE[emotion]
  return (
    <svg width="46" height="46" viewBox="0 0 46 46">
      {/* fermé (veille) */}
      <motion.line
        x1="8"
        y1="23"
        x2="38"
        y2="23"
        stroke={glow}
        strokeWidth="4"
        strokeLinecap="round"
        animate={{ opacity: shape.closed }}
        transition={SPRING}
      />
      {/* ouvert (écoute / réflexion) */}
      <motion.circle
        cx="23"
        cy="23"
        r="9"
        fill={glow}
        animate={{ opacity: shape.open, scale: shape.open ? 1 : 0.5 }}
        transition={SPRING}
        style={{ transformOrigin: '23px 23px' }}
      />
      {/* grand ouvert (surpris) */}
      <motion.circle
        cx="23"
        cy="23"
        r="16"
        fill="none"
        stroke={glow}
        strokeWidth="4"
        animate={{ opacity: shape.wide, scale: shape.wide ? 1 : 0.4 }}
        transition={SPRING}
        style={{ transformOrigin: '23px 23px' }}
      />
      {/* content (^) */}
      <motion.path
        d="M6,28 Q23,10 40,28"
        fill="none"
        stroke={glow}
        strokeWidth="5"
        strokeLinecap="round"
        animate={{ opacity: shape.happy, scale: shape.happy ? 1 : 0.5 }}
        transition={SPRING}
        style={{ transformOrigin: '23px 23px' }}
      />
    </svg>
  )
}

function Mouth({ emotion, glow }: { emotion: JarisEmotion; glow: string }): JSX.Element {
  const shape = MOUTH_SHAPE[emotion]
  return (
    <svg width="120" height="46" viewBox="0 0 120 46">
      <motion.path
        d="M25,20 Q60,20 95,20"
        fill="none"
        stroke={glow}
        strokeWidth="5"
        strokeLinecap="round"
        animate={{ opacity: shape.neutral, scale: shape.neutral ? 1 : 0.6 }}
        transition={SPRING}
        style={{ transformOrigin: '60px 20px' }}
      />
      <motion.path
        d="M25,14 Q60,42 95,14"
        fill="none"
        stroke={glow}
        strokeWidth="5"
        strokeLinecap="round"
        animate={{ opacity: shape.smile, scale: shape.smile ? 1 : 0.6 }}
        transition={SPRING}
        style={{ transformOrigin: '60px 20px' }}
      />
      <motion.circle
        cx="60"
        cy="22"
        r="9"
        fill="none"
        stroke={glow}
        strokeWidth="5"
        animate={{ opacity: shape.o, scale: shape.o ? 1 : 0.5 }}
        transition={SPRING}
        style={{ transformOrigin: '60px 22px' }}
      />
    </svg>
  )
}

export default function JarisFace({ emotion, size = 320 }: JarisFaceProps): JSX.Element {
  const style = EMOTION_STYLES[emotion]

  return (
    <div className="jaris-face" style={{ width: size, height: size }}>
      <motion.div
        className="jaris-face__ring"
        style={{ borderColor: style.glow, boxShadow: `0 0 40px ${style.glow}55` }}
        animate={{
          rotate: 360,
          opacity: style.ringOpacity,
          scale: emotion === 'idle' ? [1, 0.98, 1] : 1
        }}
        transition={{
          rotate: { duration: style.ringDuration, repeat: Infinity, ease: 'linear' },
          opacity: { duration: 0.6 },
          scale: { duration: 4, repeat: Infinity, ease: 'easeInOut' }
        }}
      />

      <motion.div
        className="jaris-face__core"
        animate={{
          scale: emotion === 'idle' ? [1, 0.97, 1] : 1,
          filter: `drop-shadow(0 0 12px ${style.glow}aa)`
        }}
        transition={{ scale: { duration: 4.5, repeat: Infinity, ease: 'easeInOut' } }}
      >
        <div className="jaris-face__eyes">
          <Eye emotion={emotion} glow={style.glow} />
          <Eye emotion={emotion} glow={style.glow} />
        </div>
        <Mouth emotion={emotion} glow={style.glow} />
      </motion.div>
    </div>
  )
}
