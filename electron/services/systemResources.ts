import { exec } from 'child_process'
import { totalmem } from 'os'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Marge sous VRAM+RAM combinées, réservée à l'OS et aux autres logiciels ouverts — jamais disponible en
 * entier pour un seul modèle, contrairement à ce qu'un simple total brut suggérerait. Même valeur que
 * RAM_SAFETY_MARGIN_GB dans scripts/benchmark-models.mjs (dupliqué là-bas volontairement : ce script tourne
 * en `node` simple, pas via le bundler Electron/TS, donc pas d'import direct possible entre les deux).
 */
export const RESOURCE_SAFETY_MARGIN_GB = 8

/**
 * VRAM totale de la carte NVIDIA détectée (Go), ou `null` sans carte NVIDIA détectée (pas de GPU dédié,
 * carte AMD/Intel — non vues par cette commande, ou erreur).
 */
export async function detectVramGb(): Promise<number | null> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      windowsHide: true
    })
    const mib = parseInt(stdout.trim().split('\n')[0], 10)
    return Number.isFinite(mib) ? mib / 1024 : null
  } catch {
    return null
  }
}

/** RAM totale de la machine (Go) : contrairement à la VRAM, Node sait la lire directement, sans commande externe. */
export function detectRamGb(): number {
  return totalmem() / 1024 ** 3
}

/**
 * Budget "peut tourner du tout" avant de télécharger un modèle : VRAM + RAM combinées (Ollama répartit
 * automatiquement les deux quand un modèle ne tient pas entièrement en VRAM), moins la marge OS. Sert de
 * filet de sécurité universel dans pullModelIfMissing (ollama.ts), pour TOUT modèle téléchargé par Jaris —
 * distinct du budget VRAM seule utilisé par pickForBudget (hardwareScan.ts) pour choisir le modèle le plus
 * RAPIDE : un modèle peut très bien être un mauvais choix de vitesse (trop gros pour la VRAM seule) sans
 * pour autant être un mauvais choix de faisabilité (il tourne quand même, juste plus lentement, si VRAM+RAM
 * combinées suffisent). Ce budget-ci ne filtre que les modèles qui ne tourneraient de toute façon jamais,
 * quelle que soit la vitesse acceptée.
 */
export async function getDownloadBudgetGb(): Promise<number> {
  const vramGb = await detectVramGb()
  const ramGb = detectRamGb()
  return Math.max(0, (vramGb ?? 0) + ramGb - RESOURCE_SAFETY_MARGIN_GB)
}
