import { useEffect, useId, useRef } from 'react'
import type { RefObject } from 'react'
import type { JarisEmotion } from '@/store/useJarisStore'

/**
 * La mascotte de Jaris — étape 144 (design « rassurant », grand public), redessinée aux étapes 145-146
 * d'après l'image envoyée par Léo : une BULLE bleue avec deux yeux blancs ovales, sans bouche ni antenne.
 * Étape 146 (« c'est un rond 3D moche ») : plus de gros reflet blanc ni d'ombrage sombre en bas — un bleu vif
 * presque uni, dont c'est le BORD qui s'illumine, comme sur son image ; et les yeux regardent autour d'eux de
 * temps en temps au lieu de rester figés.
 *
 * Le composant garde le nom et EXACTEMENT les réglages de l'ancien orbe (emotion, size, audioElRef, onClick,
 * color) : tous les écrans qui l'affichent (accueil vocal, widget, sélecteur de voix) suivent sans
 * modification. Dessiné en SVG, animé en CSS (index.css, `.jaris-mascot`) ; seule la « respiration » qui suit
 * la voix est animée en JavaScript.
 *
 * Sans bouche, tout passe par les yeux et la lumière :
 * - idle       : flotte doucement, cligne des yeux, et regarde autour de lui de temps en temps ;
 * - listening  : halo lumineux qui pulse, yeux un peu plus grands et fixés sur toi (« je t'écoute ») ;
 * - thinking   : regarde en l'air, trois petites bulles de pensée ;
 * - happy      : yeux plissés en sourire (« ^ ^ »), petits rebonds ; la bulle gonfle au rythme de la voix ;
 * - surprised  : yeux ronds et grands.
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

/** Couleur de la bulle par défaut : le bleu vif de l'image de référence de Léo. */
const BODY_COLOR = '#2f88ff'

/** Sous cette taille (widget replié), pas d'ombre, de lueur ni de bulles de pensée : juste la bulle et ses yeux. */
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

/** Éclaircit une couleur hexadécimale (#rrggbb) vers le blanc, pour le bord lumineux de la bulle. */
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

/** Assombrit une couleur hexadécimale (#rrggbb) vers le noir, pour le cœur de la bulle. */
export function darken(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!match) return hex
  const value = parseInt(match[1], 16)
  const channel = (shift: number): number => Math.round(((value >> shift) & 0xff) * (1 - amount))
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** La bulle « respire » avec la voix : 1 = au repos, un peu plus grand quand Jaris parle fort. */
function breathTransform(scale: number): string {
  return `translate(60 62) scale(${scale.toFixed(3)}) translate(-60 -62)`
}

export default function JarisOrb({ emotion, size = 320, audioElRef, onClick, color }: JarisOrbProps): JSX.Element {
  const breathRef = useRef<SVGGElement>(null)
  const uid = useId().replace(/:/g, '')
  const gradientId = `jaris-body-${uid}`
  const rimId = `jaris-rim-${uid}`
  const glowId = `jaris-glow-${uid}`
  const minimal = size < MINIMAL_SIZE_THRESHOLD
  const body = color ?? BODY_COLOR

  // La bulle suit la voix : seulement quand un <audio> est fourni (accueil vocal, widget), et seulement le
  // temps qu'il joue — aucune boucle d'animation qui tourne pour rien le reste du temps.
  useEffect(() => {
    const audioEl = audioElRef?.current
    if (!audioEl) return
    let frame = 0
    let analysis: AudioAnalysis | null = null
    let buffer: Uint8Array<ArrayBuffer> | null = null
    const tick = (): void => {
      const breath = breathRef.current
      if (breath && analysis && buffer) {
        const level = readAudioLevel(analysis.analyser, buffer)
        breath.setAttribute('transform', breathTransform(1 + Math.min(1, level * 3) * 0.07))
      }
      frame = requestAnimationFrame(tick)
    }
    const start = (): void => {
      try {
        analysis ??= getOrCreateAudioAnalysis(audioEl)
        buffer ??= new Uint8Array(analysis.analyser.frequencyBinCount)
      } catch {
        return // pas d'AudioContext disponible : la bulle reste simplement à sa taille
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    const stop = (): void => {
      cancelAnimationFrame(frame)
      breathRef.current?.setAttribute('transform', breathTransform(1))
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

  const eyes =
    emotion === 'happy' ? (
      // Yeux plissés en sourire : deux petits arcs « ^ ^ ».
      <g className="jaris-mascot__eyes jaris-mascot__eyes--happy">
        <path d="M42 54 Q47 45 52 54" />
        <path d="M68 54 Q73 45 78 54" />
      </g>
    ) : (
      <g className="jaris-mascot__eyes">
        <ellipse className="jaris-mascot__eye" cx="47" cy="53" rx="4.8" ry="9.5" />
        <ellipse className="jaris-mascot__eye" cx="73" cy="53" rx="4.8" ry="9.5" />
      </g>
    )

  return (
    <div className={classes} style={{ width: size, height: size }} onClick={onClick}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Jaris">
        <defs>
          {/* Bleu presque uni, qui s'éclaircit seulement tout au bord : c'est le bord qui brille, pas un reflet. */}
          <radialGradient id={gradientId} cx="50%" cy="46%" r="52%">
            <stop offset="0%" stopColor={darken(body, 0.05)} />
            <stop offset="62%" stopColor={body} />
            <stop offset="88%" stopColor={lighten(body, 0.28)} />
            <stop offset="100%" stopColor={lighten(body, 0.6)} />
          </radialGradient>
          {/* Liseré plus clair en haut, qui s'efface vers le bas. */}
          <linearGradient id={rimId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lighten(body, 0.75)} stopOpacity="0.9" />
            <stop offset="55%" stopColor={lighten(body, 0.75)} stopOpacity="0" />
          </linearGradient>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>

        {/* Ombre au sol : se resserre quand la bulle flotte vers le haut. */}
        {!minimal && <ellipse className="jaris-mascot__shadow" cx="60" cy="113" rx="26" ry="4" />}

        <g className="jaris-mascot__body">
          {/* Lueur douce autour de la bulle, comme sur l'image de référence (fond sombre). */}
          {!minimal && <circle className="jaris-mascot__glow" cx="60" cy="62" r="44" fill={body} filter={`url(#${glowId})`} />}
          {/* Halo : visible seulement quand Jaris écoute (CSS), pour dire « je t'entends » sans texte. */}
          <circle className="jaris-mascot__halo" cx="60" cy="62" r="50" fill={body} />

          <g ref={breathRef} transform={breathTransform(1)}>
            <circle className="jaris-mascot__sphere" cx="60" cy="62" r="44" fill={`url(#${gradientId})`} />
            <circle className="jaris-mascot__rim" cx="60" cy="62" r="43.2" fill="none" stroke={`url(#${rimId})`} strokeWidth="1.6" />
            {/* Le regard bouge (CSS) indépendamment du clignement : deux groupes imbriqués, deux animations. */}
            <g className="jaris-mascot__gaze">{eyes}</g>
          </g>

          {emotion === 'thinking' && !minimal && (
            <g className="jaris-mascot__dots">
              <circle cx="96" cy="30" r="3" />
              <circle cx="104" cy="21" r="3.8" />
              <circle cx="113" cy="11" r="4.6" />
            </g>
          )}
        </g>
      </svg>
    </div>
  )
}
