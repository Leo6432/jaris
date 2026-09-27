import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Écran du Montage (étape 189), sur le VRAI composant et le vrai CSS compilé. Léo : « un bouton montage à
 * gauche qui n'est pas installé par défaut, faut cliquer et il te dit que c'est lourd ».
 *
 * Vérifie : rien n'est téléchargé avant le clic, l'avertissement dit le poids et la licence, l'installation
 * montre son avancement, puis une vidéo fabriquée s'affiche dans un lecteur avec un bouton « Enregistrer »
 * réellement habillé par le CSS de Jaris.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-montage-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import MontagePanel from './src/components/MontagePanel'

window.__installed = window.__preinstalled === true
window.__calls = []
const VIDEO = { path: 'C:/donnees/generated-videos/1-intro', code: 'export const Video = () => null', hasVideo: true }

window.jaris = {
  getMontageStatus: async () => ({ installed: window.__installed, supported: true }),
  installMontage: () => {
    window.__calls.push('install')
    return new Promise((resolve) => { window.__finishInstall = () => { window.__installed = true; resolve() } })
  },
  onMontageInstallProgress: (cb) => { window.__installProgress = cb; return () => {} },
  uninstallMontage: async () => { window.__calls.push('uninstall'); window.__installed = false },
  onMontageGenStatus: () => () => {},
  onMontageGenProgress: (cb) => { window.__genProgress = cb; return () => {} },
  generateMontage: (description, currentCode) => {
    window.__calls.push(['generate', description, currentCode ?? null])
    return new Promise((resolve) => { window.__finishGen = () => resolve(VIDEO) })
  },
  cancelMontageGen: () => {},
  getGeneratedVideos: async () => (window.__installed ? [{ path: VIDEO.path, label: 'intro', timestamp: Date.now() }] : []),
  loadGeneratedVideo: async (path) => ({ ...VIDEO, path }),
  readGeneratedVideo: async () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  deleteGeneratedVideo: async () => {},
  saveGeneratedVideo: async (path) => { window.__calls.push(['save', path]); return { saved: true } },
  openGeneratedVideos: async () => {},
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null }),
  setModelChoice: () => Promise.resolve(),
  getProfile: async () => null,
  pickImageFile: () => Promise.resolve(null)
}

createRoot(document.getElementById('root')).render(<MontagePanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-montage-ui-'))
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

async function withPage(run, { installed = false } = {}) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.setContent(installed ? html.replace('<body>', '<body><script>window.__preinstalled = true</script>') : html)
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('pas installé : l’écran dit que c’est lourd, ce que ça pèse et la licence, SANS rien télécharger', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.montage-install__card')
    const text = await page.textContent('.montage-install__card')
    assert.match(text, /C'est lourd/)
    assert.match(text, /environ 200 Mo à télécharger et environ 600 Mo sur le disque/)
    assert.match(text, /Licence Remotion/)
    assert.match(text, /plus de 3 personnes/)
    assert.deepEqual(await page.evaluate(() => window.__calls), [], 'aucune installation sans clic')
    assert.equal(await page.locator('.composer').count(), 0, 'pas de champ tant que rien n’est installé')

    const button = await page.$eval('.montage-install__button', (el) => {
      const style = getComputedStyle(el)
      return { clip: style.clipPath, family: style.fontFamily }
    })
    assert.match(button.clip, /polygon/, 'bouton de la famille de Jaris (coins coupés), pas le style du navigateur')
    assert.match(button.family, /Rajdhani/)
  })
})

test('installer montre son avancement, puis ouvre le Montage', options, async () => {
  await withPage(async (page) => {
    await page.click('.montage-install__button')
    assert.deepEqual(await page.evaluate(() => window.__calls), ['install'])
    await page.evaluate(() => window.__installProgress({ phase: 'download', percent: 42 }))
    await page.waitForFunction(() => /Téléchargement de Remotion : 42 %/.test(document.body.textContent))
    const width = await page.$eval('.options-menu__progress-bar-fill', (el) => el.style.width)
    assert.equal(width, '42%')
    await page.evaluate(() => window.__installProgress({ phase: 'browser', percent: 7 }))
    await page.waitForFunction(() => /navigateur qui filme les vidéos : 7 %/.test(document.body.textContent))

    await page.evaluate(() => window.__finishInstall())
    await page.waitForSelector('.workspace__rail')
    assert.match(await page.textContent('.workspace__new'), /Nouvelle vidéo/i)
    assert.equal(await page.locator('.composer__attach').count(), 0, 'pas de bouton image : le Montage ne lit pas encore d’image')
  })
})

test('une vidéo fabriquée s’affiche dans un lecteur, avec un bouton Enregistrer habillé par le CSS', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.workspace__rail')
    await page.fill('.composer__input', 'Intro de 6 secondes, titre JARIS')
    await page.click('.composer__send')
    await page.evaluate(() =>
      window.__genProgress({ label: 'Fabrication de la vidéo (Remotion)', stepIndex: 2, stepCount: 2, charsWritten: 0, thinking: false, idleMs: 0, percent: 55 })
    )
    await page.waitForFunction(() => /Étape 2 sur 2 · Fabrication de la vidéo/.test(document.body.textContent) && /55 %/.test(document.body.textContent))
    await page.evaluate(() => window.__finishGen())

    await page.waitForSelector('video.montage-panel__video')
    assert.match(await page.$eval('video.montage-panel__video', (el) => el.getAttribute('src')), /^blob:/)
    assert.match(await page.textContent('.code-panel__done'), /ta vidéo est prête/)

    const save = await page.$eval('.montage-panel__save', (el) => ({ clip: getComputedStyle(el).clipPath, text: el.textContent }))
    assert.match(save.clip, /polygon/)
    await page.click('.montage-panel__save')
    await page.waitForFunction(() => /Enregistrée/.test(document.querySelector('.montage-panel__save').textContent))

    // Une modification envoie le code actuel avec la demande.
    await page.fill('.composer__input', 'titre plus gros')
    await page.click('.composer__send')
    const calls = await page.evaluate(() => window.__calls.filter((c) => Array.isArray(c) && c[0] === 'generate'))
    assert.deepEqual(calls.at(-1), ['generate', 'titre plus gros', 'export const Video = () => null'])
  }, { installed: true })
})

test('désinstaller demande confirmation dans la page, puis revient à l’écran d’installation', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.montage-panel__uninstall-link')
    await page.click('.montage-panel__uninstall-link')
    assert.deepEqual(await page.evaluate(() => window.__calls), [], 'rien de retiré avant la confirmation')
    assert.match(await page.textContent('.montage-panel__uninstall'), /Tes vidéos restent/)
    await page.click('.montage-panel__uninstall-yes')
    await page.waitForSelector('.montage-install__card')
    assert.deepEqual(await page.evaluate(() => window.__calls), ['uninstall'])
  }, { installed: true })
})
