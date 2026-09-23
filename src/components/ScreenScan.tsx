import { useEffect, useRef } from 'react'

/** Même cyan que JarisOrb en émotion "listening" (voir EMOTION_STYLES) : le scan doit se reconnaître comme du Jaris. */
const SCAN_COLOR = '#37e2ff'
const SWEEP_DURATION_MS = 2600
const BEAM_HEIGHT = 220
const CORNER_SIZE = 42
const CORNER_MARGIN = 28
/** Portion (début et fin) du cycle de balayage pendant laquelle la ligne s'estompe, pour éviter un saut net au rebouclage. */
const FADE_ZONE = 0.06

function drawCorners(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save()
  ctx.strokeStyle = SCAN_COLOR
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.55
  ctx.shadowColor = SCAN_COLOR
  ctx.shadowBlur = 12

  const corners: Array<[number, number, number, number]> = [
    [CORNER_MARGIN, CORNER_MARGIN, 1, 1],
    [width - CORNER_MARGIN, CORNER_MARGIN, -1, 1],
    [CORNER_MARGIN, height - CORNER_MARGIN, 1, -1],
    [width - CORNER_MARGIN, height - CORNER_MARGIN, -1, -1]
  ]
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath()
    ctx.moveTo(x + CORNER_SIZE * dx, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + CORNER_SIZE * dy)
    ctx.stroke()
  }
  ctx.restore()
}

/** Ligne de balayage + traînée lumineuse dégradée au-dessus, façon faisceau qui descend l'écran. */
function drawScanLine(ctx: CanvasRenderingContext2D, width: number, y: number, alpha: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = alpha

  const beamTop = Math.max(0, y - BEAM_HEIGHT)
  const gradient = ctx.createLinearGradient(0, beamTop, 0, y)
  gradient.addColorStop(0, 'rgba(55, 226, 255, 0)')
  gradient.addColorStop(1, 'rgba(55, 226, 255, 0.16)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, beamTop, width, y - beamTop)

  ctx.shadowColor = SCAN_COLOR
  ctx.shadowBlur = 24
  ctx.strokeStyle = SCAN_COLOR
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(width, y)
  ctx.stroke()

  ctx.restore()
}

/**
 * Overlay plein écran (étape 18) : ligne de balayage cyan façon J.A.R.V.I.S. qui descend l'écran en
 * boucle, avec des repères d'angle statiques — retour visuel pendant que Jaris analyse une capture d'écran
 * (vision.ts / electron/services/scanOverlay.ts pilotent l'affichage de cette fenêtre depuis le process
 * principal). Fenêtre dédiée, entièrement transparente et cliquable au travers.
 */
export default function ScreenScan(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    document.documentElement.classList.add('body--scan')
    document.body.classList.add('body--scan')
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    let frameId: number
    const draw = (time: number): void => {
      const width = window.innerWidth
      const height = window.innerHeight
      ctx.clearRect(0, 0, width, height)

      const progress = (time % SWEEP_DURATION_MS) / SWEEP_DURATION_MS
      const y = progress * height
      const edgeFade = Math.min(1, progress / FADE_ZONE, (1 - progress) / FADE_ZONE)

      drawCorners(ctx, width, height)
      drawScanLine(ctx, width, y, Math.max(0.12, edgeFade))

      frameId = requestAnimationFrame(draw)
    }
    frameId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div className="screen-scan">
      <canvas ref={canvasRef} />
    </div>
  )
}
