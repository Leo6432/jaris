/**
 * La mascotte de Jaris (étapes 144-145 : une bulle bleue brillante à deux yeux blancs) dessinée pixel par
 * pixel, pour les deux icônes qui ne peuvent pas être du SVG : l'icône de l'application
 * (`scripts/generate-icon.mjs` -> build/icon.ico : fenêtre, barre des tâches, installeur) et l'icône de la
 * barre système (`electron/services/trayIcon.ts`). Un seul dessin pour les deux, reprenant EXACTEMENT les
 * formes et couleurs du composant `src/components/JarisOrb.tsx` (même repère 120 × 120), pour que l'icône et
 * le personnage de l'application ne se contredisent jamais.
 *
 * Pur (aucune dépendance) : renvoie des pixels RGBA, à encoder en PNG par l'appelant.
 */

type Rgb = [number, number, number]

/** Les trois arrêts du dégradé de la bulle : BODY éclairci de 55 %, BODY (#3d8bff), BODY assombri de 35 %. */
const LIGHT: Rgb = [0xae, 0xd0, 0xff]
const BODY: Rgb = [0x3d, 0x8b, 0xff]
const DARK: Rgb = [0x28, 0x5a, 0xa6]
const WHITE: Rgb = [255, 255, 255]

/** Portion du repère 120 × 120 cadrée dans l'icône : la bulle seule (sans l'ombre au sol), avec une marge. */
const VIEW = { x: 13, y: 15, size: 94 }

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

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * RGBA (alpha non prémultiplié), `size` × `size`. `minimal` : yeux agrandis, comme le composant en dessous de
 * 48 px — sinon deux points invisibles dans l'icône de la barre système (32 px).
 */
export function renderMascotRgba(size: number, minimal = false): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const unit = VIEW.size / size
  const aa = unit * 1.2 // largeur du lissage des bords : un peu plus d'un pixel
  const eyeScale = minimal ? 1.45 : 1

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

      const sphere = cover(Math.hypot(x - 60, y - 62) - 44, aa)
      if (sphere > 0) {
        // Dégradé radial comme le SVG : centre (36 %, 30 %) de la boîte de la bulle, rayon 78 %.
        const t = clamp01(Math.hypot(x - (16 + 0.36 * 88), y - (18 + 0.3 * 88)) / (0.78 * 88))
        over(t < 0.45 ? mix(LIGHT, BODY, t / 0.45) : mix(BODY, DARK, (t - 0.45) / 0.55), sphere)
      }

      // Reflet : ellipse 13 × 7 tournée de -32°, centrée en (42, 38).
      const angle = (32 * Math.PI) / 180
      const dx = x - 42
      const dy = y - 38
      const rx = dx * Math.cos(angle) - dy * Math.sin(angle)
      const ry = dx * Math.sin(angle) + dy * Math.cos(angle)
      over(WHITE, 0.42 * cover(ellipseEdge(rx, ry, 0, 0, 13, 7), aa))

      over(WHITE, cover(ellipseEdge(x, y, 64, 56, 3.8 * eyeScale, 6.8 * eyeScale), aa))
      over(WHITE, cover(ellipseEdge(x, y, 78, 56, 3.8 * eyeScale, 6.8 * eyeScale), aa))

      const o = (py * size + px) * 4
      out[o] = Math.round(r)
      out[o + 1] = Math.round(g)
      out[o + 2] = Math.round(b)
      out[o + 3] = Math.round(a * 255)
    }
  }
  return out
}
