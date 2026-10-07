import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 257 — l'écran du duel vidéo (Options → Général → Développeur), VRAI composant et vrai CSS compilé, dans un
 * navigateur. Ce qui compte : le jugement est À L'AVEUGLE (aucun nom de modèle ni temps avant le choix), le choix part
 * avec le bon modèle derrière « A » ou « B », et la révélation suit.
 * Playwright n'est pas une dépendance du projet : tests ignorés (jamais verts en silence) s'il manque.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-video-duel-entry.tsx')

const RESULTS = {
  date: '2026-10-07T18:00:00.000Z',
  machine: 'NVIDIA GeForce RTX 3070 (8 Go)',
  fastwanQuality: 'Élevé',
  kandinsky: { encodeSeconds: 95.5, loadSeconds: 12.1, offload: 'model', peakVramGb: 7.2 },
  videos: [
    { prompt: 'humain', model: 'fastwan', file: 'fastwan-humain.webm', seconds: 72 },
    { prompt: 'humain', model: 'kandinsky', file: 'kandinsky-humain.mp4', seconds: 431 },
    { prompt: 'paysage', model: 'fastwan', file: 'fastwan-paysage.webm', seconds: 70 }
  ],
  // « humain » : Kandinsky est montré en A.
  order: { humain: 'kandinsky', paysage: 'fastwan', chat: 'fastwan' },
  choices: {}
}

const ENTRY = `
import { createRoot } from 'react-dom/client'
import { VideoDuelSettings } from './src/components/VideoDuelSettings'

window.__choices = []
let results = ${JSON.stringify(RESULTS)}
let logListener = null
window.__status = { supported: true, blocker: null, ready: true, downloadLabel: '', running: false, results }
window.jaris = {
  getVideoDuelStatus: async () => window.__status,
  runVideoDuel: () => new Promise(() => {}),
  cancelVideoDuel: () => { window.__cancelled = true },
  onVideoDuelLog: (cb) => { logListener = cb; return () => {} },
  readDuelVideo: async (file) => { window.__read = [...(window.__read || []), file]; return new Uint8Array([1, 2, 3]) },
  setVideoDuelChoice: async (prompt, choice) => {
    window.__choices.push([prompt, choice])
    results = { ...results, choices: { ...results.choices, [prompt]: choice } }
    return results
  },
  deleteVideoDuelFiles: async () => {},
  openVideoDuelFolder: async () => {}
}
window.__log = (m) => logListener && logListener(m)
const root = createRoot(document.getElementById('root'))
window.__mount = () => root.render(<VideoDuelSettings />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-duel-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync('npx', ['esbuild', entryPath, '--bundle', '--format=iife', '--loader:.tsx=tsx', '--jsx=automatic', `--alias:@=${join(projectRoot, 'src')}`, `--outfile=${bundlePath}`], {
      cwd: projectRoot,
      stdio: 'pipe'
    })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#05070c;}#root{width:900px;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, prepare) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 960, height: 1400 })
    await page.setContent(buildPage())
    if (prepare) await page.evaluate(prepare)
    await page.evaluate(() => window.__mount())
    await page.waitForSelector('.options-menu__group')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('à l’aveugle : ni nom de modèle ni temps avant le choix ; le choix part avec le modèle caché derrière « A »', options, async () => {
  await withPage(async (page) => {
    const humain = page.locator('.video-duel__prompt').first()
    await humain.locator('video').first().waitFor()
    const before = await humain.innerText()
    assert.match(before, /Vidéo A/)
    assert.doesNotMatch(before, /FastWan|Kandinsky|min|\d+ s\b/, before)
    // Deux vidéos lues par le processus principal, par NOM.
    assert.deepEqual((await page.evaluate(() => window.__read)).filter((f) => f.includes('humain')).sort(), ['fastwan-humain.webm', 'kandinsky-humain.mp4'])

    await humain.getByRole('button', { name: 'A est mieux' }).click()
    assert.deepEqual(await page.evaluate(() => window.__choices), [['humain', 'kandinsky']])
    await humain.locator('.video-duel__reveal').first().waitFor()
    const after = await humain.innerText()
    assert.match(after, /Vidéo A — Kandinsky 6 Lite \(avec le son\), 7 min 11/)
    assert.match(after, /Vidéo B — FastWan 2\.2 5B \(actuel\), 1 min 12/)
    // La vidéo choisie est mise en avant par le CSS de Jaris (style calculé, pas seulement le nom de classe).
    const border = await humain.locator('.video-duel__side--chosen').evaluate((el) => getComputedStyle(el).borderTopColor)
    assert.equal(border, 'rgb(49, 255, 176)')
    // Le bouton choisi aussi, souris encore dessus (la règle de survol de la famille de boutons est plus spécifique).
    await page.waitForTimeout(300)
    const button = await humain.getByRole('button', { name: 'A est mieux' }).evaluate((el) => getComputedStyle(el).color)
    assert.equal(button, 'rgb(49, 255, 176)')
  })
})

test('une vidéo pas encore faite ne propose pas de choix ; deux côte à côte en largeur normale', options, async () => {
  await withPage(async (page) => {
    const paysage = page.locator('.video-duel__prompt').nth(1)
    assert.match(await paysage.innerText(), /Pas encore faite/)
    assert.equal(await paysage.getByRole('button', { name: 'A est mieux' }).count(), 0)
    const sides = await page.locator('.video-duel__prompt').first().locator('.video-duel__side').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
    assert.equal(sides.length, 2)
    assert.ok(Math.abs(sides[0] - sides[1]) < 2, 'A et B sur la même ligne')
  })
})

test('pendant le duel : bouton Arrêter, dernière étape et temps écoulé ; blocage affiché tel quel', options, async () => {
  await withPage(async (page) => {
    await page.getByRole('button', { name: 'Relancer le duel' }).click()
    await page.evaluate(() => window.__log('Kandinsky « humain » : étape 3/10 (95 s)'))
    await page.getByText(/étape 3\/10/).waitFor()
    assert.match(await page.locator('.video-duel__log').innerText(), /écoulées/)
    await page.getByRole('button', { name: 'Arrêter le duel' }).click()
    assert.equal(await page.evaluate(() => window.__cancelled), true)
  })
  await withPage(
    async (page) => {
      await page.getByText("Télécharge d'abord FastWan dans le mode Vidéo").waitFor()
      assert.equal(await page.getByRole('button', { name: /Lancer le duel/ }).count(), 0)
    },
    () => {
      window.__status = { supported: true, blocker: "Télécharge d'abord FastWan dans le mode Vidéo : le duel utilise la qualité que tu as déjà.", ready: false, downloadLabel: 'environ 29 Go', running: false, results: null }
    }
  )
})
