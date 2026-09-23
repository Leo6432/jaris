import { useEffect, useId, useRef } from 'react'
import type { RefObject } from 'react'
import type { JarisEmotion } from '@/store/useJarisStore'

/**
 * La mascotte de Jaris — étape 144, Léo : « un design rassurant » (grand public, plus de science-fiction),
 * et pour l'ancien cercle au bord irrégulier : « je te laisse carte blanche, Grok a une petite mascotte ».
 *
 * Un petit personnage rond et bleu, avec un visage clair, de grands yeux et une antenne : on doit y lire
 * « un assistant gentil », jamais « une machine ». Le composant garde le nom et EXACTEMENT les réglages de
 * l'ancien orbe (emotion, size, audioElRef, onClick, color) : tous les écrans qui l'affichent (accueil vocal,
 * widget, sélecteur de voix) suivent sans modification.
 *
 * Dessiné en SVG (plus en canvas) : net à toutes les tailles, de 24 px dans le widget replié à 320 px sur
 * l'accueil, et animé en CSS (index.css, `.jaris-mascot`). Seule la bouche est animée en JavaScript, pour
 * suivre la voix de Jaris quand il parle.
 *
 * Ce que chaque humeur montre, sans avoir besoin de lire le statut :
 * - idle       : flotte doucement et cligne des yeux de temps en temps ;
 * - listening  : grands yeux attentifs, antenne verte qui pulse (« je t'écoute ») ;
 * - thinking   : regarde en l'air, antenne ambre, trois petits points ;
 * - happy      : sourire, petits rebonds ; la bouche s'ouvre au rythme de la voix ;
 * - surprised  : yeux ronds, bouche en « o ».
 */
interface JarisOrbProps {
  emotion: JarisEmotion
  size?: number
  /** Élément <audio> qui joue la voix de Jaris : la bouche s'ouvre en rythme avec la parole. */
  audioElRef?: RefObject<HTMLAudioElement>
  onClick?: () => void
  /** Couleur du corps (sélecteur de voix, Options → Voix : même mascotte, une couleur par voix). */
  color?: string
}

/** Couleur du corps par défaut : le bleu d'accent de l'interface (--ui-accent). */
const BODY_COLOR = '#4b7fe8'

/** Couleur de la petite boule de l'antenne selon l'humeur : le seul signal coloré, pour ne pas surcharger. */
const ANTENNA_COLOR: Record<JarisEmotion, string> = {
  idle: '#c7d4f0',
  listening: '#34c27a',
  thinking: '#f0a830',
  happy: '#7fb0ff',
  surprised: '#f0a830'
}

/** Sous cette taille (widget replié), on ne garde que le corps et les yeux : antenne et joues deviennent du bruit. */
export const MINIMAL_SIZE_THRESHOLD = 48

interface AudioAnalysis {
  analyser: AnalyserNode
}

/**
 * Un seul AudioContext par élément <audio>, mis en cache : createMediaElementSource() ne peut être appelé
 * qu'une fois par élément (sinon exception), et React StrictMode monte/démonte les effets deux fois en dev.
 */
const audioAnalysisCache = new WeakMap<HTMLAudioElement, AudioAnalysis>()

function getOrCreateAudioAnalysis(audioEl: HTMLAudioElement): AudioAnalysis {
  const cached = audioAnalysisCache.get(audioEl)
  if (cached) return cached
  const audioCtx = new AudioContext()
  const source = audioCtx.createMediaElementSource(audioEl)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 64
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)
  analyser.connect(audioCtx.destination)
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  const result: AudioAnalysis = { analyser }
  audioAnalysisCache.set(audioEl, result)
  return result
}

/** Niveau sonore moyen courant (0-1). */
function readAudioLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]
  return sum / buffer.length / 255
}

/** Éclaircit une couleur hexadécimale (#rrggbb) vers le blanc, pour le haut du dégradé du corps. */
export function lighten(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!match) return hex
  const value = parseInt(match[1], 16)
  const channel = (shift: number): number => {
    const c = (value >> shift) & 0xff
    return Math.round(c + (255 - c) * amount)
  }
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** Sourire ouvert étiré verticalement depuis son bord haut : 1 = au repos, plus grand = bouche plus ouverte. */
function mouthTransform(openness: number): string {
  return `translate(60 74) scale(1 ${openness.toFixed(2)}) translate(-60 -74)`
}

export default function JarisOrb({ emotion, size = 320, audioElRef, onClick, color }: JarisOrbProps): JSX.Element {
  const mouthRef = useRef<SVGGElement>(null)
  const gradientId = `jaris-body-${useId().replace(/:/g, '')}`
  const minimal = size < MINIMAL_SIZE_THRESHOLD
  const body = color ?? BODY_COLOR

  // Bouche qui suit la voix : seulement quand un <audio> est fourni (accueil vocal, widget), et seulement le
  // temps qu'il joue — aucune boucle d'animation qui tourne pour rien le reste du temps.
  useEffect(() => {
    const audioEl = audioElRef?.current
    if (!audioEl) return
    let frame = 0
    let analysis: AudioAnalysis | null = null
    let buffer: Uint8Array<ArrayBuffer> | null = null
    const tick = (): void => {
      const mouth = mouthRef.current
      if (mouth && analysis && buffer) {
        const level = readAudioLevel(analysis.analyser, buffer)
        mouth.setAttribute('transform', mouthTransform(0.55 + Math.min(1, level * 3) * 1.1))
      }
      frame = requestAnimationFrame(tick)
    }
    const start = (): void => {
      try {
        analysis ??= getOrCreateAudioAnalysis(audioEl)
        buffer ??= new Uint8Array(analysis.analyser.frequencyBinCount)
      } catch {
        return // pas d'AudioContext disponible : la bouche garde simplement sa forme de sourire
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    const stop = (): void => {
      cancelAnimationFrame(frame)
      mouthRef.current?.setAttribute('transform', mouthTransform(1))
    }
    audioEl.addEventListener('play', start)
    audioEl.addEventListener('pause', stop)
    audioEl.addEventListener('ended', stop)
    if (!audioEl.paused) start()
    return () => {
      stop()
      audioEl.removeEventListener('play', start)
      audioEl.removeEventListener('pause', stop)
      audioEl.removeEventListener('ended', stop)
    }
  }, [audioElRef])

  const classes = [
    'jaris-orb',
    'jaris-mascot',
    `jaris-mascot--${emotion}`,
    minimal ? 'jaris-mascot--minimal' : '',
    onClick ? 'jaris-orb--clickable' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} style={{ width: size, height: size }} onClick={onClick}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Jaris">
        <defs>
          <radialGradient id={gradientId} cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor={lighten(body, 0.45)} />
            <stop offset="100%" stopColor={body} />
          </radialGradient>
        </defs>

        {/* Ombre au sol : se resserre quand la mascotte flotte vers le haut. */}
        {!minimal && <ellipse className="jaris-mascot__shadow" cx="60" cy="113" rx="26" ry="4" />}

        <g className="jaris-mascot__body">
          {!minimal && (
            <g className="jaris-mascot__antenna">
              <line x1="60" y1="24" x2="60" y2="13" />
              <circle className="jaris-mascot__bulb" cx="60" cy="11" r="5" fill={ANTENNA_COLOR[emotion]} />
            </g>
          )}

          <circle cx="60" cy="64" r="42" fill={`url(#${gradientId})`} />
          <ellipse className="jaris-mascot__face" cx="60" cy="67" rx="30" ry="24" />

          <g className="jaris-mascot__eyes">
            <g className="jaris-mascot__eye">
              <ellipse cx="48" cy="63" rx="5" ry="7" />
              <circle className="jaris-mascot__glint" cx="49.8" cy="60" r="1.8" />
            </g>
            <g className="jaris-mascot__eye">
              <ellipse cx="72" cy="63" rx="5" ry="7" />
              <circle className="jaris-mascot__glint" cx="73.8" cy="60" r="1.8" />
            </g>
          </g>

          {!minimal && (
            <>
              <circle className="jaris-mascot__cheek" cx="40" cy="74" r="4" />
              <circle className="jaris-mascot__cheek" cx="80" cy="74" r="4" />
            </>
          )}

          {emotion === 'surprised' ? (
            <circle className="jaris-mascot__mouth-o" cx="60" cy="78" r="3.5" />
          ) : emotion === 'happy' ? (
            <g ref={mouthRef} transform={mouthTransform(1)}>
              <path className="jaris-mascot__mouth-open" d="M52 74 Q60 85 68 74 Z" />
            </g>
          ) : (
            <path className="jaris-mascot__mouth" d="M53 75 Q60 81 67 75" />
          )}

          {emotion === 'thinking' && !minimal && (
            <g className="jaris-mascot__dots">
              <circle cx="92" cy="30" r="3" />
              <circle cx="101" cy="22" r="3.6" />
              <circle cx="111" cy="13" r="4.2" />
            </g>
          )}
        </g>
      </svg>
    </div>
  )
}
