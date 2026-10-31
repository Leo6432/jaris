/**
 * Couleur de l'orbe de Jaris selon ce qu'il fait — une seule table pour l'orbe animée (src/components/JarisOrb.tsx) et
 * pour l'icône de la barre des tâches et de la zone de notification (étape 394, electron/services/trayIcon.ts), pour que
 * les deux ne divergent jamais.
 */
export type OrbEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

export const EMOTION_COLORS: Record<OrbEmotion, string> = {
  idle: '#33e6c8',
  listening: '#37e2ff',
  thinking: '#ffb648',
  happy: '#4dffa6',
  surprised: '#ff5d7a'
}

export function isOrbEmotion(value: unknown): value is OrbEmotion {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EMOTION_COLORS, value)
}

/**
 * Recolore une image du logo (pixels sur 4 octets, ordre B-V-R-A ou R-V-B-A : on n'écrit que dans le même ordre) dans
 * `color`, en gardant la transparence et l'intensité de chaque pixel — la lueur reste une lueur, seule la teinte change.
 * `blueFirst` : true pour l'ordre B-V-R-A (celui de nativeImage.toBitmap() sous Windows et Linux).
 */
export function tintPixels(pixels: Uint8Array, color: string, blueFirst: boolean): Uint8Array {
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  const [c0, c1, c2] = blueFirst ? [rgb[2], rgb[1], rgb[0]] : rgb
  const out = new Uint8Array(pixels.length)
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const intensity = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255
    out[i] = Math.round(c0 * intensity)
    out[i + 1] = Math.round(c1 * intensity)
    out[i + 2] = Math.round(c2 * intensity)
    out[i + 3] = pixels[i + 3]
  }
  return out
}
