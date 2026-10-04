/**
 * Le modèle de pilotage d'écran (étape 231, Léo : « oui pour nouveau rôle… comme image vidéo le mettre seul, si
 * l'utilisateur n'a pas assez on met pas le rôle et il fait comme maintenant »). Un seul modèle, comme Image et
 * Vidéo : UI-TARS 1.5 7B (ByteDance, Apache 2.0), entraîné pour viser des boutons sur une capture d'écran.
 * Module pur (aucun import) : partagé par le main (installation, pilotage) et l'écran, testé sans Electron.
 *
 * Mesuré ici avant de le choisir (CPU, fausse fenêtre Windows 1280x720) : 3 clics justes sur 4 pour UI-TARS,
 * 0 sur 4 pour qwen3.5:4b, le modèle de vision de Léo. Repère des positions vérifié sur une image 1280x1024 :
 * pixels de l'image arrondie à des multiples de 28 (voir uiTars.ts).
 *
 * Seuil DÉDUIT des tailles réelles, pas mesuré sur une vraie carte (aucune ici) : modèle 4,7 Go + lecteur
 * d'images 0,9 Go + cache de 8k tokens (~0,5 Go) + calcul de l'image (~1 Go), sur une carte dont Windows occupe
 * déjà ~0,5 Go → environ 7,5 Go : une carte de 8 Go. En dessous, Ollama ferait tourner une partie sur le
 * processeur — mesuré ici : 20 à 30 s par clic, et plusieurs minutes au premier chargement ; pas de rôle alors,
 * le modèle de vision garde le pilotage comme avant.
 */
export const PILOT_MODEL = 'hf.co/mradermacher/UI-TARS-1.5-7B-GGUF:Q4_K_M'
export const PILOT_MODEL_LABEL = 'UI-TARS 1.5 7B'

/** Une carte vendue « 8 Go » est lue 7,6 à 8 Go par nvidia-smi : le seuil laisse passer les vraies 8 Go. */
export const PILOT_MIN_VRAM_GB = 7.5

export interface PilotModelPick {
  /** `null` = pas de rôle : la machine n'a pas assez de puissance, le modèle de vision pilote comme avant. */
  model: string | null
  /** Pourquoi aucun modèle, en une phrase lisible par Léo ; `null` quand le modèle tient. */
  reason: string | null
  /** Le modèle est déjà installé dans Ollama (ajouté par main.ts ; absent = pas encore vérifié). */
  installed?: boolean
}

export function pickPilotModel(vramGb: number | null): PilotModelPick {
  if (vramGb === null) return { model: null, reason: 'aucune carte graphique détectée (il en faut une de 8 Go ou plus)' }
  if (vramGb < PILOT_MIN_VRAM_GB) {
    return { model: null, reason: `carte graphique trop petite (${vramGb} Go de VRAM, il en faut 8 ou plus)` }
  }
  return { model: PILOT_MODEL, reason: null }
}
