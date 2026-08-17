import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { config } from '../config'

const execAsync = promisify(exec)

type LogFn = (message: string) => void

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
  spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref()

  const up = await waitUntil(() => isUp(url), 20000)
  log(up ? 'Ollama démarré.' : "Échec du démarrage automatique d'Ollama : lance-le manuellement (`ollama serve`).")
}

/**
 * Démarre Docker Desktop (si besoin) puis `docker compose up -d` pour SearXNG (recherche web).
 * Non bloquant pour le reste de Jaris : la recherche web est juste indisponible en attendant.
 */
export async function ensureSearxngRunning(log: LogFn): Promise<void> {
  if (await isUp(config.searxng.host)) return

  log("SearXNG n'est pas lancé, démarrage de Docker…")
  try {
    await execAsync('docker info')
  } catch {
    if (process.platform === 'win32') {
      spawn('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', { detached: true, stdio: 'ignore' }).unref()
    }
    const dockerUp = await waitUntil(async () => {
      try {
        await execAsync('docker info')
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
    await execAsync('docker compose up -d', { cwd: process.cwd() })
  } catch (err) {
    log(`Échec du démarrage de SearXNG : ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const up = await waitUntil(() => isUp(config.searxng.host), 30000)
  log(up ? 'SearXNG démarré.' : 'SearXNG ne répond pas encore, réessaie la recherche web dans un instant.')
}
