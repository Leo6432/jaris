import { exec } from 'child_process'
import { statfsSync } from 'fs'
import { homedir, totalmem } from 'os'
import { join } from 'path'
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
 * Marge sous l'espace disque libre détecté, réservée aux fichiers temporaires créés pendant un téléchargement
 * et à l'espace de manœuvre normal du système — jamais toute l'entière disponible pour un seul modèle,
 * pareil esprit que RESOURCE_SAFETY_MARGIN_GB ci-dessus mais pour le disque plutôt que VRAM/RAM.
 */
export const DISK_SAFETY_MARGIN_GB = 5

/**
 * Espace disque libre (Go) sur le disque où Ollama stocke ses modèles — jamais vérifié jusqu'ici : Jaris ne
 * regardait que si un modèle tenait en VRAM+RAM pour TOURNER, jamais s'il y avait la place de le TÉLÉCHARGER
 * d'abord. Un modèle de 20 Go peut très bien tenir en RAM sur une machine à 64 Go de RAM mais échouer à se
 * télécharger si le disque système n'a plus que 5 Go de libres — deux contraintes indépendantes.
 *
 * Cible le dossier réel où Ollama stocke les modèles (`OLLAMA_MODELS` si personnalisé, sinon l'emplacement
 * par défaut `~/.ollama/models`), avec repli sur le dossier utilisateur si aucun des deux n'existe encore
 * (première installation, avant le tout premier `ollama pull`) — presque toujours le même disque que
 * `~/.ollama/models` une fois créé. `null` si `fs.statfsSync` échoue (plateforme non supportée, permissions) :
 * l'appelant doit alors ignorer ce filtre plutôt que de bloquer tout téléchargement sur une valeur inconnue.
 */
export function detectFreeDiskGb(): number | null {
  const candidates = [process.env.OLLAMA_MODELS?.trim(), join(homedir(), '.ollama', 'models'), homedir()].filter(
    (dir): dir is string => Boolean(dir)
  )
  for (const dir of candidates) {
    try {
      const stats = statfsSync(dir)
      // `bavail` (blocs disponibles pour un utilisateur non privilégié), pas `bfree` (blocs libres bruts,
      // incluant la réserve du système de fichiers habituellement inaccessible même en admin/root) : la
      // bonne mesure de "ce que ce téléchargement peut vraiment utiliser".
      return (stats.bavail * stats.bsize) / 1024 ** 3
    } catch {
      continue
    }
  }
  return null
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
