import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Mode Image (étape 200, Léo : « enlève Montage, on le remplace par Image comme ChatGPT »), sur le VRAI
 * composant et le vrai CSS compilé : accueil avec vignettes, dessin avec avancement et arrêt, image affichée,
 * enregistrement, suppression, et écran d'installation quand le modèle de dessin manque.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-image-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import ImagePanel from './src/components/ImagePanel'

// Un vrai petit PNG (1x1), pour que <img> ait quelque chose à afficher.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg=='
window.__calls = []
window.__status = window.__status || { supported: true, capable: true, reason: null, installed: true, downloadLabel: '5,1 Go' }
window.__images = window.__images || [
  { fileName: '2026-09-28T17-22-15-un-chat-sur-la-lune.png', label: 'Un chat sur la lune', timestamp: Date.now() - 60000 },
  { fileName: '2026-09-27T10-00-00-une-foret.png', label: 'Une forêt', timestamp: Date.now() - 86400000 }
]

window.jaris = {
  getImageStudioStatus: async () => window.__status,
  installImageStudio: () => {
    window.__calls.push('install')
    return new Promise((resolve) => { window.__finishInstall = () => { window.__status = { ...window.__status, installed: true }; resolve() } })
  },
  onImageStudioLog: (cb) => { window.__log = cb; return () => {} },
  generateStudioImage: (prompt) => {
    window.__calls.push(['generate', prompt])
    return new Promise((resolve, reject) => {
      window.__finishGen = () => {
        const image = { fileName: '2026-09-28T18-00-00-un-phare.png', label: 'Un phare', timestamp: Date.now() }
        window.__images = [image, ...window.__images]
        resolve(image)
      }
      window.__failGen = (message) => reject(new Error(message))
    })
  },
  cancelStudioImage: () => { window.__calls.push('cancel'); window.__failGen('Dessin annulé.') },
  listGeneratedImages: async () => window.__images,
  readGeneratedImage: async (fileName) => { window.__calls.push(['read', fileName]); return PNG },
  deleteGeneratedImage: async (fileName) => { window.__calls.push(['delete', fileName]); window.__images = window.__images.filter((i) => i.fileName !== fileName) },
  openGeneratedImages: async (fileName) => { window.__calls.push(['open', fileName]) },
  saveGeneratedImage: async (dataUrl) => { window.__calls.push(['save', dataUrl.slice(0, 22)]); return { saved: true } },
  getProfile: async () => null
}

createRoot(document.getElementById('root')).render(<ImagePanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-image-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, init = '') {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.setContent(init ? html.replace('<body>', `<body><script>${init}</script>`) : html)
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('accueil : les dernières images en vignettes, la liste à gauche, le champ en bas', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel__thumb img')
    assert.equal(await page.locator('.image-panel__thumb').count(), 2)
    assert.match(await page.textContent('.workspace__new'), /Nouvelle image/i)
    assert.match(await page.textContent('.workspace__rail'), /Un chat sur la lune.*Une forêt/s)
    const composer = await page.$eval('.image-panel > .composer', (el) => el === el.parentElement.lastElementChild)
    assert.equal(composer, true, 'le champ est le dernier élément, en bas')
    assert.equal(await page.locator('.composer__plus').count(), 0, 'pas de « + » : le mode Image dessine, il ne lit rien')
  })
})

test('dessiner : avancement avec barre, puis l’image s’affiche et rejoint la liste', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un phare sous la tempête')
    await page.click('.composer__send')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate'), ['generate', 'un phare sous la tempête'])
    await page.evaluate(() => window.__log('Dessin : étape 2 sur 4'))
    await page.waitForFunction(() => /Dessin : étape 2 sur 4/.test(document.querySelector('.code-panel__live').textContent))
    assert.equal(await page.$eval('.image-panel__progress .options-menu__progress-bar-fill', (el) => el.style.width), '50%')

    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.image-panel__image')
    assert.match(await page.textContent('.code-panel__done'), /ton image est prête/)
    assert.match(await page.textContent('.image-panel__title'), /Un phare/)
    assert.match(await page.textContent('.workspace__rail'), /Un phare/)
    const image = await page.$eval('.image-panel__image', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, fit: getComputedStyle(el).objectFit } })
    assert.equal(image.fit, 'contain', 'image entière, jamais rognée')
  })
})

test('« Arrêter » interrompt le dessin et le dit, sans erreur rouge', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un dragon')
    await page.click('.composer__send')
    await page.waitForSelector('.code-panel__live-stop')
    await page.click('.code-panel__live-stop')
    await page.waitForSelector('.code-panel__done--stopped')
    assert.match(await page.textContent('.code-panel__done'), /Dessin arrêté/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
  })
})

test('ouvrir une image : Enregistrer (habillé par le CSS) et Ouvrir le dossier ; supprimer demande confirmation', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel__thumb img')
    await page.click('.image-panel__thumb >> nth=0')
    await page.waitForSelector('.image-panel__image')
    const save = await page.$eval('.image-panel__save', (el) => getComputedStyle(el).borderTopLeftRadius)
    assert.equal(save, '9999px', 'bouton de la famille de Jaris (pilule, style ChatGPT, étape 266)')
    await page.click('.image-panel__save')
    await page.waitForFunction(() => /Enregistrée/.test(document.querySelector('.image-panel__save').textContent))
    await page.click('text=Ouvrir le dossier')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['open', '2026-09-28T17-22-15-un-chat-sur-la-lune.png'])

    await page.hover('.workspace__item >> nth=0')
    await page.click('.workspace__delete >> nth=0')
    assert.equal((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'delete'), false, 'rien de supprimé sans confirmation')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction(() => !/Un chat sur la lune/.test(document.querySelector('.workspace__rail').textContent))
    assert.equal(await page.locator('.image-panel__image').count(), 0, 'l’image supprimée ne reste pas affichée')
  })
})

test('modèle de dessin absent : l’écran le dit, avec sa taille, et n’installe rien sans clic', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-install__card')
    assert.match(await page.textContent('.image-install__card'), /5,1 Go à télécharger/)
    assert.deepEqual(await page.evaluate(() => window.__calls), [])
    await page.click('.image-install__button')
    await page.evaluate(() => window.__log('Téléchargement de le modèle de dessin (FLUX.2 klein) : 40 %'))
    await page.waitForFunction(() => /40 %/.test(document.body.textContent))
    await page.evaluate(() => window.__finishInstall())
    await page.waitForSelector('.image-panel > .composer')
  }, "window.__status = { supported: true, capable: true, reason: null, installed: false, downloadLabel: '5,1 Go' }")
})

test('PC pas assez puissant : la raison, et aucun bouton d’installation', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-install__card')
    assert.match(await page.textContent('.image-install__card'), /pas assez de puissance.*carte graphique trop petite/)
    assert.equal(await page.locator('.image-install__button').count(), 0)
  }, "window.__status = { supported: true, capable: false, reason: 'carte graphique trop petite (4 Go de VRAM, il en faut 6 ou plus)', installed: false, downloadLabel: '5,1 Go' }")
})
