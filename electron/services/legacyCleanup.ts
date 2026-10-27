import { execFile } from 'child_process'
import { lstat, readFile, readdir, readlink, rm, unlink } from 'fs/promises'
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

/**
 * Étape 353 (Léo : « enlève le test en bas », après avoir mesuré qu'un test complet prendrait des jours, et des
 * semaines pour un gros modèle) : le test Terminal-Bench 2.1 est retiré. Ce qu'il avait posé sur le disque est
 * effacé une fois, au démarrage : l'outil Harbor installé dans `terminal-bench\harbor`, les 89 tâches, les journaux
 * des essais. Le fichier des résultats (`results.json`, quelques Ko) est gardé : ce sont les données de Léo.
 *
 * Docker : un test arrêté en pleine tâche (fermeture de Jaris, mise à jour) laisse les conteneurs et l'image de
 * cette tâche. Seuls les conteneurs et images dont le NOM figure dans un task.toml du test sont retirés — jamais
 * une autre image, jamais Docker Desktop lui-même. Docker installé mais arrêté : les tâches (qui donnent ces noms)
 * restent jusqu'au prochain démarrage où Docker répond. Docker absent : il n'y a plus rien à retirer.
 */
export const RETIRED_TERMINAL_BENCH_DIR = 'terminal-bench'
export const KEPT_TERMINAL_BENCH_RESULTS = 'results.json'

/** Les images Docker des tâches, lues dans les task.toml (`tasks\<jeu>\<tâche>\task.toml`). */
export async function terminalBenchTaskImages(tasksDir: string): Promise<string[]> {
  const images = new Set<string>()
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await visit(path, depth + 1)
      else if (entry.isFile() && entry.name === 'task.toml') {
        const toml = await readFile(path, 'utf8').catch(() => '')
        const image = /^\s*docker_image\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
        if (image) images.add(image)
      }
    }
  }
  await visit(tasksDir, 0)
  return [...images]
}

export async function removeLeftoverTerminalBench(dataRoot: string, docker: DockerRun = runDocker): Promise<boolean> {
  const dir = join(dataRoot, RETIRED_TERMINAL_BENCH_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return false // jamais lancé, ou déjà nettoyé
  }
  const tasksDir = join(dir, 'tasks')
  const images = await terminalBenchTaskImages(tasksDir)
  let keepTasks = false
  if (images.length) {
    let installed = true
    try {
      await docker(['--version'])
    } catch {
      installed = false // pas de Docker : plus aucune image à retirer
    }
    if (installed) {
      try {
        await docker(['info', '--format', '{{.ServerVersion}}'])
        // Docker écrit « nom:latest » une image donnée sans version : les deux formes désignent la même image.
        const wanted = new Set(images.flatMap((image) => (/:[^/]*$|@/.test(image) ? [image] : [image, `${image}:latest`])))
        const containers = lines(await docker(['ps', '-a', '--format', '{{.ID}} {{.Image}}']))
          .map((line) => line.split(/\s+/))
          .filter(([, image]) => image !== undefined && wanted.has(image))
          .map(([id]) => id)
        if (containers.length) await docker(['rm', '-f', ...containers]).catch(() => '')
        const present = lines(await docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])).filter((ref) => wanted.has(ref))
        for (const image of present) await docker(['image', 'rm', '-f', image]).catch(() => '')
      } catch {
        keepTasks = true // Docker arrêté : on réessaiera au prochain démarrage
      }
    }
  }
  for (const name of entries) {
    if (name === KEPT_TERMINAL_BENCH_RESULTS || (name === 'tasks' && keepTasks)) continue
    await rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
  return !keepTasks
}
