import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { rm } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { config, setOllamaHost, WINDOWS_OLLAMA_HOST } from '../config'
import {
  ENGINE_HOST,
  engineEnv,
  engineModelsDir,
  engineRelease,
  engineRoot,
  installEngineVersion,
  installedEngine,
  latestEngineVersion,
  removeOtherEngineVersions,
  setCurrentEngine,
  spawnEngine,
  type EngineInstallProgress,
  type InstalledEngine
} from './ollamaEngine'
import { formatBytes } from '../../shared/formatBytes'
import type { OllamaVersionStatus, UpdateProgress } from '../../shared/ipc'
import { t } from '../../shared/i18n'

const execAsync = promisify(exec)

type LogFn = (message: string) => void

/**
 * Process `ollama serve` lancé par Jaris lui-même (voir ensureOllamaRunning) — `null` si Ollama tournait
 * déjà avant que Jaris démarre. Sert uniquement à savoir, au moment de quitter, s'il faut l'arrêter (voir
 * stopOllamaIfStartedByJaris) : jamais s'il tournait déjà avant, l'utilisateur peut s'en servir en dehors
 * de Jaris.
 */
let ollamaProcessStartedByJaris: ChildProcess | null = null

/** Ping HTTP simple : true dès que le service répond (peu importe le code, tant qu'il répond). */
async function isUp(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return true
  } catch {
    return false
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/** « 0.40.4-rc1 » compte comme 0.40.4 : seule la partie chiffrée est comparée. */
function isVersionOlder(version: string, minVersion: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((p) => parseInt(p, 10) || 0)
  const a = parts(version)
  const b = parts(minVersion)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0
  }
  return false
}

/**
 * Version d'Ollama comparée à la dernière publiée sur GitHub — voir checkOllamaFreshness. Le type vient de
 * shared/ipc.ts (étape 234) : la copie locale qui existait ici avait déjà divergé une fois de l'autre côté.
 */
export type { OllamaVersionStatus }

/**
 * Résultat du dernier check, gardé en mémoire pour que la page Options puisse le lire à tout moment sans refaire
 * l'appel réseau. `null` tant que le check n'a pas encore abouti : jamais affiché comme "à jour" par défaut.
 */
let cachedOllamaVersionStatus: OllamaVersionStatus | null = null

export function getOllamaVersionStatus(): OllamaVersionStatus | null {
  return cachedOllamaVersionStatus
}

/** Étape 170 : prévenu à CHAQUE nouveau résultat de checkOllamaFreshness — main.ts le relaie à l'écran. */
const ollamaVersionListeners = new Set<(status: OllamaVersionStatus) => void>()
export function onOllamaVersionStatus(listener: (status: OllamaVersionStatus) => void): () => void {
  ollamaVersionListeners.add(listener)
  return () => ollamaVersionListeners.delete(listener)
}

/** Relit la version réellement en service, `null` tant qu'Ollama ne répond pas. */
async function readLocalOllamaVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${config.ollama.host}/api/version`)
    if (!response.ok) return null
    const version = ((await response.json()) as { version?: string }).version ?? null
    if (version) knownLocalVersion = version
    return version
  } catch {
    return null
  }
}

/**
 * Étape 346 : la version en service, connue dès qu'Ollama a répondu — SANS attendre GitHub (lent, ou injoignable). Les
 * choix de modèles en dépendent (étape 312) : ils variaient selon que la comparaison avec GitHub avait fini ou non.
 */
let knownLocalVersion: string | null = null

export function getLocalOllamaVersion(): string | null {
  return knownLocalVersion ?? cachedOllamaVersionStatus?.current ?? null
}

/** Relit la version en service maintenant (avant un choix de modèles), sans interroger GitHub. */
export async function refreshLocalOllamaVersion(): Promise<string | null> {
  return (await readLocalOllamaVersion()) ?? getLocalOllamaVersion()
}

/**
 * Étape 336 : l'Ollama de Jaris en service (ollamaEngine.ts), `null` tant que Jaris utilise encore celui
 * installé sur Windows (installation faite avant l'étape 336, en attendant le clic dans Options).
 */
let embedded: InstalledEngine | null = null

/** Compare la version en service à la dernière publiée, et le diffuse (bouton « Mettre à jour » d'Options). */
async function checkOllamaFreshness(): Promise<void> {
  try {
    // Étape 234 (bêta) : un résultat est TOUJOURS enregistré, même partiel. Avant, Ollama muet ou GitHub
    // injoignable ne laissaient rien en cache, et Options affichait « Vérification de la version… » sans fin.
    const current = await readLocalOllamaVersion()
    const latest = await latestEngineVersion()
    cachedOllamaVersionStatus = {
      current,
      latest,
      outdated: Boolean(current && latest && isVersionOlder(current, latest)),
      embedded: embedded !== null
    }
    const status = cachedOllamaVersionStatus
    for (const listener of ollamaVersionListeners) listener(status)
  } catch {
    // Ne doit jamais empêcher Jaris de démarrer.
  }
}

/**
 * Avancement remonté pendant la mise à jour d'Ollama (étape 112) — `target` est ajouté par main.ts, qui seul
 * sait sur quel canal l'envoyer.
 */
export type OllamaUpdateProgress = (progress: Omit<UpdateProgress, 'target'>) => void

/** Le premier lancement n'a plus rien à installer côté Ollama dès que Jaris a le sien. */
export async function isOllamaInstalled(): Promise<boolean> {
  return (await installedEngine().catch(() => null)) !== null
}

/**
 * Processus de l'Ollama de Jaris restés d'un lancement précédent (Jaris arrêté brutalement) : ils tiennent le port
 * 11435. Seuls les programmes rangés dans le dossier du moteur sont arrêtés, jamais l'Ollama de Windows.
 */
async function stopStrayEngines(): Promise<void> {
  if (process.platform !== 'win32') return
  const root = await engineRoot().catch(() => null)
  if (!root) return
  await new Promise<void>((resolve) => {
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($env:JARIS_ENGINE_ROOT, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue"
      ],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, JARIS_ENGINE_ROOT: root } }
    )
    proc.on('error', () => resolve())
    proc.on('close', () => resolve())
  })
}

/** Arrête l'Ollama de Jaris (tout son arbre) et attend que le port soit libre. */
async function stopEmbeddedProcess(): Promise<void> {
  stopOllamaIfStartedByJaris()
  if (await waitUntil(async () => !(await isUp(`${ENGINE_HOST}/api/tags`, 1000)), 10_000, 500)) return
  await stopStrayEngines()
  await waitUntil(async () => !(await isUp(`${ENGINE_HOST}/api/tags`, 1000)), 10_000, 500)
}

/** Lance une version du moteur et attend qu'elle réponde. Vrai si elle répond. */
async function startEmbedded(found: InstalledEngine, log: LogFn): Promise<boolean> {
  embedded = found
  setOllamaHost(ENGINE_HOST)
  // Un serveur répond déjà sur le port. Lancé par ce Jaris et dans la bonne version : gardé. Sinon, c'est un reste
  // d'un lancement précédent (Jaris arrêté brutalement), peut-être avec un ancien dossier de modèles et que Jaris
  // ne pourrait pas arrêter en quittant : il est remplacé.
  if (await isUp(`${ENGINE_HOST}/api/tags`)) {
    if (ollamaProcessStartedByJaris && (await readLocalOllamaVersion()) === found.version) return true
    await stopStrayEngines()
    await waitUntil(async () => !(await isUp(`${ENGINE_HOST}/api/tags`, 1000)), 10_000, 500)
  }
  const modelsDir = await engineModelsDir()
  const proc = spawnEngine(found.exe, engineEnv(modelsDir))
  // spawn() signale un échec de façon asynchrone : sans ce listener, toute l'application planterait.
  proc.on('error', (err) => log(t('dep.ollamaAutoStartFailed', { error: err.message })))
  // Un Ollama qui s'arrête tout de suite (fichier retiré par un antivirus, bibliothèque manquante...) ne dit rien
  // de lui-même : son code de sortie est la seule trace qu'on puisse montrer.
  let exitCode: number | null | undefined
  proc.on('exit', (code) => {
    exitCode = code
  })
  proc.unref()
  ollamaProcessStartedByJaris = proc
  const up = await waitUntil(async () => exitCode === undefined && (await isUp(`${ENGINE_HOST}/api/tags`)), 30_000, 500)
  if (!up && exitCode !== undefined) log(t('ollamaEngine.exited', { code: String(exitCode) }))
  return up
}

function engineProgressToUpdate(progress: EngineInstallProgress): Omit<UpdateProgress, 'target'> {
  return progress.phase === 'download'
    ? { phase: 'download', receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes, percent: progress.percent }
    : { phase: 'install', receivedBytes: 0, totalBytes: null, percent: 100 }
}

/**
 * Premier lancement : installe l'Ollama de Jaris (dernière version) et le démarre. `false` en cas d'échec, avec
 * la vraie raison passée à onProgress.
 */
export async function installOllamaSilently(onProgress: (message: string, percent?: number) => void): Promise<boolean> {
  onProgress(t('dep.ollamaDownloading'), 0)
  try {
    const version = await latestEngineVersion()
    if (!version) throw new Error(t('ollamaEngine.noLatest'))
    const release = await engineRelease(version)
    const root = await engineRoot()
    const fresh = await installEngineVersion(release, (progress) => {
      if (progress.phase === 'download') {
        onProgress(
          progress.totalBytes === null
            ? t('dep.ollamaDownloadingBytes', { received: formatBytes(progress.receivedBytes) })
            : t('dep.ollamaDownloadingOf', { received: formatBytes(progress.receivedBytes), total: formatBytes(progress.totalBytes) }),
          progress.percent ?? undefined
        )
      } else {
        onProgress(t(progress.phase === 'verify' ? 'ollamaEngine.verifying' : 'ollamaEngine.extracting'))
      }
    }, { root })
    await setCurrentEngine(root, fresh.version)
    await removeOtherEngineVersions(root, fresh.version)
    onProgress(t('dep.ollamaStarting'))
    if (!(await startEmbedded(fresh, () => {}))) throw new Error(t('ollamaEngine.startFailed'))
    void checkOllamaFreshness()
    return true
  } catch (err) {
    onProgress(err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Résultat du bouton « Mettre à jour » / « Installer » d'Options. */
export interface OllamaUpdateResult {
  success: boolean
  message: string
}

let updating: Promise<OllamaUpdateResult> | null = null

/**
 * Bouton d'Options (étape 336). Deux cas, un seul chemin :
 * - Jaris utilise encore l'Ollama de Windows : installe le sien et bascule dessus, sans redémarrer Jaris ;
 * - Jaris a déjà le sien : installe la nouvelle version À CÔTÉ, redémarre le serveur dessus, vérifie qu'il répond
 *   avec le bon numéro, et seulement alors efface l'ancienne. Sinon, retour à l'ancienne, qui n'a pas bougé.
 * Plus de fenêtre d'installeur, plus d'autorisation Windows, plus de winget : tout se passe dans Jaris.
 */
export function updateOllama(onProgress?: OllamaUpdateProgress, log: LogFn = () => {}): Promise<OllamaUpdateResult> {
  if (updating) return updating
  updating = updateOllamaInner(onProgress, log)
    .catch((err): OllamaUpdateResult => ({ success: false, message: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      updating = null
    })
  return updating
}

async function updateOllamaInner(onProgress: OllamaUpdateProgress | undefined, log: LogFn): Promise<OllamaUpdateResult> {
  const latest = await latestEngineVersion()
  if (!latest) return { success: false, message: t('ollamaEngine.noLatest') }
  const root = await engineRoot()
  const previous = await installedEngine(root)
  if (previous && !isVersionOlder(previous.version, latest)) {
    await checkOllamaFreshness()
    return { success: true, message: t('options.ollama.upToDate', { current: previous.version }) }
  }
  const release = await engineRelease(latest)
  const fresh = await installEngineVersion(release, (progress) => onProgress?.(engineProgressToUpdate(progress)), { root })
  onProgress?.({ phase: 'install', receivedBytes: 0, totalBytes: null, percent: 100 })
  // Étape 346 : la nouvelle version est notée AVANT d'arrêter l'ancienne. Un refus de Windows (antivirus) laisse alors
  // l'ancienne tourner, au lieu de laisser Jaris sans Ollama.
  await setCurrentEngine(root, fresh.version)
  if (previous) await stopEmbeddedProcess()
  const started = await startEmbedded(fresh, log).catch(() => false)
  if (!started || (await readLocalOllamaVersion()) !== fresh.version) {
    // La nouvelle version ne démarre pas : retour à ce qui marchait, sans rien avoir effacé.
    await stopEmbeddedProcess()
    if (previous) {
      // Même si Windows refuse encore d'écrire current.json, l'ancienne version est relancée maintenant.
      await setCurrentEngine(root, previous.version).catch(() => {})
      await startEmbedded(previous, log)
    } else {
      await rm(join(root, 'current.json'), { force: true }).catch(() => {})
      embedded = null
      setOllamaHost(WINDOWS_OLLAMA_HOST)
    }
    await rm(fresh.dir, { recursive: true, force: true }).catch(() => {})
    await checkOllamaFreshness()
    return { success: false, message: t('ollamaEngine.switchFailed', { version: fresh.version }) }
  }
  await removeOtherEngineVersions(root, fresh.version)
  await checkOllamaFreshness()
  return {
    success: true,
    message: previous
      ? t('ollamaEngine.updated', { version: fresh.version })
      : t('ollamaEngine.installedNow', { version: fresh.version })
  }
}

/**
 * Démarre Ollama s'il ne répond pas déjà. L'Ollama de Jaris dès qu'il est installé ; sinon, comme avant l'étape
 * 336, `ollama serve` de Windows (sans effet s'il tourne déjà).
 */
export function ensureOllamaRunning(log: LogFn): Promise<void> {
  // Un seul démarrage à la fois : deux appels rapprochés (démarrage de Jaris et « Retester la configuration »)
  // lançaient chacun leur serveur sur le même port, et le second échouait.
  if (!ensuring) ensuring = ensureOllamaRunningOnce(log).finally(() => (ensuring = null))
  return ensuring
}
let ensuring: Promise<void> | null = null

async function ensureOllamaRunningOnce(log: LogFn): Promise<void> {
  const found = await installedEngine().catch(() => null)
  if (found) {
    if (embedded?.version === found.version && ollamaProcessStartedByJaris && (await isUp(`${ENGINE_HOST}/api/tags`))) {
      void checkOllamaFreshness()
      return
    }
    log(t('dep.ollamaAutoStart'))
    const up = await startEmbedded(found, log)
    log(up ? t('dep.ollamaStarted') : t('ollamaEngine.startFailed'))
    void checkOllamaFreshness()
    return
  }

  embedded = null
  setOllamaHost(WINDOWS_OLLAMA_HOST)
  const url = `${config.ollama.host}/api/tags`
  if (await isUp(url)) {
    void checkOllamaFreshness()
    return
  }

  log(t('dep.ollamaAutoStart'))
  // Une console absente sur le parent oblige les helpers GPU d’Ollama à en créer
  // une nouvelle. Sous Windows, fournir une console cachée qu’ils peuvent hériter.
  // Garder PowerShell vivant permet aussi à taskkill /T de fermer tout l’arbre.
  // Ne pas le détacher : testé sous Windows, PowerShell détaché sortait sans lancer
  // le serveur. Le serveur créé par Start-Process possède sa propre console cachée.
  const proc = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $server = Start-Process -FilePath 'ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden -PassThru; $server.WaitForExit(); exit $server.ExitCode"
    ], { stdio: 'ignore', windowsHide: true })
    : spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
  // spawn() signale un échec (ex: "ollama" absent du PATH) de façon asynchrone via l'évènement 'error' du
  // process, jamais en levant une exception directement : sans ce listener, Node la traite comme une
  // exception non rattrapée et ça plante tout Jaris (au lieu de juste échouer à démarrer Ollama).
  proc.on('error', (err) => log(t('dep.ollamaAutoStartFailed', { error: err.message })))
  proc.unref()
  ollamaProcessStartedByJaris = proc

  const up = await waitUntil(() => isUp(url), 20000)
  log(up ? t('dep.ollamaStarted') : t('dep.ollamaStartManually'))
  if (up) void checkOllamaFreshness()
}

/** Vrai quand Jaris utilise son propre Ollama (il n'a alors rien à corriger dans les réglages de Windows). */
export function usesEmbeddedOllama(): boolean {
  return embedded !== null
}

/**
 * Relance Ollama (réparation de l'étape 289). L'Ollama de Jaris seul quand c'est lui : l'Ollama de Windows,
 * qu'un utilisateur peut aussi employer en dehors de Jaris, n'est plus arrêté pour rien.
 */
export async function restartOllama(log: LogFn): Promise<void> {
  if (embedded) await stopEmbeddedProcess()
  else await stopOllamaCompletely()
  await ensureOllamaRunning(log)
}

/**
 * Arrête Ollama uniquement si c'est cette instance de Jaris qui l'a démarré (jamais s'il tournait déjà
 * avant, voir ollamaProcessStartedByJaris) : appelé quand Jaris quitte vraiment, pour qu'aucun process ne
 * continue de tourner en arrière-plan une fois Jaris fermé. L'Ollama de Jaris est toujours démarré par lui.
 */
export function stopOllamaIfStartedByJaris(): void {
  const pid = ollamaProcessStartedByJaris?.pid
  ollamaProcessStartedByJaris = null
  if (pid === undefined) return

  try {
    // .kill() seul ne suffit pas toujours sous Windows, et ne fermerait de toute façon pas les sous-process
    // qu'Ollama a pu lancer pour un modèle chargé (voir /T) : taskkill est le seul moyen fiable ici.
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid)
    }
  } catch {
    // Rien de plus à faire : au pire Ollama continue de tourner, comme avant ce correctif.
  }
}

/**
 * Arrête TOUT process Ollama en cours (celui de Jaris, celui de Windows ET son appli barre système, qui le
 * relancerait sinon tout seul) — nécessaire avant de déplacer le dossier des modèles (« Déplacer ») : tant
 * qu'un fichier de ce dossier est ouvert, le déplacer échouerait. `ensureOllamaRunning` le relance ensuite.
 */
export async function stopOllamaCompletely(): Promise<void> {
  ollamaProcessStartedByJaris = null
  await execAsync('taskkill /IM ollama.exe /F', { windowsHide: true }).catch(() => {})
  await execAsync('taskkill /IM "ollama app.exe" /F', { windowsHide: true }).catch(() => {})
  await stopStrayEngines()
}
