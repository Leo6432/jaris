import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 527, côté écran : la question des rapports d'erreurs est posée UNE fois — case de l'écran de bienvenue (décochée
 * par défaut) pour une nouvelle installation, petite carte pour une installation déjà faite — et se change dans
 * Options → Général. Vrai App.tsx et vrai OptionsMenu avec le CSS compilé (`npm run build` avant ce test).
 * JARIS_SHOTS=<dossier> : enregistre aussi les captures montrées à Léo.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-error-reports-entry.tsx')
const shots = process.env.JARIS_SHOTS || ''

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'
import OptionsMenu from './src/components/OptionsMenu'

const entry = { model: 'qwen3.5:4b', vramGb: 3.4, usedIn: [], toolCalling: '6/6', intelligence: null }
window.__reports = []
const known = {
  getProfile: async () => (window.__noProfile ? null : { name: 'Léo', capacityScanDone: true, models: {} }),
  saveProfile: async () => {},
  getErrorReports: async () => window.__reportsState,
  setErrorReports: async (enabled) => {
    window.__reports.push(enabled)
    window.__reportsState = { asked: true, enabled }
    return window.__reportsState
  },
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getWidgetMode: async () => 'voice',
  getNewModels: async () => [],
  getAppVersion: async () => '0.79.0',
  getMyModelPicks: async () => ({ gpuName: 'RTX 3070', vramGb: 8, ramGb: 32, flash: entry, medium: entry, large: entry, vision: entry, code: entry, upgrades: {}, installCheck: null }),
  getMemoryGraph: async () => ({ nodes: [{ id: 'Léo', isCenter: true }], links: [] }),
  listConversations: async () => ({ conversations: [], activeId: null }),
  getChatHistory: async () => [],
  getGeneratedApps: async () => [],
  listGeneratedImages: async () => [],
  listGeneratedVideos: async () => [],
  getConversationHistory: async () => []
}
window.jaris = new Proxy(known, {
  get(target, key) {
    if (key in target) return target[key]
    if (String(key).startsWith('on')) return () => () => {}
    return async () => null
  }
})
createRoot(document.getElementById('root')).render(window.__options ? <OptionsMenu /> : <App />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-error-reports-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'silent' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(init, width, run) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ deviceScaleFactor: shots ? 2 : 1 })
    await page.setViewportSize({ width, height: 760 })
    await page.setContent(buildPage().replace('<body>', `<body><script>${init}</script>`))
    await run(page)
  } finally {
    await browser.close()
  }
}

async function shot(page, name) {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, name) })
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

for (const width of [760, 1280]) {
  test(`étape 527 : écran de bienvenue (${width} px) — case décochée par défaut, la réponse est notée dans les deux cas`, options, async () => {
    for (const check of [false, true]) {
      await withPage("window.__noProfile = true; window.__reportsState = { asked: false, enabled: false }", width, async (page) => {
        const box = page.locator('.app__onboarding-reports input[type="checkbox"]')
        await box.waitFor()
        assert.equal(await box.isChecked(), false, 'jamais coché d’office')
        assert.match(await page.locator('.app__onboarding-reports').innerText(), /rapports d'erreurs anonymes[\s\S]*Politique de confidentialité/)
        const href = await page.locator('.app__onboarding-reports a').getAttribute('href')
        assert.match(href ?? '', /docs\/confidentialite\.md$/)
        // La case ne prend pas le style des champs texte (règle générale des input).
        const size = await box.evaluate((el) => el.getBoundingClientRect().width)
        assert.ok(size < 30, `case de ${size} px`)
        const rect = await page.locator('.app__onboarding-reports').evaluate((el) => {
          const r = el.getBoundingClientRect()
          return { left: r.left, right: r.right, bottom: r.bottom }
        })
        assert.ok(rect.left >= 0 && rect.right <= width && rect.bottom <= 760, `case visible : ${JSON.stringify(rect)}`)
        if (check) await box.check()
        else await shot(page, `bienvenue-${width}.png`)
        await page.fill('.app__onboarding input:not([type="checkbox"])', 'Léo')
        await page.click('.app__onboarding button[type="submit"]')
        await page.waitForFunction(() => window.__reports.length === 1)
        assert.equal(await page.evaluate(() => window.__reports[0]), check)
      })
    }
  })

  test(`étape 527 : installation déjà faite (${width} px) — la carte pose la question une fois, puis disparaît`, options, async () => {
    await withPage("window.__reportsState = { asked: false, enabled: false }", width, async (page) => {
      const card = page.locator('.error-reports-prompt')
      await card.waitFor()
      assert.equal(await page.locator('.error-reports-prompt__title').innerText(), 'Aider à améliorer Jaris ?')
      const rect = await card.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      })
      assert.ok(rect.left >= 0 && rect.right <= width && rect.bottom <= 760, `carte visible : ${JSON.stringify(rect)}`)
      await shot(page, `carte-${width}.png`)
      await page.getByRole('button', { name: 'Oui, envoyer' }).click()
      await card.waitFor({ state: 'detached' })
      assert.equal(JSON.stringify(await page.evaluate(() => window.__reports)), '[true]')
    })
    // Déjà répondu, ou état illisible : jamais de carte.
    for (const state of ['{ asked: true, enabled: false }', 'null']) {
      await withPage(`window.__reportsState = ${state}`, width, async (page) => {
        await page.waitForSelector('.app')
        await page.waitForTimeout(300)
        assert.equal(await page.locator('.error-reports-prompt').count(), 0, state)
      })
    }
  })
}

test('étape 527 : Options → Général — l’interrupteur montre le vrai choix et le change', options, async () => {
  await withPage("window.__options = true; window.__reportsState = { asked: true, enabled: false }", 1280, async (page) => {
    await page.click('.options-menu__trigger')
    await page.click('.options-menu__tab:has-text("Général")')
    const group = page.locator('.options-menu__group').filter({ has: page.locator('.options-menu__section-title', { hasText: "Rapports d'erreurs" }) })
    await group.waitFor()
    const toggle = group.getByRole('switch', { name: "Envoyer des rapports d'erreurs anonymes" })
    await page.waitForFunction(() => !document.querySelector('.options-menu__group [aria-label^="Envoyer des rapports"]')?.disabled)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'montre le vrai choix (non)')
    await group.scrollIntoViewIfNeeded()
    await shot(page, 'options-1280.png')
    await toggle.click()
    await page.waitForFunction(() => window.__reports.length === 1)
    assert.equal(await page.evaluate(() => window.__reports[0]), true)
    await page.waitForFunction(() => document.querySelector('[aria-label^="Envoyer des rapports"]')?.getAttribute('aria-checked') === 'true')
  })
})
