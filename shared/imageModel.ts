import { formatDecimal, t } from './i18n'
/**
 * Le modèle d'image de Jaris. Module pur (aucun import d'Electron) pour être partagé par le main (Options → Modèles,
 * refus avant tout téléchargement), l'écran, et testé sans Electron.
 *
 * Étape 494 (Léo : « tu vas utiliser z image turbo, et tu proposes plusieurs niveaux au niveau du PC, par exemple
 * q2 q3 q4 ») : **Z-Image-Turbo** (Tongyi-MAI, Apache 2.0, 6 milliards de paramètres, 8 étapes) remplace FLUX.2 klein.
 * Chaque niveau est une compression du dessinateur publiée par l'auteur de stable-diffusion.cpp
 * (leejet/Z-Image-Turbo-GGUF) ; le lecteur de description (Qwen3 4B) et le décodeur sont les mêmes pour tous.
 *
 * Seuils de carte graphique : MESURÉS ici avec la version épinglée de sd.cpp (processeur, 1024 px, mêmes options que
 * Jaris), pas sur une vraie carte (aucune ici). Avec `--offload-to-cpu`, seul le dessinateur monte sur la carte
 * pendant le dessin : son fichier (Q4_0 : 3 513 Mo mesurés = la taille du fichier) + 690 Mo de calcul en 1024 px
 * (`--diffusion-fa`). Le lecteur Qwen3 4B travaille sur le processeur (`te=cpu`) ; le décodeur par tuiles ne prend
 * ensuite que ~0,5 Go. On ajoute ~0,3 Go pour Vulkan et ~0,5 Go que Windows occupe déjà sur la carte :
 *   Q2 (2,4 Gio) ≈ 3,9 Go → cartes 4 Go · Q3 (2,9) ≈ 4,4 → 5 Go · Q4 (3,6) ≈ 5,1 → 6 Go ·
 *   Q5 (4,2) ≈ 5,7 et Q6 (4,9) ≈ 6,4 → 8 Go (une carte « 6 Go » lue 5,8 n'a plus de marge pour Q5) ·
 *   Q8 (6,1) ≈ 7,6 → 10 Go (sur 8 Go, plus aucune marge).
 * RAM : mesurée à 6,5 Go au plus fort pour Q4 (tous les poids y restent) ; Q8 en ajoute ~2,7. Avec Windows et Jaris,
 * 16 Go pour tous les niveaux.
 */
export const IMAGE_MODEL = 'Z-Image-Turbo'

export type ImageQuality = 'q2' | 'q3' | 'q4' | 'q5' | 'q6' | 'q8'

export interface ImageQualityLevel {
  id: ImageQuality
  /** Nom affiché (le même dans toutes les langues : c'est le nom de la compression, comme Léo l'a demandé). */
  label: string
  /** Mémoire vidéo minimale lue par Windows (tolérance incluse : une carte « 6 Go » en annonce 5,8). */
  minVramGb: number
  minRamGb: number
  /** Les mêmes seuils arrondis à une taille de carte/de RAM du commerce, pour les messages. */
  vramLabel: number
  ramLabel: number
  /** Ce qu'il faut télécharger pour ce niveau sur un PC vierge (moteur compris), arrondi au Go — vérifié par test sur
   *  les tailles exactes des fichiers (imageGenerator.ts). */
  downloadGb: number
}

export const IMAGE_QUALITIES: ImageQualityLevel[] = [
  { id: 'q2', label: 'Q2', minVramGb: 3.5, minRamGb: 15, vramLabel: 4, ramLabel: 16, downloadGb: 5 },
  { id: 'q3', label: 'Q3', minVramGb: 4.5, minRamGb: 15, vramLabel: 5, ramLabel: 16, downloadGb: 6 },
  { id: 'q4', label: 'Q4', minVramGb: 5.5, minRamGb: 15, vramLabel: 6, ramLabel: 16, downloadGb: 7 },
  { id: 'q5', label: 'Q5', minVramGb: 7.5, minRamGb: 15, vramLabel: 8, ramLabel: 16, downloadGb: 7 },
  { id: 'q6', label: 'Q6', minVramGb: 7.5, minRamGb: 15, vramLabel: 8, ramLabel: 16, downloadGb: 8 },
  { id: 'q8', label: 'Q8', minVramGb: 9.5, minRamGb: 15, vramLabel: 10, ramLabel: 16, downloadGb: 9 }
]

export function isImageQuality(value: unknown): value is ImageQuality {
  return IMAGE_QUALITIES.some((q) => q.id === value)
}

export function imageDownloadGb(quality: ImageQuality): number {
  return IMAGE_QUALITIES.find((q) => q.id === quality)?.downloadGb ?? 5
}

export function imageQualityLabel(quality: ImageQuality): string {
  return IMAGE_QUALITIES.find((q) => q.id === quality)?.label ?? quality
}

export interface ImageQualityPick {
  /** Les niveaux que CETTE machine peut faire tourner, du plus léger au plus fidèle (vide : aucun). */
  qualities: ImageQuality[]
  /** Pourquoi aucun niveau n'est possible, en clair. */
  reason: string | null
}

export function availableImageQualities(vramGb: number | null, ramGb: number): ImageQualityPick {
  const lightest = IMAGE_QUALITIES[0]
  if (vramGb === null) return { qualities: [], reason: t('hw.noGpu', { need: lightest.vramLabel }) }
  if (vramGb < lightest.minVramGb) {
    return { qualities: [], reason: t('hw.gpuTooSmall', { have: formatDecimal(vramGb), need: lightest.vramLabel }) }
  }
  if (ramGb < lightest.minRamGb) return { qualities: [], reason: t('hw.notEnoughRam', { have: Math.round(ramGb), need: lightest.ramLabel }) }
  return { qualities: IMAGE_QUALITIES.filter((q) => vramGb >= q.minVramGb && ramGb >= q.minRamGb).map((q) => q.id), reason: null }
}

export interface ImageModelPick {
  /** `null` = aucun modèle : la machine n'a pas assez de puissance pour dessiner. Sinon le modèle et son niveau. */
  model: string | null
  /** Meilleur niveau possible ici. */
  quality: ImageQuality | null
  /** Pourquoi aucun modèle, en une phrase lisible par Léo ; `null` quand le modèle tient. */
  reason: string | null
  /** Ce niveau est déjà sur le disque (ajouté par main.ts ; absent = pas encore vérifié). */
  installed?: boolean
}

export function pickImageModel(vramGb: number | null, ramGb: number): ImageModelPick {
  const pick = availableImageQualities(vramGb, ramGb)
  const best = pick.qualities[pick.qualities.length - 1]
  if (!best) return { model: null, quality: null, reason: pick.reason }
  return { model: `${IMAGE_MODEL} ${imageQualityLabel(best)}`, quality: best, reason: null }
}
