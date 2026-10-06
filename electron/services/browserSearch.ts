import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { shell } from 'electron'

/**
 * Étape 248 (Léo, journal des demandes : « ouvre Firefox et cherche une recette de tiramisu » à la voix) : le
 * modèle réfléchissait jusqu'à 2 minutes avant d'ouvrir Firefox, puis le pilotage d'écran cliquait dans la barre
 * des tâches, tapait au mauvais endroit, fermait Firefox… sans jamais afficher la recherche. Pour cette demande
 * explicite, Jaris ouvre DIRECTEMENT la page de résultats dans le navigateur — une adresse, aucun clic deviné.
 */

export interface BrowserChoice {
  /** Nom affiché : « Firefox ». */
  name: string
  /** Exécutable cherché dans « App Paths » de Windows. */
  exe: string
}

export interface BrowserSearchRequest {
  query: string
  site: 'web' | 'youtube'
  /** Absent : le navigateur par défaut de Windows. */
  browser?: BrowserChoice
}

const BROWSERS: Array<[RegExp, BrowserChoice]> = [
  [/firefox/i, { name: 'Firefox', exe: 'firefox.exe' }],
  [/chrome/i, { name: 'Chrome', exe: 'chrome.exe' }],
  [/edge/i, { name: 'Edge', exe: 'msedge.exe' }],
  [/brave/i, { name: 'Brave', exe: 'brave.exe' }],
  [/opera/i, { name: 'Opera', exe: 'opera.exe' }]
]

const TARGET = String.raw`mozilla\s+firefox|firefox|google\s+chrome|chrome|microsoft\s+edge|edge|brave|opera|internet|(?:le\s+|mon\s+)?navigateur(?:\s+internet)?|google|youtube`
const REQUEST = new RegExp(
  String.raw`^(?:ouvre|lance|démarre|demarre|vas?)(?:[-\s]moi)?\s+(?:sur\s+)?(?:(?:le|mon)\s+navigateur\s+)?(?<target>${TARGET})\s*,?\s+(?:et|puis)\s+` +
    String.raw`(?:fais(?:[-\s]moi)?\s+une\s+recherche\s+(?:de|sur|pour)\s+|(?:re)?cherche(?:[-\s]moi)?\s+|tape\s+|trouve(?:[-\s]moi)?\s+)(?<query>.+?)[\s.!?…]*$`,
  'iu'
)
// Une suite d'actions (« … et clique sur la première vidéo ») reste au modèle.
const MORE_ACTIONS = /\b(?:puis|ensuite|après)\b|\bet\s+(?:clique|ouvre|lance|joue|mets?|regarde|lis|lit|envoie|écris|ecris|télécharge|telecharge|enregistre|copie)\b/iu

/** Commande explicite « ouvre <navigateur/Google/YouTube> et cherche <X> » — sinon `undefined`, le modèle décide. */
export function directBrowserSearch(prompt: string): BrowserSearchRequest | undefined {
  const text = prompt.trim().replace(/\s+/g, ' ')
  const match = text.match(REQUEST)
  // Une négation (« ne lance pas… ») ne peut pas correspondre : la phrase doit COMMENCER par le verbe d'ouverture,
  // et « cherche » suivre directement « et ». Un « pas » dans la recherche (« recette pas chère ») reste permis.
  if (!match?.groups) return undefined
  let query = match.groups.query
  if (MORE_ACTIONS.test(query)) return undefined
  query = query
    .replace(/^(?:sur|dans)\s+(?:internet|google|youtube|le\s+navigateur)\s+/iu, '')
    .replace(/\s+(?:sur|dans)\s+(?:internet|google|youtube|le\s+navigateur)$/iu, '')
    .replace(/^(?:(?:une|un|des|du|de\s+la|les|la|le)\s+|(?:de\s+)?l['’]\s*)/iu, '')
    .replace(/^["«“\s]+|["»”\s]+$/gu, '')
    .trim()
  if (!query || query.length > 150) return undefined
  const target = match.groups.target
  const browser = BROWSERS.find(([pattern]) => pattern.test(target))?.[1]
  return { query, site: /youtube/i.test(target) ? 'youtube' : 'web', browser }
}

export function searchUrl(request: Pick<BrowserSearchRequest, 'query' | 'site'>): string {
  const q = encodeURIComponent(request.query)
  return request.site === 'youtube' ? `https://www.youtube.com/results?search_query=${q}` : `https://www.google.com/search?q=${q}`
}

const execFileAsync = promisify(execFile)

/** Chemin de l'exécutable d'après « App Paths » (HKCU puis HKLM), ou `null`. Aucune donnée de l'utilisateur dans la commande. */
export async function findBrowserExe(exe: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { windowsHide: true })
      const path = parseRegDefault(stdout)
      if (path && existsSync(path)) return path
    } catch {
      // Clé absente : on essaie la suivante.
    }
  }
  return null
}

/** Valeur par défaut d'une sortie `reg query /ve` (« (Default) » ou « (par défaut) » selon la langue de Windows). */
export function parseRegDefault(stdout: string): string | null {
  const value = stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)?.[1]
  return value ? value.replace(/^"|"$/g, '').trim() || null : null
}

/** Lance l'exécutable avec l'adresse en ARGUMENT (jamais dans une ligne de commande interprétée). */
function launchDetached(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { stdio: 'ignore', detached: true })
    proc.on('error', (err) => resolve(err.message))
    proc.on('spawn', () => {
      proc.unref()
      resolve(null)
    })
  })
}

export interface BrowserSearchDeps {
  findExe: (exe: string) => Promise<string | null>
  launch: (exe: string, args: string[]) => Promise<string | null>
  openExternal: (url: string) => Promise<void>
}

const defaultDeps: BrowserSearchDeps = { findExe: findBrowserExe, launch: launchDetached, openExternal: (url) => shell.openExternal(url) }

/**
 * Ouvre la recherche et dit honnêtement ce qui a été fait : la demande est TRANSMISE au navigateur — ni Windows ni
 * le navigateur ne confirment qu'une fenêtre est affichée (même limite que open_app).
 */
export async function openBrowserSearch(request: BrowserSearchRequest, deps: BrowserSearchDeps = defaultDeps): Promise<string> {
  const url = searchUrl(request)
  const what = `${request.site === 'youtube' ? 'Recherche YouTube' : 'Recherche'} « ${request.query} »`
  let missing = ''
  if (request.browser) {
    const exe = await deps.findExe(request.browser.exe)
    if (exe) {
      const error = await deps.launch(exe, [url])
      if (!error) return `${what} envoyée à ${request.browser.name}.`
      missing = `${request.browser.name} n'a pas pu être lancé (${error}) : `
    } else {
      missing = `${request.browser.name} introuvable sur ce PC : `
    }
  }
  try {
    await deps.openExternal(url)
  } catch (err) {
    return `Échec de l'ouverture du navigateur : ${err instanceof Error ? err.message : String(err)}`
  }
  return `${missing}${missing ? what.charAt(0).toLowerCase() + what.slice(1) : what} envoyée à ton navigateur par défaut.`
}
