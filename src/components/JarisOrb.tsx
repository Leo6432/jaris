import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { JarisEmotion } from '@/store/useJarisStore'
import { LOGO_LOOP, logoLoopOffset } from '../../shared/logoOrb'
import { EMOTION_COLORS } from '../../shared/emotionColors'

interface JarisOrbProps {
  emotion: JarisEmotion
  size?: number
  /** Élément <audio> qui joue la voix de Jaris : sert à faire vibrer l'anneau en rythme avec la parole. */
  audioElRef?: RefObject<HTMLAudioElement>
  onClick?: () => void
  /** Remplace UNIQUEMENT la couleur de `EMOTION_STYLES[emotion]` (jamais modifiée elle-même) — vitesse de
   * rotation/pulsation restent celles de `emotion`. Sert au sélecteur de voix (Options → Voix) : même forme
   * reconnaissable (anneau déchiqueté) que sur l'accueil, une couleur différente par voix pour les distinguer
   * (demande explicite de Léo : "fait pas un cercle rond... fait le même cercle que dans l'accueil... change
   * juste la couleur"). */
  color?: string
}

interface EmotionStyle {
  color: string
  spinSpeed: number
  coreSpin: number
  pulse: number
}

const EMOTION_STYLES: Record<JarisEmotion, EmotionStyle> = {
  idle: { color: EMOTION_COLORS.idle, spinSpeed: 0.05, coreSpin: 0.12, pulse: 0.02 },
  listening: { color: EMOTION_COLORS.listening, spinSpeed: 0.22, coreSpin: 0.3, pulse: 0.045 },
  thinking: { color: EMOTION_COLORS.thinking, spinSpeed: 0.85, coreSpin: 0.7, pulse: 0.07 },
  happy: { color: EMOTION_COLORS.happy, spinSpeed: 0.3, coreSpin: 0.4, pulse: 0.06 },
  surprised: { color: EMOTION_COLORS.surprised, spinSpeed: 1.3, coreSpin: 1.1, pulse: 0.12 }
}

type Vec3 = [number, number, number]

/** Répartit N points quasi uniformément sur une sphère (spirale de Fibonacci), pour le maillage filaire du noyau. */
function fibonacciSphere(count: number): Vec3[] {
  const points: Vec3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    points.push([Math.cos(theta) * radiusAtY, y, Math.sin(theta) * radiusAtY])
  }
  return points
}

function squaredDistance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return dx * dx + dy * dy + dz * dz
}

/** Relie chaque point à ses k plus proches voisins pour donner au noyau un aspect "maillage géodésique" triangulé. */
function buildMeshEdges(points: Vec3[], k: number): Array<[number, number]> {
  const seen = new Set<string>()
  const edges: Array<[number, number]> = []
  for (let i = 0; i < points.length; i++) {
    const neighbors = points
      .map((p, j): [number, number] => [j, squaredDistance(points[i], p)])
      .filter(([j]) => j !== i)
      .sort((a, b) => a[1] - b[1])
      .slice(0, k)
    for (const [j] of neighbors) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`
      if (!seen.has(key)) {
        seen.add(key)
        edges.push([i, j])
      }
    }
  }
  return edges
}

const CORE_POINTS = fibonacciSphere(46)
const CORE_EDGES = buildMeshEdges(CORE_POINTS, 3)
const CORE_TILT = 0.5

/**
 * Sous ce seuil (widget replié, barre d'icônes, barre de titre : 20 à 32 px), même dessin que le logo, mais avec un trait
 * d'au moins 1 px et un mouvement plus ample pour rester lisible et vivant (voir draw()).
 */
const MINIMAL_SIZE_THRESHOLD = 48

const LOOP_SEGMENTS = 280

/**
 * La courbe ondulée du logo (shared/logoOrb.ts) : une seule courbe qui fait deux tours, d'où les deux « anneaux » qui se
 * croisent. `scale` = rayon pour 1 (le demi-côté du canvas), `breathe` gonfle la courbe, un tremblement suit le niveau
 * audio (elle vibre quand Jaris parle). `maxRadius` borne le résultat pour que la lueur ne soit jamais coupée par le bord.
 */
function drawLogoLoop(
  ctx: CanvasRenderingContext2D,
  scale: number,
  breathe: number,
  maxRadius: number,
  rotation: number,
  color: string,
  alpha: number,
  jitter: number,
  time: number
): void {
  ctx.beginPath()
  for (let i = 0; i <= LOOP_SEGMENTS; i++) {
    const theta = (i / LOOP_SEGMENTS) * Math.PI * 4
    let r = scale * (LOGO_LOOP.base * breathe + logoLoopOffset(theta))
    r += scale * jitter * 0.04 * Math.sin(theta * 19 + time * 0.006)
    r = Math.min(r, maxRadius)
    const x = Math.cos(theta + rotation) * r
    const y = Math.sin(theta + rotation) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.stroke()
  ctx.globalAlpha = 1
}

function drawGlassRing(ctx: CanvasRenderingContext2D, radius: number, color: string, alpha: number): void {
  ctx.beginPath()
  ctx.arc(0, 0, radius, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.stroke()
  ctx.globalAlpha = 1
}

/** Projette un point 3D (rotation autour de Y + léger tilt fixe autour de X) en coordonnées écran normalisées, avec une profondeur pour l'ombrage. */
function project(point: Vec3, angleY: number, tiltX: number): { x: number; y: number; depth: number } {
  const [x, y, z] = point
  const cosY = Math.cos(angleY)
  const sinY = Math.sin(angleY)
  const x1 = x * cosY - z * sinY
  const z1 = x * sinY + z * cosY
  const cosX = Math.cos(tiltX)
  const sinX = Math.sin(tiltX)
  const y2 = y * cosX - z1 * sinX
  const z2 = y * sinX + z1 * cosX
  return { x: x1, y: y2, depth: (z2 + 1) / 2 }
}

function drawCore(ctx: CanvasRenderingContext2D, radius: number, angleY: number, color: string, lineWidth = 0.6): void {
  const projected = CORE_POINTS.map((p) => project(p, angleY, CORE_TILT))
  ctx.lineWidth = lineWidth
  for (const [a, b] of CORE_EDGES) {
    const pa = projected[a]
    const pb = projected[b]
    const depth = (pa.depth + pb.depth) / 2
    ctx.beginPath()
    ctx.moveTo(pa.x * radius, pa.y * radius)
    ctx.lineTo(pb.x * radius, pb.y * radius)
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.15 + depth * 0.55
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

interface AudioAnalysis {
  analyser: AnalyserNode
  context: AudioContext
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

  const result: AudioAnalysis = { analyser, context: audioCtx }
  audioAnalysisCache.set(audioEl, result)
  return result
}

type WithSinkId = { setSinkId?: (id: string) => Promise<void> }

/**
 * Étape 346 (« le haut-parleur choisi dans les Options n'est pas utilisé ») : une fois relié à l'orbe par
 * createMediaElementSource, l'élément <audio> ne sort plus lui-même — c'est l'AudioContext qui joue le son. La sortie
 * choisie s'applique donc aux deux (l'élément seul, tant qu'aucun orbe ne l'a relié). `''` = sortie par défaut.
 */
export async function setVoiceOutputDevice(audioEl: HTMLAudioElement, sinkId: string): Promise<void> {
  const targets: WithSinkId[] = [audioEl as HTMLAudioElement & WithSinkId]
  const analysis = audioAnalysisCache.get(audioEl)
  if (analysis) targets.push(analysis.context as AudioContext & WithSinkId)
  await Promise.all(targets.map((target) => (target.setSinkId ? target.setSinkId.call(target, sinkId).catch(() => {}) : undefined)))
}

/** Niveau sonore moyen courant (0-1) ; le lissage vient de smoothingTimeConstant sur l'AnalyserNode lui-même. */
function readAudioLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]
  return sum / buffer.length / 255
}

/** Cœur visuel de Jaris façon J.A.R.V.I.S. : anneau holographique irrégulier + noyau filaire, qui vibre avec la voix. */
export default function JarisOrb({ emotion, size = 320, audioElRef, onClick, color }: JarisOrbProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const emotionRef = useRef(emotion)
  const colorRef = useRef(color)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const angleRef = useRef(0)
  const coreAngleRef = useRef(0)

  useEffect(() => {
    emotionRef.current = emotion
  }, [emotion])

  useEffect(() => {
    colorRef.current = color
  }, [color])

  useEffect(() => {
    const audioEl = audioElRef?.current
    if (!audioEl) return
    const { analyser } = getOrCreateAudioAnalysis(audioEl)
    analyserRef.current = analyser
    audioBufferRef.current = new Uint8Array(analyser.frequencyBinCount)
  }, [audioElRef])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.scale(dpr, dpr)

    const center = size / 2
    let lastTime = performance.now()
    let frameId: number

    const draw = (time: number): void => {
      const dt = Math.min(0.05, (time - lastTime) / 1000)
      lastTime = time

      const style = EMOTION_STYLES[emotionRef.current]
      const color = colorRef.current ?? style.color
      const level =
        analyserRef.current && audioBufferRef.current ? readAudioLevel(analyserRef.current, audioBufferRef.current) : 0

      angleRef.current += style.spinSpeed * dt
      coreAngleRef.current += style.coreSpin * dt

      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.translate(center, center)
      ctx.globalCompositeOperation = 'lighter'

      // Étape 393 (Léo : « fais en sorte que ce soit pareil que le logo ») : même dessin que le logo à toutes les tailles
      // — la courbe ondulée à deux tours, les deux cercles lisses et le noyau maillé, aux proportions mesurées sur le
      // logo (shared/logoOrb.ts). Seuls l'épaisseur minimale du trait et l'ampleur du mouvement changent en petit.
      const minimal = size < MINIMAL_SIZE_THRESHOLD
      // En petit, respiration et rotation amplifiées : le réglage de EMOTION_STYLES est pensé pour 160-320 px, où un
      // mouvement discret reste visible ; sur 30 px, le même mouvement devient imperceptible (Léo : « ça ne bouge pas »).
      const breathe = minimal
        ? 1 + Math.sin(time * 0.0015) * style.pulse * 2 + level * 0.06
        : 1 + Math.sin(time * 0.0015) * style.pulse + level * 0.06
      const rotation = angleRef.current * (minimal ? 2.5 : 1)
      const stroke = Math.max(minimal ? 1 : 1.4, center * LOGO_LOOP.stroke)

      ctx.shadowColor = color
      ctx.shadowBlur = Math.max(4, center * 0.07) + level * 8
      ctx.lineWidth = stroke
      // Marge sous le bord réel du canvas pour que la lueur ait la place de s'estomper avant le bord.
      drawLogoLoop(ctx, center, breathe, center * 0.93 - stroke / 2, rotation, color, 0.92, level, time)

      ctx.shadowBlur = Math.max(3, center * 0.05)
      for (const radius of LOGO_LOOP.circles) drawGlassRing(ctx, center * radius, color, 0.82)

      ctx.shadowBlur = Math.max(3, center * 0.05) + level * 6
      drawCore(ctx, center * LOGO_LOOP.core * (1 + level * 0.2), coreAngleRef.current * (minimal ? 1.5 : 1), color, Math.max(minimal ? 0.8 : 0.6, center * 0.008))

      ctx.restore()
      frameId = requestAnimationFrame(draw)
    }

    frameId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frameId)
  }, [size])

  return (
    <div
      className={`jaris-orb${onClick ? ' jaris-orb--clickable' : ''}`}
      style={{ width: size, height: size }}
      onClick={onClick}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
