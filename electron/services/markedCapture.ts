import { spawn } from 'child_process'
import { nativeImage, type NativeImage } from 'electron'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MARKS_CAPTURE_SCRIPT,
  drawMarks,
  parseMarksCaptureOutput,
  scaleMarks,
  selectMarks,
  type MarksCaptureOutput,
  type ScreenMark
} from './screenMarks'
import { MAX_SCREENSHOT_WIDTH, captureScreenForPilot } from './vision'

/**
 * Étape 256 — la capture d'une étape de pilotage (computerUse.ts) : l'écran avec les boutons de la fenêtre visée
 * encadrés et numérotés (screenMarks.ts). Si Windows ne répond pas (script en erreur, délai dépassé), on reprend la
 * capture d'Electron d'avant, sans numéros : le pilotage par position et le viseur restent possibles.
 */
export interface PilotCapture {
  /** L'image envoyée au modèle de vision, réduite à MAX_SCREENSHOT_WIDTH, numéros dessinés s'il y en a. */
  imageBase64: string
  width: number
  height: number
  /** Image -> écran, dans le repère des clics (`physical`). */
  scale: number
  /** La capture à pleine résolution, SANS numéros : le viseur (MAI-UI) y recadre son zoom. */
  full: NativeImage
  /** Éléments numérotés, en coordonnées d'écran (repère des clics). Vide = pas d'arbre exploitable. */
  marks: ScreenMark[]
  /** Vrai : coordonnées en pixels réels (capture sensible au DPI) ; le clic doit être fait dans ce repère. */
  physical: boolean
  /** Titre de la fenêtre visée. */
  window?: string
}

/** Lecture des éléments + capture : un gros onglet de navigateur peut prendre plusieurs secondes, jamais une minute. */
const CAPTURE_TIMEOUT_MS = 30_000

function runCaptureScript(png: string): Promise<MarksCaptureOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', MARKS_CAPTURE_SCRIPT], {
      windowsHide: true,
      // Le processus principal d'Electron possède toutes les fenêtres de Jaris : c'est lui qu'on écarte.
      env: { ...process.env, JARIS_MARKS_PNG: png, JARIS_PID: String(process.pid) }
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`pas de réponse de Windows en ${CAPTURE_TIMEOUT_MS / 1000} s`))
    }, CAPTURE_TIMEOUT_MS)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => (out += chunk))
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const parsed = code === 0 ? parseMarksCaptureOutput(out) : null
      if (parsed) resolve(parsed)
      else reject(new Error(err.trim().split('\n')[0] || `code de sortie ${code}`))
    })
  })
}

async function captureWithMarks(): Promise<PilotCapture> {
  const png = join(tmpdir(), `jaris-pilote-${process.pid}.png`)
  try {
    const data = await runCaptureScript(png)
    const full = nativeImage.createFromPath(png)
    if (full.isEmpty()) throw new Error('capture illisible')
    const size = full.getSize()
    const small = size.width > MAX_SCREENSHOT_WIDTH ? full.resize({ width: MAX_SCREENSHOT_WIDTH, quality: 'best' }) : full
    const { width, height } = small.getSize()
    const scale = size.width / width
    const marks = selectMarks(data.elements, size.width, size.height)
    let image = small
    if (marks.length) {
      const drawn = drawMarks(small.toBitmap(), width, height, scaleMarks(marks, scale))
      image = nativeImage.createFromBitmap(drawn, { width, height })
    }
    return { imageBase64: image.toPNG().toString('base64'), width, height, scale, full, marks, physical: true, window: data.window }
  } finally {
    // Une capture de l'écran de Léo ne doit pas traîner sur le disque.
    await rm(png, { force: true }).catch(() => {})
  }
}

/**
 * Capture d'une étape. Ne lève que si les DEUX captures échouent ; `onFallback` reçoit la raison quand on a dû se
 * passer des numéros, pour qu'elle apparaisse dans le journal au lieu de disparaître.
 */
export async function capturePilotScreen(onFallback?: (reason: string) => void): Promise<PilotCapture> {
  if (process.platform === 'win32') {
    try {
      return await captureWithMarks()
    } catch (err) {
      onFallback?.(err instanceof Error ? err.message : String(err))
    }
  }
  const { imageBase64, scale, width, height, full } = await captureScreenForPilot()
  return { imageBase64, scale, width, height, full, marks: [], physical: false }
}
