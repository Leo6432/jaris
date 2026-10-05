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

window.jaris = {
  getUnscoredModels: () => Promise.resolve(['ministral-3:14b', 'qwen2.5-coder:14b']),
  onModelBenchmarkLine: (cb) => { window.__line = cb; return () => {} },
  testUnscoredModels: () => new Promise((resolve) => { window.__finish = () => resolve({ models: [], resultsPath: 'x' }) }),
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
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath, logLevel: 'error' })
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
