import { nativeImage, type NativeImage } from 'electron'
import { join } from 'path'
import frame from '../../assets/icon-frame.json'
import logoPath from '../../assets/jaris-logo.png?asset'
import { resourcesRoot } from '../paths'
import { EMOTION_COLORS, tintPixels, type OrbEmotion } from '../../shared/emotionColors'
import { encodeIco } from '../../shared/ico'
import { mkdir, writeFile } from 'fs/promises'

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

/**
 * Étape 394 (Léo : « c'est pas possible que le logo en bas de Jaris change aussi de couleur ? ») : l'icône de la barre
 * des tâches et celle près de l'horloge prennent la couleur de ce que fait Jaris, comme l'orbe animée. Au repos, ce sont
 * les icônes d'origine (createAppIcon/createTrayIcon, réduites proprement à l'étape 224) ; dans les autres états, le logo
 * recoloré, réduit par Electron à chaque taille utile (une représentation par échelle d'affichage), gardé en cache.
 */
const SCALES = [1, 1.25, 1.5, 2]
const tintedCache = new Map<string, NativeImage>()

function tintedLogo(color: string, baseSize: number): NativeImage {
  const key = `${color}:${baseSize}`
  const cached = tintedCache.get(key)
  if (cached) return cached
  const logo = nativeImage.createFromPath(logoPath).crop({ x: frame.left, y: frame.top, width: frame.width, height: frame.height })
  const image = nativeImage.createEmpty()
  for (const scaleFactor of SCALES) {
    const size = Math.round(baseSize * scaleFactor)
    const small = logo.resize({ width: size, height: size, quality: 'best' })
    // toBitmap() rend les pixels dans l'ordre B-V-R-A sous Windows et Linux (format natif de Skia).
    const buffer = Buffer.from(tintPixels(small.toBitmap(), color, process.platform !== 'darwin'))
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer })
  }
  tintedCache.set(key, image)
  return image
}

export function appIconFor(emotion: OrbEmotion): NativeImage {
  return emotion === 'idle' ? createAppIcon() : tintedLogo(EMOTION_COLORS[emotion], 32)
}

export function trayIconFor(emotion: OrbEmotion): NativeImage {
  return emotion === 'idle' ? createTrayIcon() : tintedLogo(EMOTION_COLORS[emotion], 16)
}

/**
 * Étape 396 (Léo : « c'est même pas épinglé ») : avec la v0.40.36, la pastille apparaît mais le logo reste turquoise, Jaris
 * n'étant pas épinglé. Windows ignore donc l'icône donnée par setIcon() pour le bouton de la barre des tâches. Essai : la
 * même voie que Chrome pour ses icônes de profil — l'icône de la FENÊTRE déclarée à Windows comme un vrai fichier .ico
 * (propriété « RelaunchIconResource », setAppDetails). Chaque couleur est écrite une fois au démarrage ; au repos, le .ico
 * d'origine. Renvoie null hors Windows ou si l'écriture échoue (rien ne change alors).
 */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]

export async function writeTaskbarIcons(dir: string): Promise<Record<OrbEmotion, string> | null> {
  if (process.platform !== 'win32') return null
  try {
    await mkdir(dir, { recursive: true })
    const logo = nativeImage.createFromPath(logoPath).crop({ x: frame.left, y: frame.top, width: frame.width, height: frame.height })
    const paths = { idle: windowsIconPath() } as Record<OrbEmotion, string>
    for (const emotion of Object.keys(EMOTION_COLORS) as OrbEmotion[]) {
      if (emotion === 'idle') continue
      const images = ICO_SIZES.map((size) => {
        const small = logo.resize({ width: size, height: size, quality: 'best' })
        const tinted = Buffer.from(tintPixels(small.toBitmap(), EMOTION_COLORS[emotion], true))
        const png = nativeImage.createFromBitmap(tinted, { width: size, height: size }).toPNG()
        return { size, png: new Uint8Array(png) }
      })
      const path = join(dir, `jaris-${emotion}.ico`)
      await writeFile(path, encodeIco(images))
      paths[emotion] = path
    }
    return paths
  } catch (err) {
    console.error('[icon] écriture des icônes de la barre des tâches impossible :', err)
    return null
  }
}
