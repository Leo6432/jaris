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
/** 49 images à 24 images/s ≈ 2 s : un nombre « propre » pour le modèle (4n + 1), et un calcul qui reste supportable. */
export const VIDEO_FRAMES = 49
export const VIDEO_FPS = 24

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
