import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'


/**
 * Étape 156, Léo : « fais un test de vitesse quand on la met sur la VRAM et sur la RAM, avec la RAM prise, la
 * VRAM et la vitesse ». Vérifie dans un vrai navigateur, avec le VRAI composant et le CSS compilé, que le
 * bouton d'Options → Voix affiche l'avancement pendant le test, puis un tableau avec la vitesse, la RAM et la
 * VRAM de chaque façon de comprendre la voix — et qu'une ligne non mesurable dit POURQUOI au lieu d'afficher
 * des chiffres vides.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-stt-bench-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

let progress = () => {}
window.__release = null
const rows = [
  { id: 'cohere-vram', label: "Cohere (l'actuel) sur la carte graphique", where: 'vram', available: true, secondsPer5s: 0.31, ramGb: 1.2, vramGb: 4.6, errorsPct: 2.3, loadSeconds: 12, sample: 'Jaris, quel temps fera-t-il demain à Lyon ?' },
  { id: 'cohere-ram', label: "Cohere (l'actuel) en RAM", where: 'ram', available: false, reason: 'Il faudrait environ 10 Go de RAM libre (seulement 6.2 Go).' },
  { id: 'parakeet-ram', label: 'Parakeet v3 en RAM', where: 'ram', available: true, secondsPer5s: 0.53, ramGb: 2.5, vramGb: 0, errorsPct: 0, loadSeconds: 20 }
]
const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {},
  listAudioInputDevices: async () => [],
  onSttBenchmarkProgress: (cb) => { progress = cb; return () => {} },
  runSttBenchmark: () => new Promise((resolve) => {
    progress('Test : Parakeet v3 en RAM (premier essai : téléchargement du modèle si besoin)…')
    window.__release = (ok) => resolve(ok ? { ok: true, gpu: 'NVIDIA GeForce RTX 3070', rows } : { ok: false, message: "Le test s'est arrêté avant la fin (code 1).", rows: [] })
  })
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

createRoot(document.getElementById('root')).render(<OptionsMenu />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-stt-bench-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withVoiceTab(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.click('.options-menu__trigger')
    await page.getByRole('button', { name: 'Lancer le test' }).waitFor()
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test("pendant le test, l'étape en cours s'affiche et le bouton ne peut pas relancer un second test", options, async () => {
  await withVoiceTab(async (page) => {
    await page.getByRole('button', { name: 'Lancer le test' }).click()
    await page.waitForSelector('.options-menu__stt-bench-progress')
    assert.match(await page.textContent('.options-menu__stt-bench-progress'), /Parakeet v3 en RAM/)
    assert.equal(await page.getByRole('button', { name: 'Test en cours…' }).isDisabled(), true)
  })
})

test('à la fin : un tableau avec la vitesse, la RAM prise et la VRAM prise de chaque façon de comprendre la voix', options, async () => {
  await withVoiceTab(async (page) => {
    await page.getByRole('button', { name: 'Lancer le test' }).click()
    await page.waitForFunction(() => typeof window.__release === 'function')
    await page.evaluate(() => window.__release(true))
    await page.waitForSelector('.options-menu__stt-bench-table')
    const headers = await page.$$eval('.options-menu__stt-bench-table th', (ths) => ths.map((th) => th.textContent))
    assert.deepEqual(headers, ['Façon de comprendre ta voix', 'Pour 5 s de parole', 'RAM prise', 'VRAM prise', 'Erreurs'])
    const cells = await page.$$eval('.options-menu__stt-bench-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)))
    assert.deepEqual(cells[0].slice(1), ['0,31 s', '1,2 Go', '4,6 Go', '2,3 %'])
    assert.match(cells[0][0], /Compris : « Jaris, quel temps/)
    // Une ligne non mesurable dit pourquoi, au lieu de chiffres vides.
    assert.equal(cells[1].length, 2)
    assert.match(cells[1][1], /^Non mesuré : Il faudrait environ 10 Go de RAM libre/)
    // Pas de VRAM prise quand la transcription tourne en RAM : un tiret, pas « 0 Go ».
    assert.equal(cells[2][3], '—')
    assert.match(await page.textContent('.options-menu__stt-bench'), /carte : NVIDIA GeForce RTX 3070/)
    // Le bouton est de nouveau utilisable, l'avancement a disparu.
    assert.equal(await page.getByRole('button', { name: 'Lancer le test' }).isDisabled(), false)
    assert.equal(await page.$('.options-menu__stt-bench-progress'), null)
  })
})

test('le tableau est habillé par le CSS compilé (chiffres alignés à droite, séparations)', options, async () => {
  await withVoiceTab(async (page) => {
    await page.getByRole('button', { name: 'Lancer le test' }).click()
    await page.waitForFunction(() => typeof window.__release === 'function')
    await page.evaluate(() => window.__release(true))
    await page.waitForSelector('.options-menu__stt-bench-table')
    const style = await page.$eval('.options-menu__stt-bench-table tbody tr td:nth-child(2)', (td) => {
      const s = getComputedStyle(td)
      return { align: s.textAlign, border: s.borderBottomStyle }
    })
    assert.equal(style.align, 'right')
    assert.equal(style.border, 'solid')
  })
})

test('un test qui échoue affiche son message, sans tableau', options, async () => {
  await withVoiceTab(async (page) => {
    await page.getByRole('button', { name: 'Lancer le test' }).click()
    await page.waitForFunction(() => typeof window.__release === 'function')
    await page.evaluate(() => window.__release(false))
    await page.waitForSelector('.options-menu__mic-result--bad')
    assert.match(await page.textContent('.options-menu__mic-result--bad'), /arrêté avant la fin/)
    assert.equal(await page.$('.options-menu__stt-bench-table'), null)
  })
})
