/**
 * La mascotte de Jaris (étape 144) dessinée pixel par pixel, pour les deux icônes qui ne peuvent pas être du
 * SVG : l'icône de l'application (`scripts/generate-icon.mjs` -> build/icon.ico : fenêtre, barre des tâches,
 * installeur) et l'icône de la barre système (`electron/services/trayIcon.ts`). Un seul dessin pour les deux,
 * reprenant EXACTEMENT les formes et couleurs du composant `src/components/JarisOrb.tsx` (même repère
 * 120 × 120), pour que l'icône et le personnage de l'application ne se contredisent jamais.
 *
 * Pur (aucune dépendance) : renvoie des pixels RGBA, à encoder en PNG par l'appelant.
 */

type Rgb = [number, number, number]

const BODY: Rgb = [0x4b, 0x7f, 0xe8]
const BODY_LIGHT: Rgb = [0xa3, 0xbf, 0xf4] // BODY éclairci de 45 % vers le blanc, comme le dégradé du SVG
const FACE: Rgb = [255, 255, 255]
const INK: Rgb = [0x1f, 0x29, 0x37]
const CHEEK: Rgb = [0xf5, 0x9a, 0xb5]
const ANTENNA: Rgb = [0x9f, 0xb6, 0xe6]
const BULB: Rgb = [0xc7, 0xd4, 0xf0]

/** Portion du repère 120 × 120 cadrée dans l'icône : on coupe l'ombre au sol et les marges. */
const VIEW = { x: 7, y: 3, size: 106 }

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Couverture d'un pixel par une forme dont `edge` est la distance signée au bord (négative = dedans). */
function cover(edge: number, aa: number): number {
  return clamp01(0.5 - edge / aa)
}

function ellipseEdge(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const d = Math.hypot((x - cx) / rx, (y - cy) / ry)
  return (d - 1) * Math.min(rx, ry)
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const t = clamp01(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy))
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy))
}

/** Le sourire « M53 75 Q60 81 67 75 », échantillonné en petits segments. */
const SMILE: Array<[number, number]> = Array.from({ length: 13 }, (_, i) => {
  const t = i / 12
  const x = (1 - t) ** 2 * 53 + 2 * (1 - t) * t * 60 + t ** 2 * 67
  const y = (1 - t) ** 2 * 75 + 2 * (1 - t) * t * 81 + t ** 2 * 75
  return [x, y]
})

function smileDistance(x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i < SMILE.length - 1; i++) {
    best = Math.min(best, segmentDistance(x, y, SMILE[i][0], SMILE[i][1], SMILE[i + 1][0], SMILE[i + 1][1]))
  }
  return best
}

/**
 * RGBA (alpha non prémultiplié), `size` × `size`. `minimal` : sans antenne ni joues, pour les très petites
 * tailles (icône de la barre système en 32 px) où ces détails ne feraient que brouiller le visage.
 */
export function renderMascotRgba(size: number, minimal = false): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const unit = VIEW.size / size
  // Largeur du lissage des bords : un peu plus d'un pixel.
  const aa = unit * 1.2

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = VIEW.x + (px + 0.5) * unit
      const y = VIEW.y + (py + 0.5) * unit
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      // Superpose une couche de couleur `c` avec une couverture `alpha` (opérateur « over »).
      const over = (c: Rgb, alpha: number): void => {
        if (alpha <= 0) return
        const outA = alpha + a * (1 - alpha)
        r = (c[0] * alpha + r * a * (1 - alpha)) / outA
        g = (c[1] * alpha + g * a * (1 - alpha)) / outA
        b = (c[2] * alpha + b * a * (1 - alpha)) / outA
        a = outA
      }

      if (!minimal) {
        over(ANTENNA, cover(segmentDistance(x, y, 60, 24, 60, 13) - 1.5, aa))
        over(BULB, cover(Math.hypot(x - 60, y - 11) - 5, aa))
      }

      const bodyCover = cover(Math.hypot(x - 60, y - 64) - 42, aa)
      if (bodyCover > 0) {
        // Dégradé radial centré en haut à gauche, comme le SVG (cx 38 %, cy 30 %, r 75 %).
        const t = clamp01(Math.hypot(x - (18 + 0.38 * 84), y - (22 + 0.3 * 84)) / (0.75 * 84))
        const shade: Rgb = [0, 1, 2].map((i) => BODY_LIGHT[i] + (BODY[i] - BODY_LIGHT[i]) * t) as Rgb
        over(shade, bodyCover)
      }

      over(FACE, 0.94 * cover(ellipseEdge(x, y, 60, 67, 30, 24), aa))
      over(INK, cover(ellipseEdge(x, y, 48, 63, 5, 7), aa))
      over(INK, cover(ellipseEdge(x, y, 72, 63, 5, 7), aa))
      if (size >= 48) {
        over(FACE, cover(Math.hypot(x - 49.8, y - 60) - 1.8, aa))
        over(FACE, cover(Math.hypot(x - 73.8, y - 60) - 1.8, aa))
      }
      if (!minimal) {
        over(CHEEK, 0.35 * cover(Math.hypot(x - 40, y - 74) - 4, aa))
        over(CHEEK, 0.35 * cover(Math.hypot(x - 80, y - 74) - 4, aa))
      }
      over(INK, cover(smileDistance(x, y) - 1.3, aa))

      const o = (py * size + px) * 4
      out[o] = Math.round(r)
      out[o + 1] = Math.round(g)
      out[o + 2] = Math.round(b)
      out[o + 3] = Math.round(a * 255)
    }
  }
  return out
}
