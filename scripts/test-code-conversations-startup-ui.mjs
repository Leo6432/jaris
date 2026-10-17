import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Reprise des conversations du mode Code gardées par l'ancienne version dans le stockage de la fenêtre (localStorage,
 * dans le dossier de Chromium qu'un « Déplacer » efface). La VRAIE fenêtre de Jaris (App.tsx entier), servie sur une
 * vraie origine pour que ce stockage existe.
 *
 * Défaut couvert (relecture du correctif) : la reprise n'avait lieu qu'à la première visite de l'écran Code. Jaris
 * s'ouvre sur l'Agent vocal : mettre à jour puis faire « Déplacer » sans passer par Code effaçait l'ancien dossier de
 * Chromium au redémarrage, avec ces conversations jamais reprises — exactement le bug d'origine.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-code-conversations-startup-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

const calls = (window.__calls = { load: 0, imports: [], order: [] })
const known = {
  getProfile: async () => ({ name: 'Léo', capacityScanDone: true, models: {} }),
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getWidgetMode: async () => 'voice',
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  listConversations: async () => ({ conversations: [], activeId: null }),
  getChatHistory: async () => [],
  getGeneratedApps: async () => [],
  getConversationHistory: async () => [],
  getModelsLocationStatus: async () => ({ items: [] }),
  // Lu de façon SYNCHRONE par l'écran Code : compté, pour prouver que cet écran n'a jamais été ouvert.
  loadCodeConversations: () => {
    calls.load++
    return { repos: [], conversations: {} }
  },
  importCodeConversations: (data) => {
    calls.imports.push(data)
    calls.order.push('import')
    return window.__importFails ? Promise.reject(new Error('disque plein')) : Promise.resolve()
  },
  chooseModelsLocation: async () => {
    calls.order.push('choose')
    return { success: false, message: '' }
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
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-code-startup-'))
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

const LEGACY = {
  'jaris.codeRepos': JSON.stringify([{ fullName: 'leo/projet', at: 5 }]),
  'jaris.codeConversation.app:C:/apps/snake': JSON.stringify([
    { id: 1, kind: 'user', text: 'un snake' },
    { id: 2, kind: 'reply', text: 'Fait.' }
  ]),
  'jaris.codeChatWidth': '420'
}

/** Page servie sur une vraie origine, avec l'ancien stockage déjà là AVANT le premier script (comme après la mise à jour). */
async function withPage(run, { importFails = false } = {}) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 } })
    await page.addInitScript(
      ({ legacy, fails }) => {
        for (const [key, value] of Object.entries(legacy)) localStorage.setItem(key, value)
        window.__importFails = fails
      },
      { legacy: LEGACY, fails: importFails }
    )
    await page.route('http://jaris.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://jaris.test/')
    await page.waitForSelector('.rail__item')
    await run(page)
  } finally {
    await browser.close()
  }
}

const legacyKeys = (page) =>
  page.evaluate(() => Object.keys(localStorage).filter((key) => key === 'jaris.codeRepos' || key.startsWith('jaris.codeConversation.')))

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('reprise dès l’ouverture de Jaris, sur l’Agent vocal, sans jamais ouvrir l’écran Code', options, async () => {
  await withPage(async (page) => {
    await page.waitForFunction(() => window.__calls.imports.length === 1, null, { timeout: 5000 })
    const sent = await page.evaluate(() => window.__calls.imports[0])
    assert.deepEqual(sent.repos, [{ fullName: 'leo/projet', at: 5 }])
    assert.deepEqual(Object.keys(sent.conversations), ['app:C:/apps/snake'])
    // Écriture confirmée par le main : l'ancien stockage est retiré (et lui seul : les autres réglages restent).
    await page.waitForFunction(() => !localStorage.getItem('jaris.codeRepos'), null, { timeout: 5000 })
    assert.deepEqual(await legacyKeys(page), [])
    assert.equal(await page.evaluate(() => localStorage.getItem('jaris.codeChatWidth')), '420')
    // L'écran Code n'a jamais été ouvert ni lu.
    assert.equal(await page.evaluate(() => window.__calls.load), 0, 'l’écran Code a été monté')
    // Un booléen, jamais l'ElementHandle lui-même : node:assert ne sait pas le formater et le test ne finirait pas.
    assert.equal((await page.$('.code-split')) === null, true, 'l’écran Code est affiché')
  })
})

test('« Déplacer » attend la reprise, et ne déplace RIEN si elle échoue', options, async () => {
  await withPage(
    async (page) => {
      // La reprise de l'ouverture a échoué : l'ancien stockage est resté.
      await page.waitForFunction(() => window.__calls.imports.length === 1, null, { timeout: 5000 })
      await page.waitForTimeout(100)
      assert.equal((await legacyKeys(page)).length, 2)

      await page.click('.rail__item:has-text("Options")')
      await page.click('.options-menu__tab:has-text("Général")')
      const move = page.locator('.options-menu__action:has-text("Déplacer")')
      await move.click()
      await page.waitForSelector('.options-menu__ollama-update-note:has-text("pas pu être mises à l")', { timeout: 5000 })
      assert.deepEqual(await page.evaluate(() => window.__calls.order), ['import', 'import'], 'le dossier a été choisi sans que la reprise ait réussi')
      assert.equal((await legacyKeys(page)).length, 2, 'l’ancien stockage a été vidé sans écriture confirmée')

      // Une fois l'écriture possible : reprise d'abord, PUIS le choix du dossier.
      await page.evaluate(() => {
        window.__importFails = false
      })
      await page.waitForSelector('.options-menu__action:has-text("Déplacer"):not([disabled])')
      await move.click()
      await page.waitForFunction(() => window.__calls.order.includes('choose'), null, { timeout: 5000 })
      assert.deepEqual(await page.evaluate(() => window.__calls.order), ['import', 'import', 'import', 'choose'])
      assert.deepEqual(await legacyKeys(page), [])
    },
    { importFails: true }
  )
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
