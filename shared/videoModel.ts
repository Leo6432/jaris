/**
 * Le modèle vidéo de Jaris (étape 203, Léo : « ajoute vidéo : Wan 2.2-TI2V-5B »). Module pur, partagé par le main
 * (refus avant tout téléchargement) et l'écran, testé sans Electron.
 *
 * Wan 2.2 TI2V 5B (Alibaba, Apache 2.0) : texte → vidéo, ou image → vidéo. Tourne avec le même moteur que les
 * images (stable-diffusion.cpp, docs/wan.md). Seuils posés sur la taille RÉELLE des fichiers, pas mesurés sur une
 * vraie carte (aucune ici) : avec `--offload-to-cpu`, seuls le modèle vidéo (3,4 Go) et ses calculs montent sur la
 * carte ; l'encodeur de texte (3,7 Go) et le décodeur restent en RAM. D'où 8 Go de carte et 16 Go de RAM au
 * minimum — la documentation de sd.cpp prévient que le décodeur Wan « demande vraiment beaucoup de VRAM ».
 */
export const VIDEO_MODEL = 'Wan 2.2 TI2V 5B'

export const VIDEO_MIN_VRAM_GB = 7.5
export const VIDEO_MIN_RAM_GB = 15

/** 832 x 480 : le format de départ rapide conseillé par sd.cpp (multiples de 16, coût proportionnel à la surface). */
export const VIDEO_WIDTH = 832
export const VIDEO_HEIGHT = 480
export const VIDEO_FPS = 24

/**
 * Durées proposées (étape 204, Léo : « choisir la durée, comme l'effort »). Wan 2.2 TI2V 5B produit au plus
 * 5 secondes à 24 images/s (README officiel : « a 5-second 720P video », 121 images) : de 1 à 5 s, une seconde
 * par cran. Plus c'est long, plus le calcul est long — et plus que proportionnellement.
 */
export const VIDEO_DURATIONS = [1, 2, 3, 4, 5] as const
export type VideoSeconds = (typeof VIDEO_DURATIONS)[number]
export const DEFAULT_VIDEO_SECONDS: VideoSeconds = 2

/** Toute valeur venue de l'écran est ramenée à une durée proposée (sinon la durée par défaut). */
export function normalizeVideoSeconds(value: unknown): VideoSeconds {
  return (VIDEO_DURATIONS as readonly unknown[]).includes(value) ? (value as VideoSeconds) : DEFAULT_VIDEO_SECONDS
}

/** Nombre d'images pour une durée : 24 par seconde + 1, soit toujours 4n + 1 comme l'exige le modèle (5 s → 121). */
export function videoFramesFor(seconds: VideoSeconds): number {
  return seconds * VIDEO_FPS + 1
}

export interface VideoModelPick {
  model: string | null
  reason: string | null
}

export function pickVideoModel(vramGb: number | null, ramGb: number): VideoModelPick {
  if (vramGb === null) return { model: null, reason: 'aucune carte graphique NVIDIA détectée (il en faut une de 8 Go ou plus)' }
  if (vramGb < VIDEO_MIN_VRAM_GB) return { model: null, reason: `carte graphique trop petite (${vramGb} Go de VRAM, il en faut 8 ou plus)` }
  if (ramGb < VIDEO_MIN_RAM_GB) return { model: null, reason: `pas assez de RAM (${Math.round(ramGb)} Go, il en faut 16 ou plus)` }
  return { model: VIDEO_MODEL, reason: null }
}
