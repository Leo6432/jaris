import { dockerInstallFlags } from './dockerLocation'
import { downloadsDir, getStorageRoot } from './storageRoot'
import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { rm, rmdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { config, setOllamaHost, WINDOWS_OLLAMA_HOST } from '../config'
import { didAppLaunch, openApp } from './appLauncher'
import { downloadToFile } from './download'
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
import {
  LEGACY_SEARXNG_PROJECT,
  SEARXNG_PROJECT,
  composeCommand,
  composeWorkingDir,
  parseContainerIds,
  prepareSearxngComposeDir,
  sameDir,
  searxngComposeDir
} from './searxngHome'
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
    return ((await response.json()) as { version?: string }).version ?? null
  } catch {
    return null
  }
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
/** Lien stable officiel documenté par Docker (docs.docker.com/desktop/setup/install/windows-install) — toujours la dernière version stable pour Windows/amd64. */
const DOCKER_DESKTOP_INSTALLER_URL = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'

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
  proc.unref()
  ollamaProcessStartedByJaris = proc
  return waitUntil(() => isUp(`${ENGINE_HOST}/api/tags`), 30_000, 500)
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
  if (previous) await stopEmbeddedProcess()
  await setCurrentEngine(root, fresh.version)
  const started = await startEmbedded(fresh, log)
  if (!started || (await readLocalOllamaVersion()) !== fresh.version) {
    // La nouvelle version ne démarre pas : retour à ce qui marchait, sans rien avoir effacé.
    await stopEmbeddedProcess()
    if (previous) {
      await setCurrentEngine(root, previous.version)
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
export async function ensureOllamaRunning(log: LogFn): Promise<void> {
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

/**
 * Teste directement la vraie capacité dont Jaris a besoin (une recherche en format JSON, voir webSearch.ts)
 * plutôt que de comparer des fichiers ou des hash : peu importe la RAISON pour laquelle un conteneur déjà
 * lancé refuserait le JSON (process jamais redémarré depuis un changement de settings.yml, bind mount Docker
 * qui n'a jamais vu le bon fichier, config corrompue...), ce test la détecte directement en reproduisant la
 * vraie requête. Un essai plus tôt (comparaison de hash entre settings.yml et un marqueur dans userData,
 * v0.3.6) supposait à tort que la seule cause possible était "le process n'a jamais relu le fichier depuis
 * qu'il a changé" — insuffisant, vécu par Léo (403 toujours présent malgré ce correctif).
 */
async function searxngJsonSearchWorks(): Promise<boolean> {
  try {
    const url = new URL('/search', config.searxng.host)
    url.searchParams.set('q', 'test')
    url.searchParams.set('format', 'json')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return response.status !== 403
  } catch {
    // Timeout/erreur réseau : ne pas prendre ça pour un vrai 403 et déclencher un recréation pour rien —
    // isUp() vient déjà de répondre true juste avant, donc SearXNG répond, ce test est juste indisponible.
    return true
  }
}

/**
 * Lit la publication RÉELLE du port de SearXNG, telle que Docker l'applique en ce moment
 * (`docker compose port` répond par exemple "0.0.0.0:8091" ou "127.0.0.1:8091"), plutôt que de relire la
 * ligne `ports:` de docker-compose.yml : un conteneur garde la publication décidée à sa CRÉATION, changer
 * le fichier ensuite ne la modifie jamais tout seul. Même principe que searxngJsonSearchWorks ci-dessus —
 * constater un fait observable, jamais déduire l'état d'un conteneur depuis un fichier sur le disque.
 * Renvoie null si la commande échoue (Docker indisponible, service inconnu...) : c'est "je ne sais pas",
 * pas "c'est ouvert".
 */
async function readSearxngPortBinding(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(composeCommand('port searxng 8080'), {
      cwd: searxngComposeDir(),
      windowsHide: true
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * true si la publication lue ci-dessus reste limitée à cet ordinateur. Séparée de la commande Docker (et
 * exportée) pour être testable sans Docker — scripts/test-searxng-binding.mjs.
 *
 * Docker peut publier le port sur plusieurs interfaces à la fois (une ligne chacune, IPv4 et IPv6) : il
 * suffit d'UNE ligne ouverte pour que la machine soit joignable depuis le Wi-Fi, d'où le `every`.
 * Une valeur nulle/vide signifie "diagnostic indisponible" et répond true : on ne recrée jamais un
 * conteneur qui fonctionne sur la foi d'une commande qui n'a pas pu répondre (même prudence que le catch
 * de searxngJsonSearchWorks).
 */
export function isLocalOnlyBinding(binding: string | null): boolean {
  if (!binding) return true
  const lines = binding
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return true
  return lines.every((line) => line.startsWith('127.0.0.1:') || line.startsWith('[::1]:'))
}

/**
 * Diagnostic seulement (jamais utilisé pour réparer quoi que ce soit tout seul) : lit le VRAI fichier
 * settings.yml tel que le conteneur SearXNG le voit RÉELLEMENT à cet instant, à comparer avec le fichier sur
 * le disque de Jaris (searxng/settings.yml). Ajouté après que 3 hypothèses successives se soient révélées
 * fausses ou non concluantes en usage réel (v0.3.6 : process pas relancé ; v0.3.7 : montage jamais recréé ;
 * v0.3.9 : port déjà pris par un autre logiciel — cette dernière basée sur une identification erronée du
 * corps de la réponse 403, voir le commentaire dans webSearch.ts) : plutôt qu'une 4e hypothèse non vérifiée,
 * cette fonction rapporte un FAIT — ce que le conteneur voit vraiment — pour la première fois. Ne lève
 * jamais d'exception : un diagnostic qui échoue ne doit jamais faire échouer la vraie recherche par-dessus.
 */
export async function readSearxngContainerSettings(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(composeCommand('exec -T searxng cat /etc/searxng/settings.yml'), {
      cwd: searxngComposeDir(),
      windowsHide: true
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * true si le sous-système Windows pour Linux (WSL) est déjà installé — condition préalable au
 * fonctionnement de Docker Desktop sur Windows (backend par défaut), vécu en usage réel par Léo : Docker
 * Desktop installé avec succès (installDockerDesktop ci-dessous) mais refusant quand même de démarrer,
 * affichant sa propre erreur "WSL not installed" en lui demandant de lancer `wsl --install` à la main. Sur
 * une machine où WSL n'a jamais été installé, `wsl --status` échoue (ou déclenche l'invite Windows "WSL
 * n'est pas installé") ; sur une machine où WSL est déjà là (même sans distribution Linux installée), elle
 * réussit.
 */
async function isWslInstalled(): Promise<boolean> {
  try {
    await execAsync('wsl --status', { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Installe WSL, prérequis silencieusement manquant de Docker Desktop sur une machine qui ne l'avait jamais
 * utilisé (vécu en usage réel par Léo). `wsl --install --no-distribution` DOIT être lancé depuis un terminal Administrateur
 * (vérifié sur learn.microsoft.com/windows/wsl/install avant d'écrire cette fonction) : Jaris lui-même ne
 * tourne pas élevé, donc on déclenche l'élévation via PowerShell `Start-Process -Verb RunAs`, qui affiche la
 * même fenêtre Windows (UAC) que pour l'installation de Docker Desktop — sert le même accord explicite,
 * jamais contournable de toute façon. `--no-distribution` évite d'installer Ubuntu sur C: : Docker Desktop
 * utilise sa propre distribution WSL et n'en demande pas d'autre. Un redémarrage est TOUJOURS nécessaire après un premier `wsl --install`
 * réussi (documenté explicitement par Microsoft, contrairement aux codes de sortie non documentés de Docker
 * Desktop) : jamais redémarrer le PC à la place de Léo, seulement le lui dire clairement à l'appelant.
 */
async function installWsl(onProgress: (message: string) => void): Promise<boolean> {
  onProgress(t('dep.wslInstalling'))
  const exitCode = await new Promise<number | null>((resolve) => {
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-Command', "Start-Process wsl.exe -ArgumentList '--install --no-distribution' -Verb RunAs -WindowStyle Hidden -Wait"],
      { windowsHide: true }
    )
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => resolve(code))
  })
  // Code 0 = l'élévation a réussi et `wsl --install` a tourné jusqu'au bout (le redémarrage reste
  // nécessaire, voir isWslInstalled ci-dessus) ; tout autre code (ou process introuvable) couvre aussi bien
  // l'autorisation Windows refusée par l'utilisateur qu'un échec réel — on ne peut pas distinguer les deux
  // avec certitude depuis ce seul code, donc jamais affirmer "installé" dans ce cas.
  return exitCode === 0
}

/**
 * Installe Docker Desktop, à la demande explicite de Léo ("je préfère qu'il essaie de l'installer tout
 * seul, avec mon accord affiché au moment de l'installation") : contrairement à Ollama (installOllamaSilently
 * ci-dessus), on n'essaie PAS de rendre ça 100% invisible. Activer la virtualisation (WSL2/Plateforme de
 * machine virtuelle) nécessaire à Docker Desktop demande une élévation Windows (UAC) que ni Jaris ni
 * l'installeur ne peuvent contourner — l'utilisateur VERRA forcément une fenêtre Windows lui demander une
 * autorisation, quels que soient les indicateurs passés ici. Cette fenêtre sert justement l'accord explicite
 * demandé, pas la peine d'en rajouter une autre.
 *
 * `install --quiet --accept-license` sont les indicateurs officiels documentés par Docker (pas de fenêtre
 * d'installation à cliquer, contrairement à Ollama où aucun indicateur silencieux n'existe) : "quiet" évite
 * l'assistant d'installation, pas l'invite UAC elle-même. Docker ne documente PAS ses codes de sortie
 * (vérifié sur docs.docker.com avant d'écrire cette fonction) : contrairement à installOllamaSilently, on ne
 * peut donc pas distinguer avec certitude "installé avec succès" de "redémarrage nécessaire" par le seul
 * code de sortie — l'appelant (ensureSearxngRunning) le découvre plutôt en essayant de relancer Docker
 * Desktop juste après et en observant s'il répond vraiment, jamais en devinant depuis un code non documenté.
 */
export async function installDockerDesktop(onProgress: (message: string) => void, targetRoot?: string): Promise<boolean> {
  onProgress(t('dep.dockerDownloading'))
  const installerPath = join(targetRoot ? join(targetRoot, 'downloads') : downloadsDir(), 'JarisDockerDesktopInstaller.exe')
  try {
    // Le plafond était ici de 10 minutes pour le téléchargement entier, choisi à partir de la taille
    // réelle du fichier (~600 Mo) — déjà mieux que les 2 minutes d'Ollama, mais ça exigeait quand même
    // 8 Mbit/s soutenus pendant 10 minutes d'affilée. Comme les deux autres installeurs, ce téléchargement
    // passe maintenant par downloadToFile : plus de délai TOTAL du tout (une connexion lente finit par
    // aboutir), seule une absence complète de données pendant une minute abandonne, et l'avancement
    // s'affiche au lieu d'un message figé.
    await downloadToFile(DOCKER_DESKTOP_INSTALLER_URL, installerPath, {
      onProgress: ({ receivedBytes, totalBytes }) =>
        onProgress(
          totalBytes === null
            ? t('dep.dockerDownloadingBytes', { received: formatBytes(receivedBytes) })
            : t('dep.dockerDownloadingOf', { received: formatBytes(receivedBytes), total: formatBytes(totalBytes) })
        )
    })
  } catch (err) {
    onProgress(err instanceof Error ? err.message : t('dep.dockerDownloadFailed'))
    return false
  }

  onProgress(t('dep.dockerInstalling'))
  const exitCode = await new Promise<number | null>((resolve) => {
    // Étape 143 : dans le dossier de Jaris quand il y en a un (programme ET disque virtuel où vivent les images),
    // avec les indicateurs officiels de Docker — sinon Docker se mettrait sur C quoi que Léo ait choisi.
    const root = targetRoot ?? getStorageRoot()
    const tempDir = root ? join(root, 'downloads', 'docker-temp') : null
    if (tempDir) mkdirSync(tempDir, { recursive: true })
    const env = tempDir ? { ...process.env, TEMP: tempDir, TMP: tempDir } : process.env
    const proc = spawn(installerPath, ['install', '--quiet', '--accept-license', ...dockerInstallFlags(root)], { windowsHide: true, env })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => resolve(code))
  })
  return exitCode === 0
}

/** Identifiants des conteneurs SearXNG d'un projet Compose donné (liste vide si Docker ne répond pas). */
async function searxngContainers(project: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `docker ps -aq --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=searxng`,
      { windowsHide: true }
    )
    return parseContainerIds(stdout)
  } catch {
    return []
  }
}

/**
 * Étape 153 (voir searxngHome.ts) : retire les conteneurs SearXNG qui ne sont pas montés depuis `dir` —
 * l'ancien projet créé depuis le dossier du programme (il bloquait les mises à jour de Jaris), ou le projet
 * actuel créé depuis un ancien dossier de données (après un « Déplacer »). `true` si un conteneur a été
 * retiré. Constaté sur un fait (l'étiquette que Docker pose sur le conteneur), jamais deviné ; une étiquette
 * illisible ne fait rien retirer.
 */
async function retireMisplacedSearxng(dir: string): Promise<boolean> {
  const retired = await searxngContainers(LEGACY_SEARXNG_PROJECT)
  const oldDirs: string[] = []
  for (const id of await searxngContainers(SEARXNG_PROJECT)) {
    try {
      const { stdout } = await execAsync(`docker inspect --format "{{json .Config.Labels}}" ${id}`, { windowsHide: true })
      const workingDir = composeWorkingDir(stdout.trim())
      if (workingDir && !sameDir(workingDir, dir)) {
        retired.push(id)
        oldDirs.push(workingDir)
      }
    } catch {
      // illisible : on ne touche pas à un conteneur qui fonctionne peut-être très bien
    }
  }
  if (!retired.length) return false
  try {
    await execAsync(`docker rm -f ${retired.join(' ')}`, { windowsHide: true })
  } catch {
    return false
  }
  // Le conteneur retenait son ancien dossier (un « Déplacer » n'avait donc pas pu l'effacer) : maintenant
  // libre, il est effacé — seulement s'il s'agit bien d'un dossier `searxng-docker` de Jaris, jamais autre
  // chose — puis son parent s'il ne contient plus rien.
  for (const oldDir of oldDirs) {
    if (basename(oldDir) !== basename(dir)) continue
    await rm(oldDir, { recursive: true, force: true }).catch(() => {})
    await rmdir(dirname(oldDir)).catch(() => {})
  }
  return true
}

/**
 * Démarre Docker Desktop (si besoin) puis `docker compose up -d` pour SearXNG (recherche web) — ou, si le
 * conteneur tourne déjà mais refuse le format JSON (searxngJsonSearchWorks ci-dessus), `docker compose up -d
 * --force-recreate` pour repartir d'un conteneur neuf qui relit tout (settings.yml ET la résolution du
 * montage Docker) depuis zéro, plutôt qu'un simple `restart` qui ne relance que le process SANS jamais
 * retoucher au montage déjà en place. Non bloquant pour le reste de Jaris : la recherche web est juste
 * indisponible en attendant.
 */
export async function ensureSearxngRunning(log: LogFn): Promise<void> {
  let dir: string
  try {
    dir = prepareSearxngComposeDir()
  } catch (err) {
    log(t('dep.searxngDirFailed', { error: err instanceof Error ? err.message : String(err) }))
    return
  }
  if ((await isUp(config.searxng.host)) && (await retireMisplacedSearxng(dir))) {
    log(t('dep.searxngMoving'))
  }
  if (await isUp(config.searxng.host)) {
    // Deux raisons de recréer un conteneur DÉJÀ lancé, constatées chacune sur un fait observable : il
    // refuse le format JSON, ou il publie son port sur tout le réseau local. Les deux sont vérifiées avant
    // d'agir pour ne recréer qu'une seule fois si elles sont vraies en même temps.
    const networkExposed = !isLocalOnlyBinding(await readSearxngPortBinding())
    const jsonBroken = !(await searxngJsonSearchWorks())
    if (networkExposed || jsonBroken) {
      log(
        networkExposed
          ? t('dep.searxngExposed')
          : t('dep.searxngNoJson')
      )
      try {
        await execAsync(composeCommand('up -d --force-recreate'), { cwd: searxngComposeDir(), windowsHide: true })
        if (jsonBroken) {
          const fixed = await waitUntil(() => searxngJsonSearchWorks(), 30000)
          log(fixed ? t('dep.searxngJsonFixed') : t('dep.searxngJsonStillBroken'))
        }
        if (networkExposed) {
          const stillExposed = !isLocalOnlyBinding(await readSearxngPortBinding())
          log(
            stillExposed
              ? t('dep.searxngStillExposed')
              : t('dep.searxngLocalOnly')
          )
        }
      } catch (err) {
        log(t('dep.searxngRecreateFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    }
    return
  }

  log(t('dep.searxngStartingDocker'))
  try {
    await execAsync('docker info', { windowsHide: true })
  } catch {
    // true si Docker Desktop est introuvable (pas juste "pas encore démarré") : dans ce cas, inutile
    // d'attendre 90s en sondant `docker info` en boucle, le résultat est déjà connu.
    let launchFailed = false
    // Distingue le message final si Jaris vient tout juste d'installer Docker Desktop lui-même (voir plus
    // bas) : dans ce cas précis seulement, une absence de réponse a de bonnes chances d'être un redémarrage
    // Windows requis, pas la peine de le suggérer dans tous les autres cas.
    let justInstalled = false
    if (process.platform === 'win32') {
      // WSL d'abord, AVANT même de toucher à Docker Desktop : c'est un prérequis pour que Docker Desktop
      // fonctionne sur Windows (backend par défaut), que Docker Desktop soit déjà installé ou non — vécu en
      // usage réel par Léo : Docker Desktop installé avec succès par Jaris (v0.4.0) mais bloqué derrière sa
      // propre erreur "WSL not installed" au démarrage, jamais détecté ici puisque ce check n'existait
      // qu'à l'intérieur de la branche "Docker Desktop pas installé du tout", jamais atteinte une fois
      // Docker Desktop déjà présent. Un `wsl --install` qui vient de vraiment installer WSL exige un
      // redémarrage AVANT que Docker Desktop puisse jamais démarrer : pas la peine d'aller plus loin dans ce
      // cas précis, la suite reprendra automatiquement au prochain lancement de Jaris une fois WSL en place.
      if (!(await isWslInstalled())) {
        const wslLaunched = await installWsl(log)
        if (!(await isWslInstalled())) {
          log(
            wslLaunched
              ? t('dep.wslRestart')
              : t('dep.wslFailed')
          )
          return
        }
      }

      // Réutilise openApp (étape 5, même mécanisme que "ouvre Discord" à la voix) plutôt qu'un chemin
      // d'installation codé en dur : celui-ci suppose l'emplacement par défaut
      // (C:\Program Files\Docker\Docker\Docker Desktop.exe) et échoue silencieusement si Docker Desktop
      // est installé ailleurs (autre disque, install utilisateur...) — vécu par Léo, qui a dû le lancer
      // à la main alors qu'il était bien installé. openApp cherche dans le menu Démarrer Windows, qui
      // connaît l'appli quel que soit son chemin réel d'installation.
      const result = await openApp('Docker Desktop')
      log(result)
      launchFailed = !didAppLaunch(result)

      // "aucune application nommée..." = Docker Desktop n'est PAS installé (pas juste pas lancé) : à la
      // demande explicite de Léo, on essaie de l'installer nous-mêmes plutôt que de se contenter de lui
      // dire d'aller le faire — voir installDockerDesktop ci-dessus pour pourquoi ce n'est PAS silencieux
      // comme pour Ollama (élévation Windows incontournable).
      if (launchFailed && result === t('app.notFound', { name: 'Docker Desktop' })) {
        justInstalled = await installDockerDesktop(log)
        if (justInstalled) {
          log(t('dep.dockerInstalledStarting'))
          const relaunch = await openApp('Docker Desktop')
          log(relaunch)
          launchFailed = !didAppLaunch(relaunch)
        } else {
          log(t('dep.dockerInstallFailed'))
        }
      }
    }

    const dockerUp = !launchFailed && (await waitUntil(async () => {
      try {
        await execAsync('docker info', { windowsHide: true })
        return true
      } catch {
        return false
      }
    }, 90000, 3000))
    if (!dockerUp) {
      // Après une installation qui vient de réussir, Docker Desktop qui ne répond toujours pas après 90s a
      // de bonnes chances d'attendre un redémarrage Windows (activation de la virtualisation) — jamais
      // confirmé avec certitude (Docker ne documente pas ses codes de sortie), donc formulé comme une piste
      // probable, pas un fait, plutôt que d'inventer une cause précise.
      log(
        justInstalled
          ? t('dep.dockerNeedsRestart')
          : t('dep.dockerStartFailed')
      )
      return
    }
  }

  try {
    // Un ancien conteneur (monté depuis le programme) redémarré tout seul avec Docker occuperait le port 8091.
    await retireMisplacedSearxng(dir)
    await execAsync(composeCommand('up -d'), { cwd: dir, windowsHide: true })
  } catch (err) {
    log(t('dep.searxngStartFailed', { error: err instanceof Error ? err.message : String(err) }))
    return
  }

  const up = await waitUntil(() => isUp(config.searxng.host), 30000)
  log(up ? t('dep.searxngStarted') : t('dep.searxngNotYet'))
}
