import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 234 (bêta de Jaris) : sur l'écran d'installation du premier lancement, un échec (ex. GitHub qui limite
 * les téléchargements de Python) s'affichait deux fois, et la barre continuait d'animer alors que tout était
 * arrêté — on croyait que Jaris travaillait encore. Vrai composant RuntimeSetup dans un vrai navigateur.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-runtime-setup-entry.tsx')
const FAILURE = "L'installation de Python a échoué : GitHub limite le nombre de téléchargements"

const ENTRY = `
import { createRoot } from 'react-dom/client'
import RuntimeSetup from './src/components/RuntimeSetup'

window.jaris = {
  onRuntimeSetupProgress: (cb) => { window.__emit = cb; return () => {} },
  runRuntimeSetup: () => new Promise((resolve) => { window.__finish = (ready) => resolve({ ready }) })
}
createRoot(document.getElementById('root')).render(<RuntimeSetup onDone={() => { window.__done = true }} />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-runtime-setup-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1000, height: 760 })
    await page.setContent(html)
    await page.waitForSelector('.runtime-setup__status')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const occurrences = (text, needle) => text.split(needle).length - 1

test('un échec s’affiche une seule fois, et la barre s’arrête quand tout est fini', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__emit({ message: 'Téléchargement de Python…', percent: 40 }))
    assert.match(await page.textContent('.runtime-setup__status'), /Téléchargement de Python/)

    await page.evaluate((message) => window.__emit({ message, failed: true }), FAILURE)
    await page.waitForSelector('.runtime-setup__failures li')
    assert.equal(occurrences(await page.textContent('.runtime-setup'), FAILURE), 1, 'pendant l’installation')
    assert.equal(await page.isVisible('.runtime-setup__bar'), true, 'la suite (Ollama…) continue')

    await page.evaluate(() => window.__finish(false))
    await page.waitForSelector('.runtime-setup__actions')
    const text = await page.textContent('.runtime-setup')
    assert.equal(occurrences(text, FAILURE), 1, 'une fois fini')
    assert.match(await page.textContent('.runtime-setup__status'), /pas allée jusqu'au bout/)
    assert.equal(await page.$('.runtime-setup__bar'), null, 'plus de barre animée une fois tout arrêté')
  })
})

test('installation réussie : on passe à la suite', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__finish(true))
    await page.waitForFunction(() => window.__done === true)
  })
})
