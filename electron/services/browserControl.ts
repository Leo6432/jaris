import { spawn } from 'child_process'
import { connect } from 'net'
import { existsSync } from 'fs'
import { join } from 'path'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { describeBrowserScreenshot } from './vision'

/**
 * Depuis Chrome 136+, Google interdit la connexion CDP (Chrome DevTools Protocol, nécessaire pour piloter
 * un onglet depuis l'extérieur) sur le profil par défaut, pour des raisons de sécurité. La seule solution
 * qui marche encore (vérifiée sur jarvis-assistant-vocal, projet comparable) : un Chrome séparé, lancé
 * avec `--remote-debugging-port` ET un profil dédié (`--user-data-dir`) — jamais le profil de tous les
 * jours de l'utilisateur. Conséquence assumée : Jaris ne peut piloter que les onglets ouverts dans CETTE
 * fenêtre dédiée, auto-lancée au besoin, pas le Chrome habituel de l'utilisateur.
 *
 * Playwright (`playwright-core`, sans navigateur embarqué — on réutilise le Chrome déjà installé sur la
 * machine, jamais un téléchargement séparé) remplace ici les appels CDP faits à la main (WebSocket brut)
 * de la première version de ce fichier : les nouvelles capacités (étape 34 du roadmap — naviguer, cliquer,
 * remplir un formulaire, capturer un onglet) demandent bien plus que de simples `Runtime.evaluate`, et
 * Playwright gère déjà l'attente d'éléments, les sélecteurs par rôle/texte/label, et les captures d'écran
 * de façon robuste plutôt que de tout réinventer à la main.
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
  proc.on('error', () => {
    // Rien à faire : connectOrLaunch ci-dessous retente la connexion pendant ~8s puis abandonne
    // proprement (MSG_UNAVAILABLE) si Chrome n'a jamais fini par répondre.
  })
  proc.unref()
  return true
}

/** Un seul Browser Playwright réutilisé tant qu'il reste connecté, jamais reconnecté à chaque appel d'outil. */
let cachedBrowser: Browser | null = null

/**
 * Se connecte à la fenêtre Chrome dédiée déjà lancée, sinon la lance et réessaie pendant ~8s le temps
 * qu'elle démarre — l'utilisateur n'a jamais besoin de lancer quoi que ce soit à la main.
 */
async function connectOrLaunch(): Promise<Browser | null> {
  if (cachedBrowser?.isConnected()) return cachedBrowser
  cachedBrowser = null

  try {
    cachedBrowser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`, { timeout: 3000 })
    return cachedBrowser
  } catch {
    // Pas encore lancée : on la démarre puis on réessaie.
  }
  if (!launchDebugChrome()) return null
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await isPortOpen(CDP_PORT)) {
      try {
        cachedBrowser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`, { timeout: 3000 })
        return cachedBrowser
      } catch {
        // Le port répond mais le endpoint CDP pas encore prêt : on continue à réessayer.
      }
    }
  }
  return null
}

/** Onglet visible ET au premier plan en priorité, sinon le dernier onglet visible, sinon le dernier onglet. */
async function findActivePage(browser: Browser): Promise<Page | null> {
  const pages = browser.contexts().flatMap((ctx) => ctx.pages())
  if (!pages.length) return null
  let lastVisible: Page | null = null
  for (const page of pages) {
    try {
      const focused = await page.evaluate('document.visibilityState === "visible" && document.hasFocus()')
      if (focused) return page
      const visible = await page.evaluate('document.visibilityState === "visible"')
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

const MSG_NO_TAB = "Aucun onglet ouvert dans la fenêtre Chrome dédiée à Jaris."

/**
 * Lit l'onglet actif de la fenêtre Chrome dédiée (titre, URL, texte visible) pour que le modèle de
 * conversation puisse résumer/traduire/répondre à son sujet — contrairement à look_at_screen (capture
 * d'écran + modèle de vision), c'est ici du texte brut extrait directement de la page, retourné comme un
 * résultat d'outil normal, pas une réponse déjà formulée.
 */
export async function readActiveTab(): Promise<string> {
  const browser = await connectOrLaunch()
  if (!browser) return MSG_UNAVAILABLE
  const page = await findActivePage(browser)
  if (!page) return MSG_NO_TAB

  try {
    const title = await page.title()
    const text = (await page.locator('body').innerText().catch(() => '')).trim()
    return `Titre : ${title}\nURL : ${page.url()}\nContenu de la page :\n${text.slice(0, TAB_TEXT_MAX_CHARS)}`
  } catch (err) {
    return `Impossible de lire cet onglet : ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Ouvre une URL (ou une recherche Google si ce n'en est pas une) dans un nouvel onglet de la fenêtre
 * dédiée. `target` vient directement du modèle : jamais interpolé dans une commande shell, juste passé à
 * `page.goto` (Playwright échappe déjà correctement une URL invalide en levant une erreur, pas en
 * l'exécutant).
 */
export async function openBrowserUrl(target: string): Promise<string> {
  const browser = await connectOrLaunch()
  if (!browser) return MSG_UNAVAILABLE

  const trimmed = target.trim()
  if (!trimmed) return "Dis-moi quelle adresse ouvrir, ou quoi chercher."
  const url = trimmed.includes('://')
    ? trimmed
    : trimmed.includes('.') && !trimmed.includes(' ')
      ? `https://${trimmed}`
      : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.bringToFront()
    return `J'ai ouvert ${(await page.title()) || url}.`
  } catch (err) {
    return `Je n'ai pas pu ouvrir ça : ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Essaie plusieurs stratégies de repérage Playwright dans l'ordre (rôle bouton/lien, puis texte brut) pour
 * un élément décrit en langage naturel par le modèle — jamais de sélecteur CSS/XPath à deviner, ce que
 * l'utilisateur dicte est toujours du texte visible ("le bouton Suivant", "Connexion"...). `.first()` évite
 * une erreur "strict mode" si plusieurs éléments correspondent : mieux vaut cliquer le premier trouvé que
 * refuser d'agir sur une description ambiguë.
 */
function locateClickable(page: Page, description: string): Locator[] {
  return [
    page.getByRole('button', { name: description, exact: false }).first(),
    page.getByRole('link', { name: description, exact: false }).first(),
    page.getByText(description, { exact: false }).first()
  ]
}

function locateFillable(page: Page, description: string): Locator[] {
  return [
    page.getByLabel(description, { exact: false }).first(),
    page.getByPlaceholder(description, { exact: false }).first(),
    page.getByRole('textbox', { name: description, exact: false }).first()
  ]
}

/** Le premier candidat qui a au moins une correspondance réelle sur la page, sinon `null`. */
async function firstMatch(candidates: Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) > 0) return candidate
  }
  return null
}

/** Clique sur un élément de l'onglet actif décrit en langage naturel (nom du bouton/lien, texte visible...). */
export async function clickBrowserElement(description: string): Promise<string> {
  const browser = await connectOrLaunch()
  if (!browser) return MSG_UNAVAILABLE
  const page = await findActivePage(browser)
  if (!page) return MSG_NO_TAB

  try {
    const locator = await firstMatch(locateClickable(page, description))
    if (!locator) return `Je n'ai trouvé aucun élément correspondant à "${description}" sur cette page.`
    await locator.click({ timeout: 5000 })
    return `J'ai cliqué sur "${description}".`
  } catch (err) {
    return `Je n'ai pas pu cliquer sur "${description}" : ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Remplit un champ de formulaire de l'onglet actif décrit en langage naturel (son label, placeholder...). */
export async function fillBrowserField(fieldDescription: string, text: string): Promise<string> {
  const browser = await connectOrLaunch()
  if (!browser) return MSG_UNAVAILABLE
  const page = await findActivePage(browser)
  if (!page) return MSG_NO_TAB

  try {
    const locator = await firstMatch(locateFillable(page, fieldDescription))
    if (!locator) return `Je n'ai trouvé aucun champ correspondant à "${fieldDescription}" sur cette page.`
    await locator.fill(text, { timeout: 5000 })
    return `J'ai rempli "${fieldDescription}".`
  } catch (err) {
    return `Je n'ai pas pu remplir "${fieldDescription}" : ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Capture l'onglet actif et demande au modèle de vision de le décrire/répondre à une question dessus —
 * même modèle de vision et même logique de repli VRAM que look_at_screen (vision.ts), juste une image
 * différente (l'onglet, pas l'écran entier) : utile pour un contenu qu'un simple texte brut (readActiveTab)
 * ne suffit pas à décrire (mise en page, graphique, image).
 */
export async function screenshotActiveTab(question: string, visionModel: string): Promise<string> {
  const browser = await connectOrLaunch()
  if (!browser) return MSG_UNAVAILABLE
  const page = await findActivePage(browser)
  if (!page) return MSG_NO_TAB

  try {
    const buffer = await page.screenshot({ type: 'png', timeout: 10000 })
    return await describeBrowserScreenshot(buffer.toString('base64'), question, visionModel)
  } catch (err) {
    return `Impossible de capturer cet onglet : ${err instanceof Error ? err.message : String(err)}`
  }
}
