import type { WebSource } from '../../shared/ipc'
import { currentLocale, t } from '../../shared/i18n'

/**
 * Étape 337 : la recherche web sans Docker. Jaris ouvre la page de résultats d'un moteur dans une fenêtre CACHÉE de son
 * propre navigateur (Chromium, déjà dans Jaris : rien à installer) et y lit les résultats, comme le ferait une personne.
 *
 * Avant, la recherche passait par SearXNG, qui tournait dans Docker Desktop : WSL, autorisation de Windows, redémarrage,
 * 600 Mo à installer, et la longue série des erreurs 403. SearXNG ne faisait lui-même qu'interroger ces moteurs depuis
 * le PC : rien ne change pour la confidentialité.
 *
 * Pourquoi un vrai navigateur, et pas une simple requête : mesuré depuis un serveur le 21/10/2026, une requête brute
 * reçoit une vérification anti-robot de DuckDuckGo, un refus de Mojeek et des résultats sans rapport de Bing ; le même
 * DuckDuckGo ouvert dans un vrai Chromium a réussi 25 recherches d'affilée, Startpage aussi. Une page qui exécute ses
 * scripts et garde ses cookies ressemble à une personne, pas à un robot.
 *
 * DuckDuckGo d'abord, Startpage (les résultats de Google, sans pistage) s'il ne donne rien. Brave, Google et Mojeek
 * bloquaient le serveur de mesure : écartés.
 */

export interface SearchEngine {
  name: string
  /** Domaine du moteur : ses propres liens (publicités, redirections) ne sont jamais rendus comme résultats. */
  domain: string
  searchUrl: (query: string) => string
  /** Un résultat, puis son titre, son lien et son extrait, à l'intérieur de ce résultat. */
  item: string
  title: string
  link: string
  snippet: string
}

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    name: 'DuckDuckGo',
    domain: 'duckduckgo.com',
    searchUrl: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    item: 'article[data-testid=result]',
    title: 'a[data-testid=result-title-a]',
    link: 'a[data-testid=result-title-a]',
    snippet: '[data-result=snippet]'
  },
  {
    name: 'Startpage',
    domain: 'startpage.com',
    searchUrl: (query) => `https://www.startpage.com/do/search?q=${encodeURIComponent(query)}`,
    item: 'div.result',
    title: 'h2',
    link: 'a.result-title',
    snippet: 'p.description'
  }
]

export interface RawResult {
  title?: string | null
  url?: string | null
  content?: string | null
}

/** Ce qu'une page de résultats a donné : ses résultats, et le début de son texte (pour reconnaître un blocage). */
export interface EnginePage {
  results: RawResult[]
  bodyText: string
}

/** Ouvre la page de recherche d'un moteur et en lit les résultats. Remplacé dans les tests. */
export type EngineLoader = (engine: SearchEngine, url: string) => Promise<EnginePage>

const MAX_RESULTS = 5

/** Une vérification anti-robot, dans les langues où les moteurs l'affichent. */
const BLOCKED_PAGE = /captcha|robot|anomal|unusual traffic|trafic exceptionnel|automated (?:queries|requests)|requêtes automatisées/i

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

function belongsTo(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Les résultats gardés : adresse web, pas un lien du moteur lui-même (publicité, redirection), chaque adresse une
 * fois, les 5 premiers.
 */
export function cleanResults(raw: RawResult[], engine: SearchEngine): { title: string; url: string; content: string }[] {
  const seen = new Set<string>()
  const kept: { title: string; url: string; content: string }[] = []
  for (const item of raw) {
    const url = clean(item.url)
    const host = hostOf(url)
    if (!host || belongsTo(host, engine.domain) || seen.has(url)) continue
    seen.add(url)
    kept.push({ title: clean(item.title) || url, url, content: clean(item.content) })
    if (kept.length === MAX_RESULTS) break
  }
  return kept
}

/** Pourquoi un moteur n'a rien donné, en une phrase pour Léo. */
function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i.test(message)) {
    return t('search.reason.offline')
  }
  if (/timeout|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i.test(message)) return t('search.reason.timeout')
  return t('search.reason.other', { message: message.slice(0, 160) })
}

/**
 * Cherche sur le web : un résumé des meilleurs résultats pour le modèle, et les pages trouvées pour les montrer dans
 * le Chat (étape 273).
 */
export async function searchWebDetailed(
  query: string,
  loader: EngineLoader = loadInHiddenWindow
): Promise<{ text: string; sources: WebSource[] }> {
  const failures: string[] = []
  let answered = false
  for (const engine of SEARCH_ENGINES) {
    let page: EnginePage
    try {
      page = await loader(engine, engine.searchUrl(query))
    } catch (err) {
      failures.push(t('common.labelValue', { label: engine.name, value: failureReason(err) }))
      continue
    }
    const results = cleanResults(page.results, engine)
    if (results.length) {
      return {
        text: results.map((r, i) => `${i + 1}. ${r.title} — ${r.content} (${r.url})`).join('\n'),
        sources: results.map((r) => ({ title: r.title, url: r.url }))
      }
    }
    if (BLOCKED_PAGE.test(page.bodyText)) {
      failures.push(t('common.labelValue', { label: engine.name, value: t('search.reason.blocked') }))
    } else {
      // La page a bien répondu, sans résultat : on demande quand même à l'autre moteur, mais ce n'est pas une panne.
      answered = true
    }
  }
  if (answered) return { text: t('search.noResult', { query }), sources: [] }
  throw new Error(t('search.failed', { reasons: failures.join(' · ') }))
}

// ————— La fenêtre cachée —————

/** Partition à part : ses cookies (ceux d'une personne qui revient) ne se mélangent jamais à ceux de Jaris. */
export const SEARCH_PARTITION = 'persist:jaris-websearch'
/** Temps maximal pour une page de résultats, chargement compris. */
const PAGE_TIMEOUT_MS = 20_000
const POLL_MS = 250

// Les pages de recherche ouvertes par Jaris : main.ts les laisse suivre leurs propres redirections (sa règle « une
// fenêtre ne quitte jamais sa page » vaut pour les fenêtres de Jaris, pas pour celles-ci).
const searchContentsIds = new Set<number>()

export function isSearchContents(id: number): boolean {
  return searchContentsIds.has(id)
}

/** Le script lu dans la page : uniquement des sélecteurs, jamais un texte venu de la recherche. */
export function extractionScript(engine: SearchEngine): string {
  const selectors = JSON.stringify({ item: engine.item, title: engine.title, link: engine.link, snippet: engine.snippet })
  return `(() => {
    const s = ${selectors};
    const results = [...document.querySelectorAll(s.item)].map((el) => {
      const title = el.querySelector(s.title);
      const link = el.querySelector(s.link);
      const snippet = el.querySelector(s.snippet);
      return { title: title ? title.innerText : null, url: link ? link.href : null, content: snippet ? snippet.innerText : null };
    });
    return { results, bodyText: document.body ? document.body.innerText.slice(0, 600) : '' };
  })()`
}

let sessionReady = false
// Une recherche à la fois : deux fenêtres cachées en même temps se disputeraient la mémoire pour rien.
let queue: Promise<unknown> = Promise.resolve()

async function prepareSession(): Promise<Electron.Session> {
  const { session } = await import('electron')
  const ses = session.fromPartition(SEARCH_PARTITION)
  if (!sessionReady) {
    sessionReady = true
    // L'agent d'un Chrome ordinaire : celui d'Electron (« Electron/… ») ne ressemble à aucun navigateur réel.
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
    const locale = currentLocale()
    const language = locale.split('-')[0]
    ses.setUserAgent(userAgent, language === locale ? locale : `${locale},${language}`)
    // Une page de recherche n'a besoin de rien : ni micro, ni position, ni notifications.
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
  }
  return ses
}

export function loadInHiddenWindow(engine: SearchEngine, url: string): Promise<EnginePage> {
  const run = queue.then(() => loadNow(engine, url))
  queue = run.catch(() => undefined)
  return run
}

async function loadNow(engine: SearchEngine, url: string): Promise<EnginePage> {
  const { BrowserWindow } = await import('electron')
  const ses = await prepareSession()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const contents = win.webContents
  searchContentsIds.add(contents.id)
  contents.setAudioMuted(true)
  // Rester chez le moteur : une page qui voudrait partir ailleurs (publicité, autre site) est arrêtée.
  contents.on('will-navigate', (event, next) => {
    const host = hostOf(next)
    if (!host || !belongsTo(host, engine.domain)) event.preventDefault()
  })
  const script = extractionScript(engine)
  const started = Date.now()
  const deadline = started + PAGE_TIMEOUT_MS
  try {
    let loadError: Error | null = null
    const loading = win.loadURL(url).catch((err: Error) => {
      // Une page qui se remplace elle-même pendant le chargement (redirection) n'est pas un échec.
      if (!/ERR_ABORTED/.test(err.message)) loadError = err
    })
    await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, PAGE_TIMEOUT_MS))])
    let last: EnginePage = { results: [], bodyText: '' }
    while (Date.now() < deadline) {
      if (loadError) throw loadError
      if (win.isDestroyed()) throw new Error('window closed')
      try {
        last = (await contents.executeJavaScript(script, true)) as EnginePage
      } catch {
        // Page encore en train de se charger : on relit un peu plus tard.
      }
      if (last.results.length || BLOCKED_PAGE.test(last.bodyText)) return last
      // Une page complètement chargée sans résultat après un court moment : « aucun résultat », pas la peine d'attendre.
      if (!contents.isLoading() && last.bodyText && Date.now() - started > 6000) return last
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    if (loadError) throw loadError
    if (!last.bodyText) throw new Error('timeout')
    return last
  } finally {
    searchContentsIds.delete(contents.id)
    if (!win.isDestroyed()) win.destroy()
  }
}
