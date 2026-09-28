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
