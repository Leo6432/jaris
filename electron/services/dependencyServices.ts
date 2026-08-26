import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { config } from '../config'
import { openApp } from './appLauncher'

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

/**
 * En dessous de cette version, `ollama serve` peut faire flasher une brève fenêtre de console Windows
 * vide à chaque chargement/changement de modèle (le process "runner" qu'Ollama lance en interne n'était
 * pas caché sur Windows) — corrigé upstream dans la 0.7.0 (ollama/ollama#8668). Rien à faire côté Jaris,
 * qui ne lance que `ollama serve` lui-même (déjà avec windowsHide) : le correctif est entièrement dans le
 * binaire Ollama, seule une mise à jour peut faire disparaître ces flashs.
 */
const MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH = '0.7.0'

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

async function warnIfOllamaOutdated(log: LogFn): Promise<void> {
  try {
    const response = await fetch(`${config.ollama.host}/api/version`)
    if (!response.ok) return
    const data = (await response.json()) as { version?: string }
    if (data.version && isVersionOlder(data.version, MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH)) {
      log(
        `Ollama ${data.version} détecté : les versions antérieures à ${MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH} ` +
          "peuvent faire apparaître de brèves fenêtres de console Windows vides au chargement d'un modèle " +
          '(bug corrigé côté Ollama, pas côté Jaris) — mets à jour Ollama sur ollama.com/download pour les faire disparaître.'
      )
    }
  } catch {
    // Purement informatif : un échec ici (Ollama trop vieux pour exposer /api/version, etc.) ne doit
    // jamais empêcher Jaris de démarrer.
  }
}

/**
 * Lance `ollama serve` si l'API ne répond pas déjà (ex: app Ollama pas encore démarrée au boot
 * Windows). Sans effet si Ollama tourne déjà - la commande échoue juste silencieusement (port pris).
 */
export async function ensureOllamaRunning(log: LogFn): Promise<void> {
  const url = `${config.ollama.host}/api/tags`
  if (await isUp(url)) {
    void warnIfOllamaOutdated(log)
    return
  }

  log("Ollama n'est pas lancé, démarrage automatique…")
  const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
  // spawn() signale un échec (ex: "ollama" absent du PATH) de façon asynchrone via l'évènement 'error' du
  // process, jamais en levant une exception directement : sans ce listener, Node la traite comme une
  // exception non rattrapée et ça plante tout Jaris (au lieu de juste échouer à démarrer Ollama).
  proc.on('error', (err) => log(`Échec du démarrage automatique d'Ollama : ${err.message}`))
  proc.unref()
  ollamaProcessStartedByJaris = proc

  const up = await waitUntil(() => isUp(url), 20000)
  log(up ? 'Ollama démarré.' : "Échec du démarrage automatique d'Ollama : lance-le manuellement (`ollama serve`).")
  if (up) void warnIfOllamaOutdated(log)
}

/**
 * Arrête Ollama uniquement si c'est cette instance de Jaris qui l'a démarré (jamais s'il tournait déjà
 * avant, voir ollamaProcessStartedByJaris) : appelé quand Jaris quitte vraiment (Quitter dans la barre
 * système), pour qu'aucun process ne continue de tourner en arrière-plan une fois Jaris fermé. Sans ça,
 * `ollama serve` reste actif indéfiniment (lancé "detached" pour survivre à Jaris) et peut décharger/
 * recharger un modèle tout seul après quelques minutes d'inactivité, ce qui fait parfois flasher une
 * fenêtre de console Windows même Jaris éteint.
 */
export function stopOllamaIfStartedByJaris(): void {
  const pid = ollamaProcessStartedByJaris?.pid
  ollamaProcessStartedByJaris = null
  if (pid === undefined) return

  try {
    // .kill() seul ne suffit pas toujours pour un process "detached" sous Windows, et ne fermerait de
    // toute façon pas les sous-process qu'Ollama a pu lancer pour un modèle chargé (voir /T) : taskkill
    // est le seul moyen fiable de tout arrêter proprement ici.
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
 * Démarre Docker Desktop (si besoin) puis `docker compose up -d` pour SearXNG (recherche web).
 * Non bloquant pour le reste de Jaris : la recherche web est juste indisponible en attendant.
 */
export async function ensureSearxngRunning(log: LogFn): Promise<void> {
  if (await isUp(config.searxng.host)) return

  log("SearXNG n'est pas lancé, démarrage de Docker…")
  try {
    await execAsync('docker info', { windowsHide: true })
  } catch {
    // true si Docker Desktop est introuvable (pas juste "pas encore démarré") : dans ce cas, inutile
    // d'attendre 90s en sondant `docker info` en boucle, le résultat est déjà connu.
    let launchFailed = false
    if (process.platform === 'win32') {
      // Réutilise openApp (étape 5, même mécanisme que "ouvre Discord" à la voix) plutôt qu'un chemin
      // d'installation codé en dur : celui-ci suppose l'emplacement par défaut
      // (C:\Program Files\Docker\Docker\Docker Desktop.exe) et échoue silencieusement si Docker Desktop
      // est installé ailleurs (autre disque, install utilisateur...) — vécu par Léo, qui a dû le lancer
      // à la main alors qu'il était bien installé. openApp cherche dans le menu Démarrer Windows, qui
      // connaît l'appli quel que soit son chemin réel d'installation.
      const result = await openApp('Docker Desktop')
      log(result)
      launchFailed = !result.endsWith('a été lancé.')
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
      log('Docker n\'a pas pu démarrer automatiquement : installe Docker Desktop (ou ouvre-le manuellement s\'il est déjà installé ailleurs) pour activer la recherche web.')
      return
    }
  }

  try {
    await execAsync('docker compose up -d', { cwd: process.cwd(), windowsHide: true })
  } catch (err) {
    log(`Échec du démarrage de SearXNG : ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const up = await waitUntil(() => isUp(config.searxng.host), 30000)
  log(up ? 'SearXNG démarré.' : 'SearXNG ne répond pas encore, réessaie la recherche web dans un instant.')
}
