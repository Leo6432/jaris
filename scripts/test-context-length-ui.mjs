import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Curseur de longueur de contexte (Options -> Modèles), demande de Léo devant une capture de l'app Ollama :
 * "jaris voit les model et regarde la vram et propose une barre comme sur ollama mais qui est personnaliser
 * a chacun pour que le dernier ne dépasse pas la vram". Le calcul du plafond (VRAM/K-V cache) est déjà
 * couvert sans navigateur par scripts/test-context-length.mjs — ce test-ci vérifie seulement que le VRAI
 * composant l'affiche correctement et que le déplacer enregistre bien la bonne valeur, ce qu'aucun test
 * structurel ne peut prouver (même leçon que le bouton resté gris de l'étape 97).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-context-length-tab-entry.tsx')

// availableSteps volontairement PLUS COURT que CONTEXT_LENGTH_STEPS au complet (4 paliers sur 7) : simule
// une machine dont la VRAM ne permet pas de monter jusqu'à 256k, exactement le cas que ce réglage doit
// couvrir — un curseur qui afficherait quand même les 7 paliers laisserait croire que 256k est sûr partout.
const CONTEXT_OPTIONS = { current: 8192, max: 32768, availableSteps: [4096, 8192, 16384, 32768] }

const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

window.__setContextLengthCalls = []
const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {},
  getContextLengthOptions: async () => (${JSON.stringify(CONTEXT_OPTIONS)}),
  setContextLength: async (value) => { window.__setContextLengthCalls.push(value) }
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

const root = createRoot(document.getElementById('root'))
root.render(<OptionsMenu />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-context-length-tab-'))
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

async function withModelesTab(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.click('.options-menu__trigger')
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.waitForSelector('.options-menu__context-slider')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('le curseur ne propose QUE les paliers sûrs pour cette machine, jamais les 7 par défaut', options, async () => {
  await withModelesTab(async (page) => {
    const ticks = await page.$$eval('.options-menu__context-slider-ticks span', (els) => els.map((el) => el.textContent))
    assert.deepEqual(ticks, ['4k', '8k', '16k', '32k'], `paliers affichés : ${ticks.join(', ')}`)
    const max = await page.getAttribute('.options-menu__context-slider', 'max')
    assert.equal(max, '3', 'le curseur doit avoir 4 positions (index 0 à 3), pas 7')
  })
})

test('déplacer le curseur enregistre la bonne valeur en tokens, pas un index brut', options, async () => {
  await withModelesTab(async (page) => {
    // Position 2 de availableSteps = 16384, PAS "2" tel quel : un bug qui enregistrerait l'index au lieu de
    // la vraie valeur passerait inaperçu tant qu'on ne vérifie pas le nombre réellement transmis à setContextLength.
    await page.evaluate(() => {
      const el = document.querySelector('.options-menu__context-slider')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '2')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForFunction(() => window.__setContextLengthCalls.length > 0)
    const calls = await page.evaluate(() => window.__setContextLengthCalls)
    assert.deepEqual(calls, [16384], `attendu [16384], reçu ${JSON.stringify(calls)}`)
    // Le libellé "Actuellement" doit suivre tout de suite (mise à jour optimiste), pas attendre la
    // confirmation du main process.
    const currentLabel = await page.textContent('.options-menu__context-row .options-menu__row-description strong')
    assert.equal(currentLabel, '16k')
  })
})

test('le curseur est réellement habillé par le CSS de Jaris, pas laissé au style par défaut du navigateur', options, async () => {
  await withModelesTab(async (page) => {
    const styles = await page.$eval('.options-menu__context-slider', (el) => {
      const s = getComputedStyle(el)
      return { appearance: s.appearance || s.webkitAppearance, borderRadius: s.borderRadius, cursor: s.cursor }
    })
    assert.equal(styles.appearance, 'none', 'un curseur au style par défaut du navigateur ne serait pas habillé pareil sur toutes les machines')
    assert.equal(styles.borderRadius, '999px')
    assert.equal(styles.cursor, 'pointer')
  })
})
