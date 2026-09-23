import { exec, spawn } from 'child_process'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Docker Desktop (recherche web SearXNG) et le dossier de Jaris — étape 143, « tout dans le D, jamais une
 * partie ». Contrairement aux autres dossiers (modelsLocation.ts), Docker ne se laisse pas rediriger par une
 * jonction : programme installé pour toute la machine (droits administrateur) et disque virtuel WSL enregistré
 * auprès de Windows. Les deux seuls moyens OFFICIELS (docs.docker.com, « Install Docker Desktop on Windows ») :
 * - à l'installation : `--installation-dir=<dossier>` (programme) et `--wsl-default-data-root=<dossier>`
 *   (disque virtuel, là où vivent les images et conteneurs) ;
 * - pour un Docker déjà installé ailleurs : le désinstaller (`Docker Desktop Installer.exe uninstall`), puis
 *   Jaris le réinstalle tout seul dans son dossier la prochaine fois que la recherche web en a besoin.
 *
 * Désinstaller EFFACE tout ce que Docker contient (docs.docker.com, « Uninstall Docker Desktop »). Jaris ne
 * le fait donc que si Docker ne contient RIEN d'autre que sa propre recherche web — sinon le déplacement
 * entier est refusé avant d'avoir touché à quoi que ce soit : jamais un projet de quelqu'un d'autre effacé.
 */

/** Sous-dossiers de la racine de Jaris réservés à Docker. */
export const DOCKER_APP_SUBDIR = 'docker'
export const DOCKER_DATA_SUBDIR = 'docker-data'

/** Indicateurs d'installation : dans le dossier de Jaris quand il y en a un, emplacement par défaut sinon. */
export function dockerInstallFlags(root: string | null): string[] {
  if (!root) return []
  return [`--installation-dir=${join(root, DOCKER_APP_SUBDIR)}`, `--wsl-default-data-root=${join(root, DOCKER_DATA_SUBDIR)}`]
}

/** L'image de la recherche web de Jaris (docker-compose.yml). */
const JARIS_IMAGE = 'searxng/searxng'

export interface DockerContent {
  /** Image de chaque conteneur (`docker ps -a --format {{.Image}}`). */
  containers: string[]
  /** Dépôt de chaque image (`docker images --format {{.Repository}}`). */
  images: string[]
  /** Nom de chaque volume (`docker volume ls -q`). */
  volumes: string[]
}

/**
 * Vrai si Docker ne contient que la recherche web de Jaris. Les volumes ANONYMES (64 caractères hexadécimaux)
 * sont acceptés : l'image SearXNG en déclare elle-même, et un volume nommé serait forcément celui de
 * quelqu'un d'autre (docker-compose.yml de Jaris n'en crée aucun).
 */
export function isOnlyJarisDockerContent(content: DockerContent): boolean {
  const isJarisImage = (name: string): boolean => name === JARIS_IMAGE || name.startsWith(`${JARIS_IMAGE}:`) || name === `docker.io/${JARIS_IMAGE}`
  return (
    content.containers.every(isJarisImage) &&
    content.images.every((repo) => repo === '<none>' || isJarisImage(repo)) &&
    content.volumes.every((volume) => /^[0-9a-f]{64}$/.test(volume))
  )
}

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

const INSTALLER_EXE = 'Docker Desktop Installer.exe'

/** Où Docker Desktop est installé (dossier qui contient son installeur/désinstalleur), `null` s'il ne l'est pas. */
export async function findDockerInstallDir(extraCandidates: string[] = []): Promise<string | null> {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop'),
    ...extraCandidates
  ]
  try {
    // docker.exe est dans <installation>\resources\bin : remonter de deux crans retrouve une installation
    // faite dans un dossier inhabituel.
    const { stdout } = await execAsync('where docker.exe', { windowsHide: true })
    const first = stdout.split(/\r?\n/).find(Boolean)
    if (first) candidates.push(dirname(dirname(dirname(first.trim()))))
  } catch {
    // docker introuvable dans le PATH
  }
  return candidates.find((dir) => existsSync(join(dir, INSTALLER_EXE))) ?? null
}

async function lines(command: string): Promise<string[]> {
  const { stdout } = await execAsync(command, { windowsHide: true, timeout: 30_000 })
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

async function readDockerContent(): Promise<DockerContent> {
  return {
    containers: await lines('docker ps -a --format "{{.Image}}"'),
    images: await lines('docker images --format "{{.Repository}}"'),
    volumes: await lines('docker volume ls -q')
  }
}

async function dockerResponds(): Promise<boolean> {
  try {
    await execAsync('docker info', { windowsHide: true, timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export type DockerMovePlan = { action: 'none' } | { action: 'uninstall'; installDir: string }

/**
 * Que faire de Docker pour un déplacement vers `newRoot` ? Lève une erreur LISIBLE (affichée telle quelle)
 * quand le déplacement doit être refusé en entier. `startDocker` démarre Docker Desktop s'il ne répond pas :
 * impossible de savoir ce qu'il contient sans lui.
 */
export async function planDockerMove(newRoot: string, startDocker: () => Promise<void>, extraCandidates: string[] = []): Promise<DockerMovePlan> {
  const installDir = await findDockerInstallDir(extraCandidates)
  if (!installDir || isInside(installDir, newRoot)) return { action: 'none' }

  if (!(await dockerResponds())) {
    await startDocker()
    const deadline = Date.now() + 90_000
    while (!(await dockerResponds())) {
      if (Date.now() > deadline) {
        throw new Error(
          "Docker Desktop ne répond pas : impossible de vérifier ce qu'il contient avant de le déplacer. " +
            'Ouvre Docker Desktop (ou redémarre le PC), puis relance « Déplacer ». Rien n\'a été déplacé.'
        )
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  if (!isOnlyJarisDockerContent(await readDockerContent())) {
    throw new Error(
      "Docker Desktop contient d'autres projets que la recherche web de Jaris. Le déplacer oblige à le " +
        'désinstaller, ce qui les effacerait : rien n\'a été déplacé. Si tu n\'en as plus besoin, supprime-les ' +
        'dans Docker Desktop puis relance « Déplacer ».'
    )
  }
  return { action: 'uninstall', installDir }
}

/**
 * Désinstalle Docker Desktop (une fenêtre d'autorisation Windows s'affiche) puis efface les restes que sa
 * documentation liste comme « à supprimer manuellement ». Aucun chemin n'est interpolé dans le script
 * PowerShell : tout passe par des variables d'environnement. Renvoie vrai si la désinstallation a abouti.
 */
export async function uninstallDockerForMove(installDir: string): Promise<boolean> {
  await execAsync('taskkill /IM "Docker Desktop.exe" /F', { windowsHide: true }).catch(() => {})
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    "$p = Start-Process -FilePath $env:JARIS_DOCKER_UNINSTALLER -ArgumentList 'uninstall' -Verb RunAs -Wait -PassThru; " +
    'exit $p.ExitCode'
  const exitCode = await new Promise<number | null>((done) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, JARIS_DOCKER_UNINSTALLER: join(installDir, INSTALLER_EXE) }
    })
    proc.on('error', () => done(null))
    proc.on('close', (code) => done(code))
  })
  if (exitCode !== 0) return false

  // Restes par utilisateur que la documentation de Docker liste comme « à supprimer manuellement » (aucun
  // droit administrateur nécessaire). Ceux de ProgramData, eux, demanderaient une seconde autorisation
  // Windows : laissés en place (quelques Mo de réglages), et dit tel quel dans le message final.
  const home = process.env.USERPROFILE ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  for (const dir of [join(local, 'Docker'), join(roaming, 'Docker'), join(roaming, 'Docker Desktop'), join(home, '.docker'), installDir]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return true
}
