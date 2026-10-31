/**
 * Forme exacte du logo de Jaris (assets/jaris-logo.png), pour que l'orbe animée lui ressemble partout (étape 393,
 * Léo : « c'est un peu au hasard les cercles, fais en sorte que ce soit pareil que le logo »). Avant, chaque orbe tirait
 * au hasard le bord de ses deux anneaux au montage : chaque orbe était différente, aucune ne ressemblait au logo.
 *
 * Mesuré sur le logo lui-même, pas dessiné à l'œil : les deux « anneaux » ondulés du logo sont en réalité UNE seule
 * courbe qui fait DEUX tours (en la suivant, on revient à son point de départ seulement après 4π). Son rayon a été relevé
 * tous les 0,25° puis décomposé en série de Fourier (17 termes, ceux de plus de 0,4 % du rayon) ; tracée par-dessus le
 * logo, la courbe suit son trait. Rayon(θ) = base + Σ amplitude · sin(fréquence · θ / 2 + phase), θ de 0 à 4π.
 *
 * Toutes les longueurs sont en fraction du demi-côté du canvas (1 = du centre au bord). Copie identique dans
 * phone/app.js (vérifiée par scripts/test-logo-orb.mjs).
 */
export const LOGO_LOOP = {
  base: 0.7204,
  terms: [
    [1, 0.0467, -2.7774],
    [2, 0.0114, 2.35],
    [3, 0.0173, 0.8974],
    [5, 0.0358, 1.8313],
    [6, 0.0215, 3.0089],
    [7, 0.0366, -3.0107],
    [8, 0.0187, -0.6346],
    [9, 0.0143, -2.8129],
    [10, 0.0116, -1.0467],
    [11, 0.0108, -2.4242],
    [12, 0.0076, 2.8719],
    [13, 0.0136, 2.6271],
    [14, 0.0061, -2.3486],
    [15, 0.0212, 0.1378],
    [19, 0.0135, -1.9902],
    [21, 0.0107, -0.7244],
    [23, 0.0055, -0.7461]
  ] as ReadonlyArray<readonly [number, number, number]>,
  /** Les deux cercles lisses et le noyau maillé du milieu. */
  circles: [0.515, 0.395],
  core: 0.152,
  /** Épaisseur du trait du logo. */
  stroke: 0.034
}

/** Écart au rayon de base de la courbe du logo à l'angle θ (0 à 4π). */
export function logoLoopOffset(theta: number): number {
  let offset = 0
  for (const [freq, amp, phase] of LOGO_LOOP.terms) offset += amp * Math.sin((freq * theta) / 2 + phase)
  return offset
}
