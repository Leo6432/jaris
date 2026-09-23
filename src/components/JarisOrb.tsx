import { useEffect, useId, useRef } from 'react'
import type { RefObject } from 'react'
import type { JarisEmotion } from '@/store/useJarisStore'

/**
 * La mascotte de Jaris — étape 144 (design « rassurant », grand public), redessinée à l'étape 145 d'après
 * l'image envoyée par Léo (« comme ça ») : une BULLE bleue brillante avec deux petits yeux blancs en amande,
 * sans bouche ni antenne. Plus simple que le premier personnage, et lisible jusqu'à 24 px.
 *
 * Le composant garde le nom et EXACTEMENT les réglages de l'ancien orbe (emotion, size, audioElRef, onClick,
 * color) : tous les écrans qui l'affichent (accueil vocal, widget, sélecteur de voix) suivent sans
 * modification. Dessiné en SVG, animé en CSS (index.css, `.jaris-mascot`) ; seule la « respiration » qui suit
 * la voix est animée en JavaScript.
 *
 * Sans bouche, tout passe par les yeux et la lumière :
 * - idle       : flotte doucement, cligne des yeux de temps en temps ;
 * - listening  : halo lumineux qui pulse autour de la bulle, yeux un peu plus grands (« je t'écoute ») ;
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

/** Couleur de la bulle par défaut : un bleu vif et doux, proche de l'accent de l'interface. */
const BODY_COLOR = '#3d8bff'

/** Sous cette taille (widget replié), pas d'ombre au sol ni de bulles de pensée : juste la bulle et ses yeux. */
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

/** Assombrit une couleur hexadécimale (#rrggbb) vers le noir, pour le bord de la bulle. */
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
  const gradientId = `jaris-body-${useId().replace(/:/g, '')}`
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
        <path d="M60 57 Q64 50 68 57" />
        <path d="M74 57 Q78 50 82 57" />
      </g>
    ) : (
      <g className="jaris-mascot__eyes">
        <ellipse className="jaris-mascot__eye" cx="64" cy="56" rx="3.8" ry="6.8" />
        <ellipse className="jaris-mascot__eye" cx="78" cy="56" rx="3.8" ry="6.8" />
      </g>
    )

  return (
    <div className={classes} style={{ width: size, height: size }} onClick={onClick}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Jaris">
        <defs>
          <radialGradient id={gradientId} cx="36%" cy="30%" r="78%">
            <stop offset="0%" stopColor={lighten(body, 0.55)} />
            <stop offset="45%" stopColor={body} />
            <stop offset="100%" stopColor={darken(body, 0.35)} />
          </radialGradient>
        </defs>

        {/* Ombre au sol : se resserre quand la bulle flotte vers le haut. */}
        {!minimal && <ellipse className="jaris-mascot__shadow" cx="60" cy="113" rx="26" ry="4" />}

        <g className="jaris-mascot__body">
          {/* Halo : visible seulement quand Jaris écoute (CSS), pour dire « je t'entends » sans texte. */}
          <circle className="jaris-mascot__halo" cx="60" cy="62" r="50" fill={body} />

          <g ref={breathRef} transform={breathTransform(1)}>
            <circle className="jaris-mascot__sphere" cx="60" cy="62" r="44" fill={`url(#${gradientId})`} />
            {/* Reflet brillant en haut à gauche : c'est lui qui donne l'aspect « bulle ». */}
            <ellipse className="jaris-mascot__shine" cx="42" cy="38" rx="13" ry="7" transform="rotate(-32 42 38)" />
            {eyes}
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
