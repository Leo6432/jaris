import { nativeImage, type NativeImage } from 'electron'
import frame from '../../assets/icon-frame.json'
import logoPath from '../../assets/jaris-logo.png?asset'

/** Le même logo transparent pour la fenêtre et l’icône près de l’horloge. */
export function createAppIcon(): NativeImage {
  return nativeImage.createFromPath(logoPath).crop({ x: frame.left, y: frame.top, width: frame.width, height: frame.height })
}

export function createTrayIcon(): NativeImage {
  return createAppIcon().resize({ width: 32, height: 32, quality: 'best' })
}
