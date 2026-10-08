import { spawn } from 'child_process'
import { nativeImage, type NativeImage } from 'electron'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MARKS_CAPTURE_SCRIPT,
  drawMarks,
  offsetElements,
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
  /** Étape 263 : poignée de la fenêtre capturée (où agir) — une boîte de dialogue de la fenêtre gardée, s'il y en a une. */
  hwnd?: string
  /** Étape 263 : la fenêtre principale à garder d'une étape à l'autre. */
  root?: string
  /** Étape 263 : la fenêtre gardée demandée, présente seulement si elle existe encore. */
  target?: string
  /** Étape 263 : vrai = l'image est la fenêtre SEULE (même cachée derrière celle de Léo), pas l'écran. */
  windowOnly?: boolean
  /** Étape 263 : coin haut gauche de l'image à l'écran (celui de la fenêtre si windowOnly, sinon 0,0). */
  origin?: { x: number; y: number }
}

/** Étape 263 : quelle fenêtre capturer, et comment. Sans options : exactement la capture d'avant. */
export interface PilotCaptureOptions {
  /** La fenêtre gardée par la tâche (si elle existe encore). */
  hwnd?: string
  /** Fenêtres à ignorer en cherchant la fenêtre visée (celles d'avant l'ouverture d'une application). */
  exclude?: string[]
  /** Capturer la fenêtre seule, même cachée, plutôt que l'écran. */
  windowOnly?: boolean
}

/** Lecture des éléments + capture : un gros onglet de navigateur peut prendre plusieurs secondes, jamais une minute. */
const CAPTURE_TIMEOUT_MS = 30_000

function runCaptureScript(png: string, options: PilotCaptureOptions): Promise<MarksCaptureOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', MARKS_CAPTURE_SCRIPT], {
      windowsHide: true,
      // Le processus principal d'Electron possède toutes les fenêtres de Jaris : c'est lui qu'on écarte.
      // Étape 263 : poignées de fenêtres (nombres produits par Windows lui-même) et mode de capture, rien d'autre.
      env: {
        ...process.env,
        JARIS_MARKS_PNG: png,
        JARIS_PID: String(process.pid),
        JARIS_TARGET_HWND: options.hwnd ?? '',
        JARIS_EXCLUDE_HWNDS: (options.exclude ?? []).join(','),
        JARIS_CAPTURE: options.windowOnly ? 'window' : 'screen'
      }
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

async function captureWithMarks(options: PilotCaptureOptions): Promise<PilotCapture> {
  const png = join(tmpdir(), `jaris-pilote-${process.pid}.png`)
  try {
    const data = await runCaptureScript(png, options)
    const full = nativeImage.createFromPath(png)
    if (full.isEmpty()) throw new Error('capture illisible')
    const size = full.getSize()
    const small = size.width > MAX_SCREENSHOT_WIDTH ? full.resize({ width: MAX_SCREENSHOT_WIDTH, quality: 'best' }) : full
    const { width, height } = small.getSize()
    const scale = size.width / width
    // Étape 263 : image de la fenêtre seule -> éléments ramenés dans son repère pour les choisir et les dessiner, puis
    // rendus au repère de l'écran (celui des clics quand le pilote doit emprunter la souris).
    const windowOnly = data.capture === 'window' && !!data.rect
    const origin = windowOnly && data.rect ? { x: data.rect.x, y: data.rect.y } : { x: 0, y: 0 }
    const local = selectMarks(offsetElements(data.elements, -origin.x, -origin.y), size.width, size.height)
    const marks = offsetElements(local, origin.x, origin.y)
    let image = small
    if (local.length) {
      const drawn = drawMarks(small.toBitmap(), width, height, scaleMarks(local, scale))
      image = nativeImage.createFromBitmap(drawn, { width, height })
    }
    return {
      imageBase64: image.toPNG().toString('base64'), width, height, scale, full, marks, physical: true, window: data.window,
      hwnd: data.hwnd, root: data.root, target: data.target, windowOnly, origin
    }
  } finally {
    // Une capture de l'écran de Léo ne doit pas traîner sur le disque.
    await rm(png, { force: true }).catch(() => {})
  }
}

/**
 * Étape 263 : le pilotage en arrière-plan (fenêtre capturée seule, actions sans la souris) n'existe que sous Windows.
 * Ailleurs (développement), le pilotage d'avant, d'emblée.
 */
export function canCaptureWindow(): boolean {
  return process.platform === 'win32'
}

/**
 * Capture d'une étape. Ne lève que si les DEUX captures échouent ; `onFallback` reçoit la raison quand on a dû se
 * passer des numéros, pour qu'elle apparaisse dans le journal au lieu de disparaître.
 */
export async function capturePilotScreen(onFallback?: (reason: string) => void, options: PilotCaptureOptions = {}): Promise<PilotCapture> {
  if (process.platform === 'win32') {
    try {
      return await captureWithMarks(options)
    } catch (err) {
      onFallback?.(err instanceof Error ? err.message : String(err))
    }
  }
  const { imageBase64, scale, width, height, full } = await captureScreenForPilot()
  return { imageBase64, scale, width, height, full, marks: [], physical: false }
}
