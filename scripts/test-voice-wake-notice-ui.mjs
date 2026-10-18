import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 325 (bêta de l'étape 324) : sur l'écran Agent vocal, « Parler à Jaris » et le clic sur l'orbe ne faisaient
 * RIEN de visible quand l'écoute n'était pas prête — programme d'écoute qui charge encore (premier lancement :
 * téléchargement de la transcription), en échec, arrêté — ni quand le clic était désactivé dans Options → Voix.
 * L'écran dit maintenant pourquoi, juste sous le bouton, et l'efface quand ça redevient possible.
 *
 * VRAIE fenêtre (App.tsx entier) et VRAI CSS compilé (`out/`, lancer `npm run build` avant) ; le faux pont imite le
 * main : chaque essai (`triggerWake`) annonce son résultat sur `onWakeAvailability`, comme reportWakeUnavailable.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const entryPath = join(projectRoot, 'tmp-voice-wake-notice-entry.tsx')

const LOADING = "L'écoute démarre encore. Au premier lancement, Jaris télécharge la transcription (environ 2,5 Go) : réessaie dans quelques minutes."
const FAILED = "L'écoute n'a pas pu démarrer : impossible d'ouvrir le micro : Device unavailable"

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

const flags = window.__flags || {}
window.__wake = { calls: 0, reason: flags.reason ?? null, listeners: [] }
window.__emitWake = (payload) => window.__wake.listeners.forEach((listener) => listener(payload))
const known = {
  getProfile: async () => ({ name: 'Léo', capacityScanDone: true, models: {}, ...(flags.clickOff ? { activationOrbClickEnabled: false } : {}) }),
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => (flags.broken ? { ready: false, missing: ['Micro introuvable'] } : { ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getWidgetMode: async () => 'voice',
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  listConversations: async () => ({ conversations: [], activeId: null }),
  getChatHistory: async () => [],
  getGeneratedApps: async () => [],
  loadCodeConversations: () => ({ repos: [], conversations: {} }),
  listGeneratedImages: async () => [],
  listGeneratedVideos: async () => [],
  getImageStudioStatus: async () => ({ supported: true, capable: true, reason: null, installed: false, downloadLabel: '5 Go' }),
  getVideoStudioStatus: async () => ({ supported: true, capable: true, reason: null, qualities: [] }),
  getConversationHistory: async () => [],
  // Comme main.ts (triggerVisibleWake) : un essai annonce toujours son résultat, raison ou réussite.
  triggerWake: () => {
    window.__wake.calls += 1
    setTimeout(() => window.__emitWake({ reason: window.__wake.reason, attempt: true }), 10)
  },
  onWakeAvailability: (listener) => {
    window.__wake.listeners.push(listener)
    return () => { window.__wake.listeners = window.__wake.listeners.filter((entry) => entry !== listener) }
  }
}
window.jaris = new Proxy(known, {
  get(target, key) {
    if (key in target) return target[key]
    if (String(key).startsWith('on')) return () => () => {}
    return async () => null
  }
})
createRoot(document.getElementById('root')).render(<App />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-voice-wake-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      alias: { '@': join(projectRoot, 'src') },
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      outfile: bundlePath,
      logLevel: 'silent'
    })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally : une assertion qui échoue ne doit pas laisser Chromium ouvert (node --test ne finirait pas). */
async function withVoiceScreen(run, flags = {}) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    await page.setContent(html.replace('<div id="root"></div>', `<div id="root"></div><script>window.__flags = ${JSON.stringify(flags)}</script>`))
    await page.waitForSelector('.voice-screen__talk')
    await run(page)
  } finally {
    await browser.close()
  }
}

const noticeText = (page) => page.evaluate(() => document.querySelector('.voice-screen__notice')?.textContent ?? null)
const waitNotice = (page, text) =>
  page.waitForFunction((expected) => document.querySelector('.voice-screen__notice')?.textContent === expected, text, { timeout: 5000 })
const waitNoNotice = (page) => page.waitForFunction(() => !document.querySelector('.voice-screen__notice'), null, { timeout: 5000 })

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('écoute qui charge encore : « Parler à Jaris » dit pourquoi, juste sous le bouton, puis l’efface quand elle est prête', options, async () => {
  await withVoiceScreen(async (page) => {
    assert.equal(await noticeText(page), null, 'aucune raison ne doit s’afficher avant un essai')
    await page.click('.voice-screen__talk')
    await waitNotice(page, LOADING)
    assert.equal(await page.evaluate(() => window.__wake.calls), 1)

    const layout = await page.evaluate(() => {
      const button = document.querySelector('.voice-screen__talk').getBoundingClientRect()
      const notice = document.querySelector('.voice-screen__notice')
      const rect = notice.getBoundingClientRect()
      const probe = document.createElement('span')
      probe.style.color = 'var(--hud-gold)'
      document.body.appendChild(probe)
      const gold = getComputedStyle(probe).color
      probe.remove()
      const style = getComputedStyle(notice)
      return { gap: rect.top - button.bottom, fontSize: style.fontSize, color: style.color, gold, role: notice.getAttribute('role'), overflow: document.documentElement.scrollWidth - innerWidth }
    })
    assert.ok(layout.gap >= 0 && layout.gap < 40, `la raison doit être juste sous le bouton (écart de ${layout.gap} px)`)
    assert.equal(layout.fontSize, '13px', 'la raison n’est pas habillée par le CSS de Jaris')
    assert.equal(layout.color, layout.gold, 'la raison doit se distinguer de l’astuce grise (couleur d’avertissement)')
    assert.equal(layout.role, 'status', 'un lecteur d’écran doit annoncer la raison')
    assert.ok(layout.overflow <= 0, 'la raison fait déborder la fenêtre')

    // L'écoute devient prête (état relayé par le main, sans nouvel essai) : la raison disparaît d'elle-même.
    await page.evaluate(() => window.__emitWake({ reason: null, attempt: false }))
    await waitNoNotice(page)
  }, { reason: LOADING })
})

test('un changement d’état seul ne fait jamais apparaître de raison, mais met à jour celle déjà affichée', options, async () => {
  await withVoiceScreen(async (page) => {
    await page.evaluate((reason) => window.__emitWake({ reason, attempt: false }), LOADING)
    await page.waitForTimeout(250)
    assert.equal(await noticeText(page), null, 'une raison est apparue sans que Léo ait essayé')

    await page.click('.voice-screen__talk')
    await waitNotice(page, LOADING)
    // Le chargement échoue : la raison affichée suit l'état réel, avec le vrai message.
    await page.evaluate((reason) => window.__emitWake({ reason, attempt: false }), FAILED)
    await waitNotice(page, FAILED)

    // Un essai réussi efface la raison.
    await page.evaluate(() => { window.__wake.reason = null })
    await page.click('.voice-screen__talk')
    await waitNoNotice(page)
  }, { reason: LOADING })
})

test('clic désactivé dans Options → Voix : le bouton et l’orbe disent où le réactiver au lieu de ne rien faire', options, async () => {
  await withVoiceScreen(async (page) => {
    const expected = 'Le clic pour parler est désactivé : réactive « Clic sur le cercle de Jaris » dans Options → Voix.'
    const leaveAndComeBack = async () => {
      await page.click('.rail__item:has-text("Chat")')
      await page.click('.rail__item:has-text("Vocal")')
      await page.waitForSelector('.voice-screen__talk')
    }
    await page.click('.voice-screen__stage .jaris-orb')
    await waitNotice(page, expected)

    // Quitter l'écran vocal (par exemple pour réactiver le clic dans Options) l'oublie : pas de raison périmée au retour.
    await leaveAndComeBack()
    assert.equal(await noticeText(page), null, 'une raison périmée reste affichée au retour sur l’écran vocal')

    await page.click('.voice-screen__talk')
    await waitNotice(page, expected)
    assert.equal(await page.evaluate(() => window.__wake.calls), 0, 'le clic désactivé ne doit toujours rien déclencher')

    // L'écoute qui devient prête n'efface pas cette raison-là : elle ne dépend pas de l'écoute.
    await page.evaluate(() => window.__emitWake({ reason: null, attempt: false }))
    await page.waitForTimeout(250)
    assert.equal(await noticeText(page), expected)
  }, { clickOff: true })
})

test('la voix en panne déjà expliquée plus bas : la même raison n’est pas répétée sous le bouton', options, async () => {
  await withVoiceScreen(async (page) => {
    await page.waitForSelector('.app__setup-warning')
    await page.click('.voice-screen__talk')
    await page.waitForFunction(() => window.__wake.calls === 1)
    await page.waitForTimeout(250)
    assert.equal(await noticeText(page), null, 'deux cadres disent la même chose')
    assert.match(await page.textContent('.app__setup-warning'), /Micro introuvable/)
  }, { reason: FAILED, broken: true })
})
