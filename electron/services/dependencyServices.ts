import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { config } from '../config'

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
 * Lance `ollama serve` si l'API ne répond pas déjà (ex: app Ollama pas encore démarrée au boot
 * Windows). Sans effet si Ollama tourne déjà - la commande échoue juste silencieusement (port pris).
 */
export async function ensureOllamaRunning(log: LogFn): Promise<void> {
  const url = `${config.ollama.host}/api/tags`
  if (await isUp(url)) return

  log("Ollama n'est pas lancé, démarrage automatique…")
  const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
  proc.unref()
  ollamaProcessStartedByJaris = proc

  const up = await waitUntil(() => isUp(url), 20000)
  log(up ? 'Ollama démarré.' : "Échec du démarrage automatique d'Ollama : lance-le manuellement (`ollama serve`).")
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
    if (process.platform === 'win32') {
      spawn('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }
    const dockerUp = await waitUntil(async () => {
      try {
        await execAsync('docker info', { windowsHide: true })
        return true
      } catch {
        return false
      }
    }, 90000, 3000)
    if (!dockerUp) {
      log('Docker n\'a pas pu démarrer automatiquement : ouvre Docker Desktop manuellement pour activer la recherche web.')
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
