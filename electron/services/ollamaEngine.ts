import { createHash } from 'crypto'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { downloadToFile, type DownloadProgress } from './download'
import { countOllamaModels } from './ollamaModelsVariable'
import { t } from '../../shared/i18n'

/**
 * Étape 336 — Léo : « on peut pas tout intégrer dans Jaris, c'est open source Ollama ». Jaris a désormais SON
 * Ollama, au lieu de dépendre de celui installé sur Windows :
 * - le paquet officiel prévu exactement pour ça (`ollama-windows-amd64.zip`, docs/windows.mdx d'Ollama : « This
 *   allows for embedding Ollama in existing applications »), licence MIT. Il contient le serveur, les
 *   bibliothèques NVIDIA et Vulkan (AMD et Intel passent par Vulkan, activé par défaut : docs/gpu.mdx) ;
 * - téléchargé depuis les Releases GitHub d'Ollama et vérifié par son empreinte SHA-256 publiée
 *   (`sha256sum.txt` de la même version) avant d'être décompressé — jamais un fichier tronqué ou modifié ;
 * - rangé par version (`versions/<x.y.z>`), la version utilisée notée dans `current.json` : une mise à jour
 *   s'installe À CÔTÉ de l'ancienne, et l'ancienne n'est effacée qu'une fois la nouvelle démarrée ;
 * - lancé par Jaris sur son propre port (11435, pas le 11434 d'Ollama) : un Ollama déjà installé sur Windows
 *   peut continuer de tourner à côté sans conflit ;
 * - avec le VRAI chemin du dossier des modèles (jamais à travers une jonction : étape 289), passé directement
 *   au processus. Plus de variable OLLAMA_MODELS de Windows à corriger, plus d'appli Ollama qui relance son
 *   serveur avec son propre réglage : c'est la cause des pannes « modèle introuvable » des étapes 254, 289, 313.
 */

export const ENGINE_PORT = 11435
export const ENGINE_HOST = `http://127.0.0.1:${ENGINE_PORT}`
export const ENGINE_ZIP = 'ollama-windows-amd64.zip'
const RELEASES = 'https://github.com/ollama/ollama/releases'

/** Version publiée par Ollama : seulement des chiffres et un suffixe sage, car elle devient un nom de dossier. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

export interface EngineRelease {
  version: string
  url: string
  sha256: string
}

export interface InstalledEngine {
  version: string
  dir: string
  exe: string
}

/** L'emplacement habituel, remplacé par une jonction vers le dossier de Jaris (brique « Déplacer », modelsLocation.ts). */
export function engineLink(): string {
  const local = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir()
  return join(local, 'Jaris', 'ollama-engine')
}

/**
 * Étape 346 : un dossier qui est une jonction vers un disque débranché (données rangées sur D:, disque externe) faisait
 * échouer l'installation avec « ENOENT » — incompréhensible. La phrase dit quel disque rebrancher.
 */
async function assertJunctionTargetPresent(link: string): Promise<void> {
  const target = await readlink(link).catch(() => null)
  if (!target || existsSync(target)) return
  const drive = /^(?:\\\\\?\\)?([A-Za-z]:)/.exec(target)?.[1] ?? target
  throw new Error(t('storage.diskMissing', { drive }))
}

/** Le vrai dossier du moteur (jonction suivie) : Ollama et tar.exe le reçoivent toujours sous ce chemin-là. */
export async function engineRoot(link: string = engineLink()): Promise<string> {
  await assertJunctionTargetPresent(link)
  await mkdir(link, { recursive: true })
  return realpath(link).catch(() => link)
}

export function isValidEngineVersion(version: string): boolean {
  return VERSION_PATTERN.test(version)
}

/** Le moteur réellement utilisable : `current.json` lisible ET son ollama.exe présent. `null` sinon. */
export async function installedEngine(root?: string): Promise<InstalledEngine | null> {
  const base = root ?? (existsSync(engineLink()) ? await engineRoot() : null)
  if (!base) return null
  try {
    const data = JSON.parse(await readFile(join(base, 'current.json'), 'utf-8')) as { version?: unknown }
    const version = typeof data.version === 'string' ? data.version : ''
    if (!isValidEngineVersion(version)) return null
    const dir = join(base, 'versions', version)
    const exe = join(dir, 'ollama.exe')
    return existsSync(exe) ? { version, dir, exe } : null
  } catch {
    return null
  }
}

/** Écrit la version utilisée d'un seul tenant : un `current.json` à moitié écrit ne doit jamais exister. */
export async function setCurrentEngine(root: string, version: string): Promise<void> {
  const target = join(root, 'current.json')
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify({ version }), 'utf-8')
  await renameWithRetries(temporary, target)
}

/**
 * Étape 346 : un antivirus qui inspecte le nouveau moteur (plusieurs Go de fichiers .exe et .dll) le tient ouvert
 * quelques secondes — Windows refuse alors le renommage (EPERM, EACCES, EBUSY). Réessayé ~30 s avant d'abandonner,
 * avec une phrase qui dit pourquoi au lieu du code brut de Windows.
 */
export const ENGINE_RENAME_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000]

export async function renameWithRetries(
  from: string,
  to: string,
  delays: number[] = ENGINE_RENAME_RETRY_DELAYS_MS,
  move: (from: string, to: string) => Promise<void> = rename
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ''
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err
      if (attempt >= delays.length) throw new Error(t('ollamaEngine.locked'))
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** Ligne `<empreinte>  ./ollama-windows-amd64.zip` du fichier sha256sum.txt publié avec chaque version. */
export function checksumFor(sha256sum: string, fileName: string = ENGINE_ZIP): string | null {
  for (const line of sha256sum.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line.trim())
    if (match && match[2] === fileName) return match[1].toLowerCase()
  }
  return null
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Dernière version publiée. L'API de GitHub d'abord ; sans elle (60 requêtes par heure sans compte), la page
 * « latest » redirige vers la page de la version, dont l'adresse contient le numéro. Les deux ignorent les
 * pré-versions. `null` si rien n'est joignable.
 */
export async function latestEngineVersion(fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl('https://api.github.com/repos/ollama/ollama/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000)
    })
    if (response.ok) {
      const version = ((await response.json()) as { tag_name?: string }).tag_name?.replace(/^v/, '') ?? ''
      if (isValidEngineVersion(version)) return version
    }
  } catch {
    // On essaie la redirection juste en dessous.
  }
  try {
    const response = await fetchImpl(`${RELEASES}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const location = response.headers.get('location') ?? ''
    const version = /\/tag\/v([^/?#]+)$/.exec(location)?.[1] ?? ''
    return isValidEngineVersion(version) ? version : null
  } catch {
    return null
  }
}

/** Adresse et empreinte du paquet d'une version. Lève une erreur lisible si l'empreinte est introuvable. */
export async function engineRelease(version: string, fetchImpl: FetchLike = fetch): Promise<EngineRelease> {
  if (!isValidEngineVersion(version)) throw new Error(t('ollamaEngine.badVersion', { version }))
  const base = `${RELEASES}/download/v${version}`
  let sha256: string | null = null
  try {
    const response = await fetchImpl(`${base}/sha256sum.txt`, { signal: AbortSignal.timeout(30_000) })
    if (response.ok) sha256 = checksumFor(await response.text())
  } catch {
    // Traité juste en dessous : sans empreinte, rien n'est installé.
  }
  if (!sha256) throw new Error(t('ollamaEngine.noChecksum', { version }))
  return { version, url: `${base}/${ENGINE_ZIP}`, sha256 }
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** tar.exe est livré avec Windows 10 et 11 (bsdtar, qui lit les .zip) : deux chemins en arguments, rien d'autre. */
function extractWithTar(zip: string, destination: string): Promise<void> {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', destination], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()))
  })
}

export type EngineInstallProgress =
  | ({ phase: 'download' } & DownloadProgress)
  | { phase: 'verify' | 'extract' }

export interface EngineInstallDeps {
  download: (url: string, destination: string, onProgress: (progress: DownloadProgress) => void) => Promise<unknown>
  hash: (path: string) => Promise<string>
  extract: (zip: string, destination: string) => Promise<void>
  /** Tests : le renommage final et ses délais d'essai (antivirus), voir renameWithRetries. */
  move?: (from: string, to: string) => Promise<void>
  renameDelays?: number[]
}

const defaultInstallDeps: EngineInstallDeps = {
  download: (url, destination, onProgress) => downloadToFile(url, destination, { onProgress }),
  hash: sha256OfFile,
  extract: extractWithTar
}

/** Dossier qui contient ollama.exe : la racine du paquet, ou un sous-dossier unique si le paquet en a un. */
async function findExeDir(dir: string): Promise<string | null> {
  if (existsSync(join(dir, 'ollama.exe'))) return dir
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, 'ollama.exe'))) return join(dir, entry.name)
  }
  return null
}

/**
 * Télécharge, vérifie et décompresse une version À CÔTÉ de celle en service (qui continue de tourner). Ne touche
 * pas à `current.json` : c'est l'appelant qui bascule, une fois la nouvelle version prête.
 */
export async function installEngineVersion(
  release: EngineRelease,
  onProgress: (progress: EngineInstallProgress) => void,
  options: { root?: string; deps?: EngineInstallDeps } = {}
): Promise<InstalledEngine> {
  const deps = options.deps ?? defaultInstallDeps
  const root = options.root ?? (await engineRoot())
  if (!isValidEngineVersion(release.version)) throw new Error(t('ollamaEngine.badVersion', { version: release.version }))
  const downloads = join(root, 'download')
  await mkdir(downloads, { recursive: true })
  const zip = join(downloads, `ollama-${release.version}.zip`)
  const versions = join(root, 'versions')
  const staging = join(versions, `${release.version}.partial`)
  // Étape 346 : un paquet déjà téléchargé ET vérifié est gardé si seule sa mise en place échoue (antivirus) — le
  // prochain essai repart de lui au lieu de retélécharger 1,6 Go.
  let keepZip = false
  try {
    const already = existsSync(zip) && (await deps.hash(zip).catch(() => '')).toLowerCase() === release.sha256.toLowerCase()
    if (!already) await deps.download(release.url, zip, (progress) => onProgress({ phase: 'download', ...progress }))
    onProgress({ phase: 'verify' })
    const digest = (await deps.hash(zip)).toLowerCase()
    if (digest !== release.sha256.toLowerCase()) throw new Error(t('ollamaEngine.badChecksum', { version: release.version }))
    keepZip = true
    onProgress({ phase: 'extract' })
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      await deps.extract(zip, staging)
    } catch (err) {
      throw new Error(t('ollamaEngine.unzipFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
    const exeDir = await findExeDir(staging)
    if (!exeDir) throw new Error(t('ollamaEngine.noExe'))
    const final = join(versions, release.version)
    await rm(final, { recursive: true, force: true })
    await renameWithRetries(exeDir, final, deps.renameDelays, deps.move)
    keepZip = false
    return { version: release.version, dir: final, exe: join(final, 'ollama.exe') }
  } finally {
    // Le paquet (1,6 Go) ne sert plus une fois le moteur en place, ni s'il est faux ; un dossier à moitié décompressé
    // ne sert jamais.
    if (!keepZip) await rm(zip, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** Efface toutes les versions sauf `keep` (et les restes d'une décompression interrompue). */
export async function removeOtherEngineVersions(root: string, keep: string): Promise<void> {
  const versions = join(root, 'versions')
  const entries = await readdir(versions).catch(() => [] as string[])
  for (const entry of entries) {
    if (entry !== keep) await rm(join(versions, entry), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Le dossier des modèles, chemin RÉEL (étape 289 : Ollama ne relit rien à travers une jonction). Entre
 * l'emplacement habituel (souvent une jonction posée par Jaris) et celui d'une variable OLLAMA_MODELS de
 * Windows, celui qui contient le plus de modèles : un utilisateur qui avait réglé son propre Ollama ailleurs ne
 * retélécharge rien. À égalité, l'emplacement habituel, celui que « Déplacer » gère.
 */
export async function engineModelsDir(
  options: { defaultDir?: string; variable?: string | undefined; count?: (dir: string) => Promise<number> } = {}
): Promise<string> {
  const defaultDir = options.defaultDir ?? join(homedir(), '.ollama', 'models')
  const variable = 'variable' in options ? options.variable : process.env.OLLAMA_MODELS
  const count = options.count ?? countOllamaModels
  await mkdir(defaultDir, { recursive: true }).catch(() => {})
  const defaultReal = await realpath(defaultDir).catch(() => defaultDir)
  const variableReal = variable?.trim() ? await realpath(variable.trim()).catch(() => null) : null
  if (!variableReal) return defaultReal
  return (await count(variableReal)) > (await count(defaultReal)) ? variableReal : defaultReal
}

/** Variables passées au moteur : son port, ses modèles. Le reste de l'environnement de Jaris est gardé. */
export function engineEnv(modelsDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Étape 346 : OLLAMA_NOPRUNE — sans lui, Ollama efface au démarrage les morceaux d'un modèle dont le téléchargement a
  // été interrompu : relancé le lendemain, un modèle de 20 Go repartait de 0 %.
  return { ...base, OLLAMA_HOST: `127.0.0.1:${ENGINE_PORT}`, OLLAMA_MODELS: modelsDir, OLLAMA_NOPRUNE: '1' }
}

/**
 * Lance `ollama serve`. Sous Windows, par Start-Process -WindowStyle Hidden, puis attendu : les programmes
 * qu'Ollama lance pour chaque modèle héritent d'une console cachée au lieu d'en ouvrir une visible, et
 * `taskkill /T` sur ce PowerShell arrête tout l'arbre (leçon notée dans CLAUDE.md sur les consoles d'Ollama).
 * Le chemin passe par une variable d'environnement, jamais dans le texte du script.
 */
export function spawnEngine(exe: string, env: NodeJS.ProcessEnv): ChildProcess {
  if (process.platform === 'win32') {
    return spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; $server = Start-Process -FilePath $env:JARIS_OLLAMA_EXE -ArgumentList 'serve' -WindowStyle Hidden -PassThru; $server.WaitForExit(); exit $server.ExitCode"
      ],
      { stdio: 'ignore', windowsHide: true, env: { ...env, JARIS_OLLAMA_EXE: exe } }
    )
  }
  return spawn(exe, ['serve'], { stdio: 'ignore', windowsHide: true, env })
}
