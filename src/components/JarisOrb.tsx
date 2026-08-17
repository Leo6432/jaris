import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { JarisEmotion } from '@/store/useJarisStore'

interface JarisOrbProps {
  emotion: JarisEmotion
  size?: number
  /** Élément <audio> qui joue la voix de Jaris : sert à faire vibrer l'anneau en rythme avec la parole. */
  audioElRef?: RefObject<HTMLAudioElement>
}

interface EmotionStyle {
  color: string
  spinSpeed: number
  coreSpin: number
  pulse: number
}

const EMOTION_STYLES: Record<JarisEmotion, EmotionStyle> = {
  idle: { color: '#33e6c8', spinSpeed: 0.05, coreSpin: 0.12, pulse: 0.02 },
  listening: { color: '#37e2ff', spinSpeed: 0.22, coreSpin: 0.3, pulse: 0.045 },
  thinking: { color: '#ffb648', spinSpeed: 0.85, coreSpin: 0.7, pulse: 0.07 },
  happy: { color: '#4dffa6', spinSpeed: 0.3, coreSpin: 0.4, pulse: 0.06 },
  surprised: { color: '#ff5d7a', spinSpeed: 1.3, coreSpin: 1.1, pulse: 0.12 }
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

interface RingHarmonic {
  freq: number
  amp: number
  phase: number
}

/** Quelques harmoniques fixes (tirées une fois au montage) donnent au contour son aspect "déchiré" irrégulier, sans jamais changer de forme de base. */
function randomHarmonics(count: number): RingHarmonic[] {
  return Array.from({ length: count }, () => ({
    freq: 3 + Math.floor(Math.random() * 6),
    amp: 0.02 + Math.random() * 0.045,
    phase: Math.random() * Math.PI * 2
  }))
}

const RING_SEGMENTS = 140

/** Anneau au contour irrégulier façon hologramme : rayon perturbé par des harmoniques fixes, plus un tremblement proportionnel au niveau audio (vibre quand Jaris parle). */
function drawJaggedRing(
  ctx: CanvasRenderingContext2D,
  baseRadius: number,
  harmonics: RingHarmonic[],
  rotation: number,
  color: string,
  alpha: number,
  jitter: number,
  time: number
): void {
  ctx.beginPath()
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const angle = (i / RING_SEGMENTS) * Math.PI * 2
    let r = baseRadius
    for (const h of harmonics) {
      r += baseRadius * h.amp * Math.sin(angle * h.freq + h.phase + rotation)
    }
    r += baseRadius * jitter * 0.06 * Math.sin(angle * 19 + time * 0.006)
    const x = Math.cos(angle + rotation) * r
    const y = Math.sin(angle + rotation) * r
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
  ctx.lineWidth = 1
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

function drawCore(ctx: CanvasRenderingContext2D, radius: number, angleY: number, color: string): void {
  const projected = CORE_POINTS.map((p) => project(p, angleY, CORE_TILT))
  ctx.lineWidth = 0.6
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

/** Niveau sonore moyen courant (0-1) ; le lissage vient de smoothingTimeConstant sur l'AnalyserNode lui-même. */
function readAudioLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]
  return sum / buffer.length / 255
}

/** Cœur visuel de Jaris façon J.A.R.V.I.S. : anneau holographique irrégulier + noyau filaire, qui vibre avec la voix. */
export default function JarisOrb({ emotion, size = 320, audioElRef }: JarisOrbProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const emotionRef = useRef(emotion)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const angleRef = useRef(0)
  const coreAngleRef = useRef(0)
  const harmonicsRef = useRef({ outer: randomHarmonics(4), inner: randomHarmonics(3) })

  useEffect(() => {
    emotionRef.current = emotion
  }, [emotion])

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
      const level =
        analyserRef.current && audioBufferRef.current ? readAudioLevel(analyserRef.current, audioBufferRef.current) : 0

      angleRef.current += style.spinSpeed * dt
      coreAngleRef.current += style.coreSpin * dt

      const breathe = 1 + Math.sin(time * 0.0015) * style.pulse + level * 0.08

      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.translate(center, center)
      ctx.globalCompositeOperation = 'lighter'

      ctx.shadowColor = style.color
      ctx.shadowBlur = 14 + level * 18
      ctx.lineWidth = 1.6
      drawJaggedRing(ctx, center * 0.86 * breathe, harmonicsRef.current.outer, angleRef.current, style.color, 0.85, level, time)
      drawJaggedRing(
        ctx,
        center * 0.78 * breathe,
        harmonicsRef.current.inner,
        -angleRef.current * 0.55,
        style.color,
        0.45,
        level,
        time
      )

      ctx.shadowBlur = 6
      drawGlassRing(ctx, center * 0.6, style.color, 0.3)
      drawGlassRing(ctx, center * 0.46, style.color, 0.2)

      ctx.shadowBlur = 10 + level * 14
      drawCore(ctx, center * 0.16 * (1 + level * 0.2), coreAngleRef.current, style.color)

      ctx.restore()
      frameId = requestAnimationFrame(draw)
    }

    frameId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frameId)
  }, [size])

  return (
    <div className="jaris-orb" style={{ width: size, height: size }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
