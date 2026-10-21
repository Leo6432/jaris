import { execFile } from 'child_process'
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

/**
 * Étape 337 (Léo : « enlève Docker et mets DuckDuckGo ») : la recherche web ne passe plus par SearXNG. Son conteneur
 * Docker, lui, tournait en permanence chez ceux qui l'avaient (relancé à chaque démarrage de Docker) : il est retiré,
 * avec l'image qu'il utilisait et son dossier `searxng-docker` dans les données de Jaris.
 *
 * Docker Desktop lui-même n'est JAMAIS désinstallé : il sert peut-être à autre chose, et sa désinstallation demande
 * une autorisation de Windows. Seuls les conteneurs des deux projets de Jaris sont touchés : `jaris-searxng`, et
 * l'ancien `resources` (service `searxng`) — jamais un SearXNG que l'utilisateur aurait lancé lui-même.
 *
 * Docker installé mais arrêté : rien n'est retiré (le conteneur ne tourne pas non plus), le dossier reste et on
 * réessaiera au prochain démarrage. Docker absent : il n'y a plus rien à retirer, seul le dossier part.
 */
export const RETIRED_SEARXNG_DIR = 'searxng-docker'
export const RETIRED_SEARXNG_FILTERS = [
  ['label=com.docker.compose.project=jaris-searxng'],
  ['label=com.docker.compose.project=resources', 'label=com.docker.compose.service=searxng']
] as const

export type DockerRun = (args: string[]) => Promise<string>

const runDocker: DockerRun = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { windowsHide: true, timeout: 60_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

export async function removeLeftoverSearxng(dataRoot: string, docker: DockerRun = runDocker): Promise<boolean> {
  const dir = join(dataRoot, RETIRED_SEARXNG_DIR)
  try {
    await lstat(dir)
  } catch {
    return false // jamais installé, ou déjà retiré
  }
  try {
    await docker(['--version'])
  } catch {
    // Pas de Docker du tout : plus aucun conteneur à retirer.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return true
  }
  try {
    for (const filters of RETIRED_SEARXNG_FILTERS) {
      const ids = lines(await docker(['ps', '-aq', ...filters.flatMap((f) => ['--filter', f])]))
      if (ids.length) await docker(['rm', '-f', ...ids])
    }
  } catch {
    return false // Docker arrêté : on réessaiera au prochain démarrage
  }
  // L'image (quelques centaines de Mo) : Docker refuse tout seul de retirer une image encore utilisée ailleurs.
  try {
    const images = lines(await docker(['images', '-q', 'searxng/searxng']))
    if (images.length) await docker(['rmi', ...images])
  } catch {
    // Utilisée par un autre conteneur : gardée.
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return true
}
