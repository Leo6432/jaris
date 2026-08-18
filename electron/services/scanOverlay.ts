import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'

/**
 * Fenêtre plein écran transparente, cliquable au travers (ignoreMouseEvents), qui affiche l'animation de
 * scan façon J.A.R.V.I.S. (étape 18) pendant que Jaris analyse une capture d'écran (vision.ts). Gardée en
 * singleton (show/hide) plutôt que recréée à chaque appel : évite de recharger tout le bundle renderer à
 * chaque fois que l'utilisateur demande à Jaris de regarder l'écran.
 */
let overlayWindow: BrowserWindow | null = null
/** Voir showScanOverlay : force régulièrement cette fenêtre au premier plan pendant qu'elle est affichée. */
let moveTopInterval: ReturnType<typeof setInterval> | null = null

function loadOverlayRenderer(win: BrowserWindow): void {
  const isDev = !app.isPackaged
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=scan`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'scan' } })
  }
}

function ensureOverlayWindow(): BrowserWindow {
  if (overlayWindow) return overlayWindow

  // Écran principal uniquement : c'est aussi le seul que capture vision.ts (captureScreenshotBase64), donc
  // l'animation reste cohérente avec ce que Jaris regarde réellement.
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    show: false
  })

  // Purement décorative : aucun clic ne doit jamais être intercepté par cette fenêtre.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Ceinture et bretelles : même si le minutage (capture avant d'afficher l'overlay, voir vision.ts) ne
  // devrait jamais les faire se chevaucher, cette fenêtre ne doit littéralement jamais pouvoir apparaître
  // dans une capture d'écran.
  win.setContentProtection(true)

  loadOverlayRenderer(win)
  win.on('closed', () => {
    overlayWindow = null
  })

  overlayWindow = win
  return win
}

/** Affiche l'animation de scan plein écran, sans jamais voler le focus de la fenêtre active. */
export function showScanOverlay(): void {
  const win = ensureOverlayWindow()
  win.showInactive()
  win.moveTop()

  // Sur Windows, la barre des tâches garde son propre "always on top" géré par le shell : un simple
  // alwaysOnTop côté Electron (même au niveau "screen-saver", déjà le plus élevé disponible) ne suffit pas
  // toujours à rester au-dessus d'elle, elle peut reprendre le dessus après coup. Reforcer cette fenêtre au
  // premier plan à intervalle régulier tant qu'elle est affichée est le contournement habituel.
  if (moveTopInterval) clearInterval(moveTopInterval)
  moveTopInterval = setInterval(() => {
    if (overlayWindow?.isVisible()) overlayWindow.moveTop()
  }, 250)
}

/** Cache l'animation une fois l'analyse de vision terminée (succès ou échec). */
export function hideScanOverlay(): void {
  if (moveTopInterval) {
    clearInterval(moveTopInterval)
    moveTopInterval = null
  }
  overlayWindow?.hide()
}
