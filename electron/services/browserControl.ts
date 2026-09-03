import { spawn } from 'child_process'
import { connect } from 'net'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Depuis Chrome 136+, Google interdit la connexion CDP (Chrome DevTools Protocol, nécessaire pour lire
 * un onglet depuis l'extérieur) sur le profil par défaut, pour des raisons de sécurité. La seule solution
 * qui marche encore (vérifiée sur jarvis-assistant-vocal, projet comparable) : un Chrome séparé, lancé
 * avec `--remote-debugging-port` ET un profil dédié (`--user-data-dir`) — jamais le profil de tous les
 * jours de l'utilisateur. Conséquence assumée : Jaris ne peut lire que les onglets ouverts dans CETTE
 * fenêtre dédiée, auto-lancée au besoin, pas le Chrome habituel de l'utilisateur.
 */
const CDP_PORT = 9222
const CDP_HOST = '127.0.0.1'

function dedicatedProfileDir(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'JarisChrome')
}

function findChromeExe(): string | null {
  const candidates = [
    join(process.env['ProgramFiles'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: CDP_HOST, port, timeout: 500 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/** Lance la fenêtre Chrome dédiée à Jaris (profil séparé, voir le commentaire en tête de fichier). */
function launchDebugChrome(): boolean {
  const exe = findChromeExe()
  if (!exe) return false
  const proc = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dedicatedProfileDir()}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  proc.unref()
  return true
}

interface CdpTarget {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl: string
}

async function listPages(): Promise<CdpTarget[]> {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })
  const targets = (await res.json()) as CdpTarget[]
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

/**
 * Se connecte à la fenêtre Chrome dédiée déjà lancée, sinon la lance et réessaie pendant ~8s le temps
 * qu'elle démarre — l'utilisateur n'a jamais besoin de lancer quoi que ce soit à la main.
 */
async function connectOrLaunch(): Promise<CdpTarget[] | null> {
  try {
    return await listPages()
  } catch {
    // Pas encore lancée : on la démarre puis on réessaie.
  }
  if (!launchDebugChrome()) return null
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await isPortOpen(CDP_PORT)) {
      try {
        return await listPages()
      } catch {
        // Le port répond mais /json/list pas encore prêt : on continue à réessayer.
      }
    }
  }
  return null
}

/** Une seule évaluation JS dans la page cible via CDP, avec timeout — jamais de socket qui traîne ouvert. */
function evaluateInPage<T>(webSocketDebuggerUrl: string, expression: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('CDP: timeout'))
    }, 5000)

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: T }; exceptionDetails?: unknown }
      }
      if (data.id !== 1) return
      clearTimeout(timeout)
      ws.close()
      if (data.result?.exceptionDetails) {
        reject(new Error('CDP: erreur JS dans la page'))
      } else {
        resolve(data.result?.result?.value as T)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('CDP: connexion WebSocket échouée'))
    })
  })
}

/** Onglet visible ET au premier plan en priorité, sinon le dernier onglet visible, sinon le dernier onglet. */
async function findActivePage(pages: CdpTarget[]): Promise<CdpTarget | null> {
  if (!pages.length) return null
  let lastVisible: CdpTarget | null = null
  for (const page of pages) {
    try {
      const focused = await evaluateInPage<boolean>(
        page.webSocketDebuggerUrl,
        'document.visibilityState === "visible" && document.hasFocus()'
      )
      if (focused) return page
      const visible = await evaluateInPage<boolean>(page.webSocketDebuggerUrl, 'document.visibilityState === "visible"')
      if (visible) lastVisible = page
    } catch {
      // Onglet inaccessible (en train de fermer, page interne protégée...) : on l'ignore et continue.
    }
  }
  return lastVisible ?? pages[pages.length - 1]
}

const TAB_TEXT_MAX_CHARS = 4000

const MSG_UNAVAILABLE =
  "Je n'ai pas réussi à me connecter à la fenêtre Chrome dédiée à Jaris. Vérifie que Google Chrome est " +
  "installé — Jaris essaie de la lancer automatiquement au besoin, ça peut prendre quelques secondes la " +
  'première fois.'

/**
 * Lit l'onglet actif de la fenêtre Chrome dédiée (titre, URL, texte visible) pour que le modèle de
 * conversation puisse résumer/traduire/répondre à son sujet — contrairement à look_at_screen (capture
 * d'écran + modèle de vision), c'est ici du texte brut extrait directement de la page, retourné comme un
 * résultat d'outil normal, pas une réponse déjà formulée.
 */
export async function readActiveTab(): Promise<string> {
  const pages = await connectOrLaunch()
  if (!pages) return MSG_UNAVAILABLE
  if (!pages.length) return "Aucun onglet ouvert dans la fenêtre Chrome dédiée à Jaris."

  const page = await findActivePage(pages)
  if (!page) return "Aucun onglet ouvert dans la fenêtre Chrome dédiée à Jaris."

  try {
    const text = await evaluateInPage<string>(
      page.webSocketDebuggerUrl,
      'document.body ? document.body.innerText : ""'
    )
    const truncated = text.trim().slice(0, TAB_TEXT_MAX_CHARS)
    return `Titre : ${page.title}\nURL : ${page.url}\nContenu de la page :\n${truncated}`
  } catch (err) {
    return `Impossible de lire cet onglet : ${err instanceof Error ? err.message : String(err)}`
  }
}
