/**
 * Le modèle vidéo de Jaris (étape 203, Léo : « ajoute vidéo : Wan 2.2-TI2V-5B »). Module pur, partagé par le main
 * (refus avant tout téléchargement) et l'écran, testé sans Electron.
 *
 * Wan 2.2 TI2V 5B (Alibaba, Apache 2.0) : texte → vidéo, ou image → vidéo. Tourne avec le même moteur que les
 * images (stable-diffusion.cpp, docs/wan.md). Seuils posés sur la taille RÉELLE des fichiers, pas mesurés sur une
 * vraie carte (aucune ici) : avec `--offload-to-cpu`, seuls le modèle vidéo (3,4 Go) et ses calculs montent sur la
 * carte ; l'encodeur de texte (3,7 Go) et le décodeur restent en RAM. D'où 8 Go de carte et 16 Go de RAM au
 * minimum — la documentation de sd.cpp prévient que le décodeur Wan « demande vraiment beaucoup de VRAM ».
 * Seuils par qualité (étape 205) : VIDEO_QUALITIES plus bas.
 */
export const VIDEO_MODEL = 'Wan 2.2 TI2V 5B'

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

/**
 * Qualité du modèle vidéo (étape 205, Léo : « une barre d'effort Q4, Q6 ou Q8, et si une personne ne peut que Q6
 * elle n'a que Q4 et Q6 »). Chaque cran = le modèle vidéo ET le lecteur de description au même niveau de
 * compression (le décodeur n'existe qu'en version originale). Tailles réelles des fichiers (API Hugging Face).
 *
 * Seuils DÉDUITS des tailles, pas mesurés sur une vraie carte (aucune ici) :
 * - carte graphique : le modèle vidéo y monte seul (le lecteur reste en RAM avec --offload-to-cpu), plus
 *   ~2,5 Go pour le calcul et le décodage par morceaux, sur une carte dont Windows occupe déjà ~0,5 Go :
 *   Q4 (3,4 Go → ~5,9 Go) et Q6 (4,2 Go → ~6,7 Go) tiennent sur 8 Go ; Q8 (5,4 Go → ~7,9 Go) ne laisse plus
 *   de marge sur 8 Go et demande 10 Go ou plus. Le plancher reste 8 Go (étape 203) : le décodeur Wan est
 *   réputé très gourmand (docs/wan.md), et rien ici ne permet de le descendre sans le mesurer.
 * - RAM : sd.cpp charge les trois fichiers en RAM, plus ~5 Go pour Windows et Jaris → Q4 (8,5 Go) tient dans
 *   16 Go, Q6 (10,3 Go) et Q8 (12,8 Go) demandent 24 Go ou plus.
 */
export type VideoQuality = 'q4' | 'q6' | 'q8'

export interface VideoQualityLevel {
  id: VideoQuality
  label: string
  /** Mémoire vidéo minimale (Go, tolérance incluse : une carte « 8 Go » en annonce parfois 7,9). */
  minVramGb: number
  minRamGb: number
  /** Les mêmes seuils arrondis à une taille de carte/de RAM du commerce, pour les messages. */
  vramLabel: number
  ramLabel: number
}

export const VIDEO_QUALITIES: VideoQualityLevel[] = [
  { id: 'q4', label: 'Q4', minVramGb: 7.5, minRamGb: 15, vramLabel: 8, ramLabel: 16 },
  { id: 'q6', label: 'Q6', minVramGb: 7.5, minRamGb: 23, vramLabel: 8, ramLabel: 24 },
  { id: 'q8', label: 'Q8', minVramGb: 9.5, minRamGb: 23, vramLabel: 10, ramLabel: 24 }
]

export function isVideoQuality(value: unknown): value is VideoQuality {
  return VIDEO_QUALITIES.some((q) => q.id === value)
}

export function videoQualityLabel(quality: VideoQuality): string {
  return VIDEO_QUALITIES.find((q) => q.id === quality)?.label ?? quality
}

export interface VideoQualityPick {
  /** Les crans que CETTE machine peut faire tourner, du plus léger au plus fidèle (vide : aucun). */
  qualities: VideoQuality[]
  /** Pourquoi aucun cran n'est possible, en clair. */
  reason: string | null
}

export function availableVideoQualities(vramGb: number | null, ramGb: number): VideoQualityPick {
  const lightest = VIDEO_QUALITIES[0]
  if (vramGb === null) return { qualities: [], reason: `aucune carte graphique NVIDIA détectée (il en faut une de ${lightest.vramLabel} Go ou plus)` }
  if (vramGb < lightest.minVramGb) {
    return { qualities: [], reason: `carte graphique trop petite (${vramGb} Go de VRAM, il en faut ${lightest.vramLabel} ou plus)` }
  }
  if (ramGb < lightest.minRamGb) return { qualities: [], reason: `pas assez de RAM (${Math.round(ramGb)} Go, il en faut ${lightest.ramLabel} ou plus)` }
  return { qualities: VIDEO_QUALITIES.filter((q) => vramGb >= q.minVramGb && ramGb >= q.minRamGb).map((q) => q.id), reason: null }
}
