import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 437 : la page Machine dans un VRAI navigateur, avec le CSS compilé — ce que Léo tape part tel quel au main
 * (nombres compris), l'état connecté montre la machine, ses modèles et « Déconnecter », une erreur se lit.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-machine-ui-entry.tsx')
const ENTRY = `
import { createRoot } from 'react-dom/client'
import MachinePanel from './src/components/MachinePanel'
const off = { saved: { host: 'http://10.0.0.5:11434', vramGb: 80, ramGb: 64, diskGb: 100 }, connected: false, connecting: false, version: null, error: null, models: [], pulling: null, freeDiskGb: null, busy: null }
window.__calls = []
window.__listeners = []
window.__emit = (view) => window.__listeners.forEach((cb) => cb(view))
window.jaris = {
  machineGet: async () => window.__initial ?? off,
  onMachineChanged: (cb) => { window.__listeners.push(cb); return () => {} },
  machineConnect: async (settings) => {
    window.__calls.push(['connect', settings])
    if (window.__refuse) throw new Error(window.__refuse)
    return { ...off, saved: { ...settings, host: 'http://10.0.0.5:11434' }, connected: true, version: '0.40.4', models: [
      { model: 'qwen3.5:9b', installed: true, error: null },
      { model: 'qwen3-vl:8b', installed: false, error: null },
      { model: 'gemma4:31b', installed: false, error: 'plus de place sur le disque' }
    ], pulling: { model: 'qwen3-vl:8b', percent: 42 }, freeDiskGb: 61.5 }
  },
  machineDisconnect: async () => { window.__calls.push(['disconnect']); return off }
}
createRoot(document.getElementById('root')).render(<MachinePanel />)
`

function buildPage() {
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-machine-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#root{height:100%;display:flex}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
}

test('page Machine : explique, pré-remplit, envoie les réglages tapés, puis montre la machine connectée', options, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } })
    await page.setContent(buildPage())
    await page.waitForSelector('.machine-page__steps')
    assert.match(await page.textContent('.machine-page__lead'), /Tant qu'elle est connectée, les modèles de Jaris tournent dessus/)
    assert.equal(await page.locator('.machine-page__steps li').count(), 4)
    assert.match(await page.textContent('.machine-page__steps'), /«\sOllama\s»/)
    // Pré-rempli avec la dernière machine : Léo n'a qu'à corriger.
    const inputs = page.locator('.machine-page__fields input')
    assert.deepEqual(await inputs.evaluateAll((els) => els.map((el) => el.value)), ['http://10.0.0.5:11434', '80', '64', '100'])
    await inputs.nth(1).fill('80,5')
    await inputs.nth(3).fill('500')
    await page.click('button:has-text("Connecter")')
    await page.waitForSelector('.machine-page__card--on')
    assert.deepEqual(await page.evaluate(() => window.__calls[0]), ['connect', { host: 'http://10.0.0.5:11434', vramGb: 80.5, ramGb: 64, diskGb: 500 }])
    const card = await page.textContent('.machine-page__card--on')
    assert.match(card, /Connectée à http:\/\/10\.0\.0\.5:11434 — Ollama 0\.40\.4/)
    assert.match(card, /Place libre estimée sur la machine : 61,5 Go/)
    const models = await page.locator('.machine-page__models li').allTextContents()
    assert.deepEqual(models, ['qwen3.5:9b : prêt', 'qwen3-vl:8b : téléchargement : 42 %', 'gemma4:31b : échec : plus de place sur le disque'])
    // Les champs disparaissent une fois connectée ; seul « Déconnecter » reste.
    assert.equal(await page.locator('.machine-page__fields').count(), 0)
    await page.click('button:has-text("Déconnecter")')
    await page.waitForSelector('.machine-page__steps')
    assert.deepEqual(await page.evaluate(() => window.__calls[1]), ['disconnect'])
    // Habillé par le CSS de Jaris (carte bordée), pas des champs nus.
    assert.equal(await page.$eval('.machine-page__card', (el) => getComputedStyle(el).borderStyle), 'solid')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.equal(overflow, false, 'rien ne déborde à 760 px')
  } finally {
    await browser.close()
  }
})

test('page Machine : un refus se lit, et un test en cours bloque le bouton', options, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } })
    await page.addInitScript(() => {
      window.__refuse = 'La machine des modèles (http://10.0.0.5:11434) ne répond pas.'
    })
    await page.setContent(buildPage())
    await page.evaluate(() => { window.__refuse = 'La machine des modèles (http://10.0.0.5:11434) ne répond pas.' })
    await page.waitForSelector('.machine-page__fields')
    await page.click('button:has-text("Connecter")')
    await page.waitForSelector('.machine-page__note--warn[role="alert"]')
    assert.match(await page.textContent('[role="alert"]'), /ne répond pas/)
    await page.evaluate(() => window.__emit({ saved: null, connected: false, connecting: false, version: null, error: null, models: [], pulling: null, freeDiskGb: null, busy: 'test' }))
    await page.waitForSelector('button:has-text("Connecter"):disabled')
    assert.match(await page.textContent('.machine-page__inner'), /test de modèles est en cours/)
  } finally {
    await browser.close()
  }
})
