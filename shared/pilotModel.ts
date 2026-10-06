/**
 * Le modèle de pilotage d'écran (étape 231, Léo : « oui pour nouveau rôle… comme image vidéo le mettre seul, si
 * l'utilisateur n'a pas assez on met pas le rôle et il fait comme maintenant »). Un seul modèle, comme Image et
 * Vidéo. Module pur (aucun import) : partagé par le main (installation, pilotage) et l'écran, testé sans Electron.
 *
 * Étape 251 : MAI-UI 8B (Alibaba, Apache 2.0) remplace UI-TARS 1.5 7B, sur le duel de Léo (ses vraies fenêtres,
 * vérité donnée par Windows) : 30 boutons touchés sur 40 avec le zoom, contre 22. Il VISE (voir maiUi.ts) ; le
 * modèle de vision décide quoi faire. Le nom doit rester identique à MAI_UI_MODEL (maiUi.ts), vérifié par test.
 *
 * Seuil DÉDUIT des tailles réelles (fichiers du dépôt Hugging Face : modèle 5,0 Go + lecteur d'images 1,2 Go),
 * plus le cache et le calcul de l'image (~1,5 Go), sur une carte dont Windows occupe déjà ~0,5 Go : une carte de
 * 8 Go — celle de Léo, sur laquelle le duel a tourné. En dessous, pas de rôle : le modèle de vision vise lui-même,
 * comme avant.
 */
export const PILOT_MODEL = 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M'
export const PILOT_MODEL_LABEL = 'MAI-UI 8B'

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
