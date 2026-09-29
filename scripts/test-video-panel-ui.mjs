import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Mode Vidéo (étape 203, Wan 2.2 TI2V 5B), sur le VRAI composant et le vrai CSS compilé : même présentation que le
 * mode Image, création avec avancement et arrêt, lecteur vidéo, image jointe à animer, et écran d'installation
 * (le modèle, 8,5 Go, ne s'installe qu'à la demande).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-video-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import VideoPanel from './src/components/VideoPanel'

window.__calls = []
window.__status = window.__status || { supported: true, capable: true, reason: null, installed: true, downloadLabel: '8,5 Go' }
window.__videos = window.__videos || [
  { fileName: '2026-09-28T17-22-15-la-mer.webm', label: 'La mer', timestamp: Date.now() - 60000 }
]

window.jaris = {
  getVideoStudioStatus: async () => window.__status,
  installVideoStudio: () => {
    window.__calls.push('install')
    return new Promise((resolve) => { window.__finishInstall = () => { window.__status = { ...window.__status, installed: true }; resolve() } })
  },
  onVideoStudioLog: (cb) => { window.__log = cb; return () => {} },
  generateStudioVideo: (prompt, image) => {
    window.__calls.push(['generate', prompt, image ? image.mimeType : null])
    return new Promise((resolve, reject) => {
      window.__finishGen = () => {
        const video = { fileName: '2026-09-28T18-00-00-un-chat.webm', label: 'Un chat', timestamp: Date.now() }
        window.__videos = [video, ...window.__videos]
        resolve(video)
      }
      window.__failGen = (message) => reject(new Error(message))
    })
  },
  cancelStudioVideo: () => { window.__calls.push('cancel'); window.__failGen('Vidéo annulée.') },
  listGeneratedVideos: async () => window.__videos,
  readGeneratedVideo: async (fileName) => { window.__calls.push(['read', fileName]); return new Uint8Array([26, 69, 223, 163]) },
  deleteGeneratedVideo: async (fileName) => { window.__calls.push(['delete', fileName]); window.__videos = window.__videos.filter((v) => v.fileName !== fileName) },
  openGeneratedVideos: async (fileName) => { window.__calls.push(['open', fileName]) },
  saveGeneratedVideo: async (fileName) => { window.__calls.push(['save', fileName]); return { saved: true } },
  // Un vrai petit PNG (1x1) « choisi » dans le sélecteur natif.
  pickImageFile: async () => ({ name: 'chat.png', type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg==' }),
  getProfile: async () => null
}

createRoot(document.getElementById('root')).render(<VideoPanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-video-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath })
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

test('accueil : même présentation que le mode Image (liste à gauche, champ en bas, « + » pour joindre une image)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    assert.match(await page.textContent('.workspace__new'), /Nouvelle vidéo/i)
    assert.match(await page.textContent('.workspace__rail'), /La mer/)
    const last = await page.$eval('.video-panel > .composer', (el) => el === el.parentElement.lastElementChild)
    assert.equal(last, true, 'le champ est en bas')
    assert.equal(await page.locator('.composer__plus').count(), 1, 'une image peut être jointe pour l’animer')
  })
})

test('créer : avancement avec barre, puis la vidéo se lit et rejoint la liste', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un chat roux marche dans la neige')
    await page.click('.composer__send')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate'), ['generate', 'un chat roux marche dans la neige', null])
    await page.evaluate(() => window.__log('Vidéo : étape 5 sur 20'))
    await page.waitForFunction(() => /Vidéo : étape 5 sur 20/.test(document.querySelector('.code-panel__live').textContent))
    assert.equal(await page.$eval('.image-panel__progress .options-menu__progress-bar-fill', (el) => el.style.width), '25%')

    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('video.video-panel__video')
    assert.match(await page.textContent('.code-panel__done'), /ta vidéo est prête/)
    assert.match(await page.textContent('.workspace__rail'), /Un chat/)
    const video = await page.$eval('video.video-panel__video', (el) => ({ src: el.src, controls: el.controls, loop: el.loop, fit: getComputedStyle(el).objectFit }))
    assert.match(video.src, /^blob:/, 'lue depuis des octets locaux, jamais un chemin de fichier')
    assert.equal(video.controls, true)
    assert.equal(video.fit, 'contain')

    await page.click('.image-panel__save')
    await page.waitForFunction(() => /Enregistrée/.test(document.querySelector('.image-panel__save').textContent))
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'save' && c[1] === '2026-09-28T18-00-00-un-chat.webm'))
  })
})

test('image jointe : envoyée avec la description pour être animée', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__plus')
    await page.click('.composer__plus')
    await page.getByText('Joindre une image').click()
    await page.waitForFunction(() => /mouvement/.test(document.querySelector('.composer__input').placeholder))
    await page.fill('.composer__input', 'le chat se met à marcher')
    await page.click('.composer__send')
    const call = (await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate')
    assert.equal(call[1], 'le chat se met à marcher')
    assert.match(call[2], /^image\//, 'le type de l’image jointe est transmis')
  })
})

test('« Arrêter » interrompt la vidéo et le dit, sans erreur rouge', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un dragon')
    await page.click('.composer__send')
    await page.click('.code-panel__live-stop')
    await page.waitForSelector('.code-panel__done--stopped')
    assert.match(await page.textContent('.code-panel__done'), /Vidéo arrêtée/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
  })
})

test('modèle absent : écran d’installation qui annonce la taille et la lenteur, puis la création s’ouvre', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.image-install__button')
      assert.match(await page.textContent('.image-install__card'), /8,5 Go à télécharger.*plusieurs minutes par\s+vidéo/s)
      assert.equal(await page.locator('.composer').count(), 0)
      await page.click('.image-install__button')
      await page.evaluate(() => window.__finishInstall())
      await page.waitForSelector('.composer__input')
    },
    "window.__status = { supported: true, capable: true, reason: null, installed: false, downloadLabel: '8,5 Go' }"
  )
})

test('PC trop faible : la raison est affichée, aucun bouton d’installation', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.image-install__card')
      assert.match(await page.textContent('.image-install__card'), /carte graphique trop petite/)
      assert.equal(await page.locator('.image-install__button').count(), 0)
    },
    "window.__status = { supported: true, capable: false, reason: 'carte graphique trop petite (6 Go de VRAM, il en faut 8 ou plus)', installed: false, downloadLabel: '8,5 Go' }"
  )
})
