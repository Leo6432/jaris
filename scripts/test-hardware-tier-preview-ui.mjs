import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 130, Léo : "met dans : Ce que ta machine fait tourner, le score Intelligence (Artificial Analysis)".
 * La carte des paliers (HardwareTierPreview, partagée entre l'écran d'accueil et Options -> Modèles)
 * n'affichait que le modèle, sa vitesse et sa fiabilité d'appel d'outils — alors que la donnée était DÉJÀ
 * disponible côté renderer (chaque emplacement de palier est un `ModelOverviewEntry` complet).
 *
 * Ce tableau n'a AUCUNE ligne d'en-tête, contrairement à celui de "Tous les modèles" : le test vérifie donc
 * que la valeur est affichée AVEC son libellé ("Intelligence 34"), sans quoi un nombre nu posé à côté d'un
 * badge "6/6" serait incompréhensible. Playwright n'étant pas une dépendance du projet (absent du runner
 * Windows de la CI), les tests se marquent "ignorés" avec une raison explicite plutôt que d'échouer.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-tier-preview-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import HardwareTierPreview from './src/components/HardwareTierPreview'

const e = (model, speed, tool, ai) => ({
  model, vramGb: 8, usedIn: [], speedTokPerSec: speed, speedEstimated: true,
  toolCalling: tool, intelligence: null, artificialAnalysisIndex: ai, artificialAnalysisSpeed: null
})

const tiers = [
  { label: 'Moyenne configuration', vramGb: 11.1, current: true,
    flash: e('granite4.2:3b', 180.2, '6/6', 9),
    medium: e('qwen3.5:9b', 31.5, '6/6', 14),
    large: e('qwen3.8:27b', 11.6, '6/6', 34),
    vision: e('qwen3-vl:4b', 42.1, '3/3', 6),
    // Modèle sans score publié chez Artificial Analysis : doit afficher "—", jamais un chiffre inventé.
    code: e('qwen2.5-coder:14b', 47.3, '3/3', null) }
]

const root = createRoot(document.getElementById('root'))
root.render(<div style={{ padding: 20, maxWidth: 760 }}><HardwareTierPreview tiers={tiers} /></div>)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-tier-preview-'))
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

async function withPreview(run, width = 760) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.capacity-scan__tier-table')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('"Ce que ta machine fait tourner" affiche l’Intelligence Index de chaque palier, avec son libellé', options, async () => {
  await withPreview(async (page) => {
    const cells = await page.$$eval('.capacity-scan__tier-intelligence', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(
      cells,
      ['Intelligence 9', 'Intelligence 14', 'Intelligence 34', 'Intelligence 6', '—'],
      `une cellule Intelligence par emplacement de palier attendue : ${cells.join(' | ')}`
    )
  })
})

test('un modèle sans score publié affiche "—", jamais un chiffre inventé ni une case vide', options, async () => {
  await withPreview(async (page) => {
    const codeRow = await page.$$eval('.capacity-scan__tier-table tr', (rows) => {
      const row = rows.find((r) => r.querySelector('.capacity-scan__tier-slot')?.textContent === 'Code')
      return row?.querySelector('.capacity-scan__tier-intelligence')?.textContent?.trim()
    })
    assert.equal(codeRow, '—', `le palier Code (sans score publié) doit afficher "—" : ${codeRow}`)
  })
})

test('la colonne ajoutée ne fait pas déborder la carte, même dans une fenêtre étroite', options, async () => {
  // Cette carte est partagée avec l'écran d'accueil (CapacityScan.tsx), où la fenêtre peut être bien plus
  // étroite que la page Options — un débordement horizontal ne se voit jamais à la largeur de développement.
  await withPreview(async (page) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.equal(overflow, false, 'la carte ne doit pas déborder horizontalement à 560px')
  }, 560)
})
