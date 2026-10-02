import { nativeImage, type NativeImage } from 'electron'
import { join } from 'path'
import frame from '../../assets/icon-frame.json'
import logoPath from '../../assets/jaris-logo.png?asset'
import { resourcesRoot } from '../paths'

/**
 * Le même logo transparent pour la fenêtre et l’icône près de l’horloge.
 *
 * Étape 224 (Léo : « le logo de l'application bug ») : sous Windows, l'icône vient de build/icon.ico, qui
 * contient chaque taille déjà réduite proprement (scripts/build-icon.mjs). Avant, la fenêtre recevait le logo
 * en 1008×1008 px et Windows le réduisait lui-même en 16-32 px : les anneaux fins devenaient un motif bruité.
 * Le .ico est lu hors de l'archive asar (extraResources), où nativeImage ne le lit pas toujours.
 */
function windowsIconPath(): string {
  return join(resourcesRoot(), 'build', 'icon.ico')
}

export function createAppIcon(): NativeImage {
  if (process.platform === 'win32') {
    const icon = nativeImage.createFromPath(windowsIconPath())
    if (!icon.isEmpty()) return icon
  }
  return nativeImage.createFromPath(logoPath).crop({ x: frame.left, y: frame.top, width: frame.width, height: frame.height })
}

export function createTrayIcon(): NativeImage {
  if (process.platform === 'win32') {
    const icon = nativeImage.createFromPath(windowsIconPath())
    // Windows choisit dans le .ico la taille de la zone de notification (16 à 32 px selon l'échelle d'affichage).
    if (!icon.isEmpty()) return icon
  }
  return createAppIcon().resize({ width: 32, height: 32, quality: 'best' })
}
