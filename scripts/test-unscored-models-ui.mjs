import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Léo, 05/10/2026 : pendant le rejeu des cas coupés (délai dépassé, plantage), le suivi du test n'affichait rien —
 * « ça met fini » pour un seul modèle sur huit, alors que les sept autres avançaient. Vrai composant
 * UnscoredModelsTest dans un vrai navigateur, alimenté par les lignes que le script écrit vraiment.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-unscored-models-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import UnscoredModelsTest from './src/components/UnscoredModelsTest'
import { t } from '@/lib/i18n'

window.jaris = {
  getUnscoredModels: () => Promise.resolve([{ model: 'ministral-3:14b', needs: [{ test: 'tools', reason: 'redo' }] }, { model: 'qwen2.5-coder:14b', needs: [{ test: 'tools', reason: 'missing' }, { test: 'vision', reason: 'missing' }] }]),
  onModelBenchmarkLine: (cb) => { window.__line = cb; return () => {} },
  // Étape 437 : où se fera le test (ce PC ici).
  machineGet: async () => ({ connected: false, saved: null }),
  onMachineChanged: () => () => {},
  // Étape 438 : le fichier à m'envoyer.
  exportTestResults: async () => (window.__exportCalls = (window.__exportCalls || 0) + 1, window.__exportResult ?? { saved: true, rows: 42, models: 3, sizeKb: 180 }),
  testUnscoredModels: () => window.__busy
    ? Promise.reject(new Error(t('bench.testRunning')))
    : new Promise((resolve, reject) => {
        window.__finish = () => resolve({ models: [], resultsPath: 'x' })
        window.__killed = () => reject(new Error(t('unscored.stopped')))
      }),
  // Étape 441 : comme le main, l'arrêt fait finir le test en cours sur « arrêté ».
  stopUnscoredTest: async () => {
    window.__stops = (window.__stops || 0) + 1
    window.__killed?.()
    window.__busy = false
  },
  showUnscoredResults: () => {}
}
createRoot(document.getElementById('root')).render(<UnscoredModelsTest />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-unscored-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('le rejeu des cas coupés se voit dans le suivi, sans passer pour un score', options, async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setContent(buildPage())
    await page.click('button >> text=Tester ces modèles')
    await page.click('button >> text=Lancer le test')
    await page.evaluate(() => window.__line('##MODEL_TESTING## ministral-3:14b'))
    await page.waitForFunction(() => document.querySelector('.options-menu__progress-label')?.textContent.includes('Test de'))
    await page.evaluate(() => window.__line('##REPLAY_DONE## ministral-3:14b 2'))
    await page.evaluate(() => window.__line('##REPLAY_DONE## qwen2.5-coder:14b 1'))
    await page.waitForSelector('.options-menu__unscored-results li')
    const rows = await page.$$eval('.options-menu__unscored-results li', (els) => els.map((el) => el.textContent))
    assert.equal(rows.length, 2)
    assert.match(rows[0], /2 cas refaits$/)
    assert.match(rows[1], /1 cas refait$/)
    assert.ok(rows.every((r) => !/\d+\/\d+/.test(r)), 'un nombre de cas refaits ne doit pas ressembler à un score')
    await page.evaluate(() => window.__finish())
    await page.waitForFunction(() => document.querySelector('.options-menu__progress-label')?.textContent === 'Test terminé.')
  } finally {
    await browser.close()
  }
})

test('étape 314 : une réponse de plusieurs minutes affiche depuis combien de temps le modèle répond', options, async () => {
  // Léo a quitté un test qu'il croyait bloqué : la 32B mettait 8 à 15 minutes par application, sans rien afficher.
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setContent(buildPage())
    await page.click('button >> text=Tester ces modèles')
    await page.click('button >> text=Lancer le test')
    const label = () => page.$eval('.options-menu__progress-label', (el) => el.textContent)
    await page.evaluate(() => window.__line('##MODEL_TESTING## hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M'))
    await page.waitForFunction(() => document.querySelector('.options-menu__progress-label')?.textContent.startsWith('Test de'))
    // Sous une minute : rien ne change.
    await page.evaluate(() => window.__line('##WORKING## hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M 45'))
    assert.doesNotMatch(await label(), /répond toujours/)
    await page.evaluate(() => window.__line('##WORKING## hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M 750'))
    await page.waitForFunction(() => document.querySelector('.options-menu__progress-label')?.textContent.includes('répond toujours'))
    assert.match(await label(), /le modèle répond toujours \(12 min\)$/)
    assert.doesNotMatch(await label(), /hf\.co|GGUF/, 'nom lisible, jamais le nom technique')
    // Fin de la longue réponse : retour à « Test de … » pour les questions courtes qui suivent.
    await page.evaluate(() => window.__line('##WORKING## hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M 0'))
    await page.waitForFunction(() => !document.querySelector('.options-menu__progress-label')?.textContent.includes('répond toujours'))
    assert.match(await label(), /^Test de .+…$/)
  } finally {
    await browser.close()
  }
})

test('étape 438 : « Préparer le fichier à m’envoyer » dit ce qu’il a préparé, ou qu’il n’y a rien de nouveau', options, async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setContent(buildPage())
    await page.click('button >> text=Préparer le fichier à m\'envoyer')
    await page.waitForSelector('.options-menu__unscored-export [role="status"]')
    assert.match(await page.textContent('.options-menu__unscored-export [role="status"]'), /Fichier prêt : 42 résultats de 3 modèles \(180 Ko\)/)
    await page.evaluate(() => { window.__exportResult = { saved: false, empty: true } })
    await page.click('button >> text=Préparer le fichier à m\'envoyer')
    await page.waitForFunction(() => document.querySelector('.options-menu__unscored-export [role="status"]')?.textContent.startsWith('Rien de nouveau'))
    assert.equal(await page.evaluate(() => window.__exportCalls), 2)
  } finally {
    await browser.close()
  }
})

test('étape 441 : « Arrêter le test » pendant le test, sans quitter Jaris ; il finit sur « arrêté » et peut reprendre', options, async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } })
    await page.setContent(buildPage())
    await page.click('button >> text=Tester ces modèles')
    await page.click('button >> text=Lancer le test')
    await page.evaluate(() => window.__line('##MODEL_DONE## ministral-3:14b 70 78'))
    // Trouvable : le bouton est là pendant tout le test, sous la progression.
    const stop = page.locator('.options-menu__progress button', { hasText: 'Arrêter le test' })
    assert.equal(await stop.count(), 1)
    assert.equal(await stop.isVisible(), true)
    await stop.click()
    await page.waitForFunction(() => document.querySelector('.options-menu__progress-label')?.textContent.startsWith('Test arrêté.'))
    assert.equal(await page.evaluate(() => window.__stops), 1)
    assert.equal(await page.locator('.options-menu__error').count(), 0, 'un arrêt voulu n’est pas une panne')
    // Ce qui est fini reste affiché, et on peut reprendre ou envoyer ce qui est fait.
    assert.match(await page.textContent('.options-menu__unscored-results'), /70\/78/)
    assert.equal(await page.locator('button', { hasText: 'Reprendre le test' }).count(), 1)
    assert.equal(await page.locator('button', { hasText: 'Préparer le fichier à m’envoyer' }).count() + await page.locator('button', { hasText: "Préparer le fichier à m'envoyer" }).count(), 1)
    assert.equal(await page.locator('button', { hasText: 'Arrêter le test' }).count(), 0)
  } finally {
    await browser.close()
  }
})

test('étape 441 : un test déjà lancé ailleurs (« déjà en cours ») s’arrête aussi d’ici', options, async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setContent(buildPage())
    await page.evaluate(() => { window.__busy = true })
    await page.click('button >> text=Tester ces modèles')
    await page.click('button >> text=Lancer le test')
    await page.waitForSelector('.options-menu__error')
    assert.match(await page.textContent('.options-menu__error'), /arrête-le avec/)
    await page.click('button >> text=Arrêter le test')
    await page.waitForSelector('button >> text=Tester ces modèles')
    assert.equal(await page.evaluate(() => window.__stops), 1)
    assert.equal(await page.locator('.options-menu__error').count(), 0)
  } finally {
    await browser.close()
  }
})
