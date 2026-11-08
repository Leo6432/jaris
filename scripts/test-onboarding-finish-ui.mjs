import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Fin de la configuration, côté écran (le côté fenêtre est vérifié par test-onboarding-finish.mjs) : un clic sur
 * « Continuer » de « Configuration terminée » doit afficher l'accueil de Jaris (l'Agent vocal, mode par défaut) dans
 * la MÊME fenêtre — elle n'est plus cachée par le processus principal, c'est donc bien cet écran que le nouvel
 * utilisateur voit en premier — et prévenir le processus principal une seule fois.
 *
 * Vrai composant App.tsx (CapacityScan compris) avec le CSS compilé (`npm run build` avant ce test).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-onboarding-finish-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

const entry = { model: 'qwen3.5:4b', vramGb: 3.4, usedIn: [], toolCalling: '6/6', intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 }
window.__onboardingFinished = 0
const known = {
  getProfile: async () => (window.__noProfile ? null : { name: 'Léo', capacityScanDone: Boolean(window.__scanDone), models: {} }),
  // Échecs simulés, avec le préfixe technique qu'Electron ajoute à toute erreur IPC (jamais montré à Léo).
  saveProfile: async (patch) => {
    if (window.__saveFailures > 0) {
      window.__saveFailures--
      throw new Error("Error invoking remote method 'jaris:save-profile': Error: Le disque est plein : ton prénom n'a pas pu être enregistré.")
    }
    window.__saved = patch
  },
  setLanguage: async (setting) => {
    if (window.__languageFails) throw new Error("Error invoking remote method 'jaris:set-language': Error: Réglage de langue illisible.")
    return { setting, code: setting, systemCode: 'fr' }
  },
  getMemoryGraph: async () => {
    if (window.__brainFails) throw new Error("Error invoking remote method 'jaris:get-memory-graph': Error: Le dossier de la mémoire est inaccessible.")
    return { nodes: [{ id: 'Léo', isCenter: true }], links: [] }
  },
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getWidgetMode: async () => 'voice',
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  getMyModelPicks: async () => ({ gpuName: 'RTX 3070', vramGb: 8, ramGb: 32, flash: entry, medium: entry, large: entry, vision: entry, code: entry, upgrades: {}, installCheck: null }),
  runQuickSetup: async () => ({
    gpuName: 'RTX 3070',
    vramGb: 8,
    models: { flash: 'qwen3.5:4b', medium: 'qwen3.5:4b', large: 'qwen3.5:4b' },
    visionModel: 'qwen3.5:4b',
    codeModel: 'qwen3.5:4b'
  }),
  notifyOnboardingFinished: () => { window.__onboardingFinished++ },
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
createRoot(document.getElementById('root')).render(<App />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-onboarding-finish-'))
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
  rmSync(outDir, { recursive: true, force: true })
  return pageHtml
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('« Continuer » de « Configuration terminée » affiche l’accueil dans la même fenêtre et prévient le main une fois', options, async () => {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    await page.setContent(html)
    // Écran « Configuration de Jaris » : lancer l'installation.
    await page.click('.capacity-scan button:has-text("Continuer"):not([disabled])')
    // Écran « Configuration terminée ».
    await page.waitForSelector('.capacity-scan h1:has-text("Configuration terminée")')
    assert.equal(await page.evaluate(() => window.__onboardingFinished), 0, 'rien ne doit partir avant le clic')
    await page.click('.capacity-scan button:has-text("Continuer")')
    // L'accueil : l'Agent vocal, avec la barre d'icônes de Jaris.
    await page.waitForSelector('.voice-screen')
    assert.equal(await page.locator('.capacity-scan').count(), 0, 'l’écran de configuration doit avoir disparu')
    assert.equal(await page.locator('.app-rail').count(), 1, 'la barre d’icônes de Jaris doit être là')
    const prompt = await page.locator('.voice-screen .app__status').textContent()
    // Étape 443 : le Vocal salue par le prénom, comme le Chat (« Que puis-je faire pour toi, Léo ? »).
    assert.equal(prompt?.trim().replace(/\u00a0/g, ' '), 'Que puis-je faire pour toi, Léo ?')
    assert.equal(await page.evaluate(() => window.__onboardingFinished), 1, 'le main doit être prévenu une seule fois')
  } finally {
    await browser.close()
  }
})

async function withApp(init, run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.setContent(html.replace('<body>', `<body><script>${init}</script>`))
    await run(page)
    assert.deepEqual(errors, [], 'aucune erreur non rattrapée')
  } finally {
    await browser.close()
  }
}

// Jusqu'à la version 0.49.1, ces trois actions n'avaient aucun « catch » : un échec ne laissait qu'un bouton muet.
test('premier écran : prénom non enregistré -> le vrai message sous le formulaire, puis un nouvel essai passe', options, async () => {
  await withApp('window.__noProfile = true; window.__saveFailures = 1', async (page) => {
    await page.fill('.app__onboarding input', 'Léo')
    await page.click('.app__onboarding button[type=submit]')
    const alert = page.locator('.app__onboarding [role=alert]')
    await alert.waitFor()
    assert.equal(await alert.textContent(), "Le disque est plein : ton prénom n'a pas pu être enregistré.")
    await page.click('.app__onboarding button[type=submit]')
    await page.waitForSelector('.capacity-scan')
    assert.deepEqual(await page.evaluate(() => window.__saved), { name: 'Léo' })
  })
})

test('premier écran : langue refusée -> le menu revient sur la langue en place et le message le dit', options, async () => {
  await withApp('window.__noProfile = true; window.__languageFails = true', async (page) => {
    const select = page.locator('.app__onboarding-language select')
    const before = await select.inputValue()
    await select.selectOption('en')
    const alert = page.locator('.app__onboarding [role=alert]')
    await alert.waitFor()
    assert.equal(await alert.textContent(), 'Réglage de langue illisible.')
    assert.equal(await select.inputValue(), before)
  })
})

test('bouton Cerveau : mémoire illisible -> le vrai message dans un bandeau, jamais un clic sans effet', options, async () => {
  await withApp('window.__scanDone = true; window.__brainFails = true', async (page) => {
    await page.click('.app-rail button[title="Cerveau de Jaris"]')
    const banner = page.locator('.app-main [role=alert]')
    await banner.waitFor()
    assert.match(await banner.textContent(), /Le dossier de la mémoire est inaccessible\./)
    assert.doesNotMatch(await banner.textContent(), /invoking remote method/)
    await banner.getByRole('button', { name: 'Fermer' }).click()
    assert.equal(await page.locator('.app-main [role=alert]').count(), 0)
  })
})
