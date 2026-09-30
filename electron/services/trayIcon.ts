import { nativeImage, type NativeImage } from 'electron'
import logoPath from '../../assets/jaris-logo.png?asset'

/** Le même logo transparent pour la fenêtre et l’icône près de l’horloge. */
export function createAppIcon(): NativeImage {
  return nativeImage.createFromPath(logoPath)
}

export function createTrayIcon(): NativeImage {
  return createAppIcon().resize({ width: 32, height: 32, quality: 'best' })
}
