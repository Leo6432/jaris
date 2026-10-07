import { lstat, readlink, rm, unlink } from 'fs/promises'
import { join } from 'path'

/**
 * Étape 200 (Léo : « enlève Montage, on le remplace par Image ») : le paquet Remotion que le Montage avait
 * installé (`%LOCALAPPDATA%\Jaris\montage`, environ 600 Mo) ne sert plus à rien. Il est effacé une fois, au
 * démarrage. S'il avait été déplacé par « Déplacer » (modelsLocation.ts), le dossier habituel est une jonction :
 * le VRAI dossier est effacé aussi, sinon les 600 Mo resteraient orphelins sur l'autre disque.
 *
 * Les vidéos déjà fabriquées ne sont PAS touchées : ce sont les données de Léo (`generated-videos`, qui suit
 * toujours ses données dans storageRoot.ts).
 */
export function leftoverMontageDir(localAppData = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? ''): string {
  return join(localAppData, 'Jaris', 'montage')
}

export async function removeLeftoverMontage(dir = leftoverMontageDir()): Promise<boolean> {
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink()) {
      const target = await readlink(dir)
      // Seul un dossier « montage » (celui que Jaris a lui-même créé en déplaçant) est suivi : jamais une
      // jonction qui pointerait ailleurs.
      if (/[\\/]montage[\\/]?$/i.test(target)) await rm(target, { recursive: true, force: true })
      // unlink retire la jonction elle-même, comme modelsLocation.ts, sans jamais la suivre.
      await unlink(dir)
    } else {
      await rm(dir, { recursive: true, force: true })
    }
    return true
  } catch {
    // Rien à effacer (jamais installé), ou fichier verrouillé : on réessaiera au prochain démarrage.
    return false
  }
}

/**
 * Étape 258 (Léo, après son duel : « FastWan fait pareil pour 20 fois plus rapide, enlève le duel ») : le duel
 * vidéo est retiré. Son environnement Python et le modèle Kandinsky (~31 Go, dans `<moteur image>\video-duel`)
 * sont effacés une fois, au démarrage — exactement ce que faisait son bouton « Effacer les fichiers ».
 * Le dossier `resultats` (les 6 vidéos du duel et le choix de Léo, quelques Mo) est gardé : ce sont ses données.
 */
export const RETIRED_VIDEO_DUEL_PARTS = ['python', 'kandinsky6-lite', '.temp'] as const

export async function removeLeftoverVideoDuel(duelDir: string): Promise<boolean> {
  let removed = false
  for (const part of RETIRED_VIDEO_DUEL_PARTS) {
    const dir = join(duelDir, part)
    try {
      await lstat(dir)
      await rm(dir, { recursive: true, force: true })
      removed = true
    } catch {
      // Absent (duel jamais lancé), ou verrouillé : on réessaiera au prochain démarrage.
    }
  }
  return removed
}
