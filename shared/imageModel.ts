/**
 * Le modèle d'image de Jaris (étape 174, Léo : « dans model ajoute image et met le seul image, et si pas assez
 * de puissance met aucun model »). Un seul modèle existe (FLUX.2 klein 4B, étape 173) : ce fichier dit
 * seulement s'il tient sur la machine. Module pur (aucun import) pour être partagé par le main (Options →
 * Modèles, refus avant tout téléchargement) et testé sans Electron.
 *
 * Seuils calculés sur la taille RÉELLE des fichiers, pas mesurés sur une vraie carte (aucune ici) : avec
 * `--offload-to-cpu`, sd.cpp ne monte sur la carte graphique qu'un morceau à la fois — le plus gros est le
 * lecteur de description (Qwen3 4B, 2,5 Go) ou le modèle de dessin (2,5 Go) plus ses calculs en 1024 px, soit
 * environ 4 Go au plus fort, auxquels Windows ajoute son propre usage. D'où une carte de 6 Go minimum. Tous les
 * poids (~5 Go) restent en RAM pendant le dessin : 16 Go minimum pour ne pas faire ramer tout le PC.
 */
export const IMAGE_MODEL = 'FLUX.2 klein 4B'

/** Une carte vendue « 6 Go » est lue 5,8 à 6 Go par nvidia-smi : le seuil laisse passer les vraies 6 Go. */
export const IMAGE_MIN_VRAM_GB = 5.5
/** Un PC « 16 Go » en annonce environ 15,8 (mémoire réservée par le matériel). */
export const IMAGE_MIN_RAM_GB = 15

export interface ImageModelPick {
  /** `null` = aucun modèle : la machine n'a pas assez de puissance pour dessiner. */
  model: string | null
  /** Pourquoi aucun modèle, en une phrase lisible par Léo ; `null` quand le modèle tient. */
  reason: string | null
  /** Les fichiers du modèle sont déjà sur le disque (ajouté par main.ts ; absent = pas encore vérifié). */
  installed?: boolean
}

export function pickImageModel(vramGb: number | null, ramGb: number): ImageModelPick {
  if (vramGb === null) {
    return { model: null, reason: 'aucune carte graphique détectée (il en faut une de 6 Go ou plus)' }
  }
  if (vramGb < IMAGE_MIN_VRAM_GB) {
    return { model: null, reason: `carte graphique trop petite (${vramGb} Go de VRAM, il en faut 6 ou plus)` }
  }
  if (ramGb < IMAGE_MIN_RAM_GB) {
    return { model: null, reason: `pas assez de RAM (${Math.round(ramGb)} Go, il en faut 16 ou plus)` }
  }
  return { model: IMAGE_MODEL, reason: null }
}
