import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 202 (Léo : « si je fais un prompt à Code, je pars dans Chat ou Vocal et je reviens dans Code, c'est
 * vide et ça travaille encore sur mon processeur »). Sur le VRAI écran Code dans un vrai navigateur : une
 * génération lancée, puis un aller-retour vers un autre onglet — le bandeau d'avancement doit être toujours
 * là au retour, et le résultat arrivé pendant l'absence doit s'afficher.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-keep-alive-entry.tsx')

const ENTRY = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import CodePanel from './src/components/CodePanel'
import KeepAlive from './src/components/KeepAlive'

const APP = { html: '<h1>ok</h1>', path: 'C:/apps/todo', issues: [], previewUrl: 'about:blank' }
window.__mounts = { image: 0 }

window.jaris = {
  onCodeGenStatus: () => () => {},
  onCodeGenProgress: (cb) => { window.__emitProgress = cb; return () => {} },
  getGeneratedApps: () => Promise.resolve([]),
  // Étape 277 : le bouton GitHub du champ demande l'état de la connexion au montage (masqué si indisponible).
  githubStatus: () => Promise.resolve({ available: false, connected: false, login: null }),
  loadGeneratedApp: (path) => Promise.resolve({ ...APP, path }),
  generateApp: () => new Promise((resolve) => { window.__finishGen = () => resolve(APP) }),
  cancelCodeGen: () => {},
  openGeneratedApp: () => Promise.resolve(),
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null, roles: [], thinking: null }),
  setModelChoice: () => Promise.resolve(),
  pickImageFile: () => Promise.resolve(null),
  deleteGeneratedApp: () => Promise.resolve(),
  getProfile: () => Promise.resolve(null)
}

function ImageStandIn() {
  window.__mounts.image += 1
  return <div className="image-stand-in">image</div>
}

function Harness() {
  const [mode, setMode] = useState('code')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <nav>
        <button id="to-code" onClick={() => setMode('code')}>code</button>
        <button id="to-chat" onClick={() => setMode('chat')}>chat</button>
      </nav>
      <main className="app-main">
        {mode === 'chat' && <div className="chat-stand-in">chat</div>}
        <KeepAlive active={mode === 'code'}><CodePanel /></KeepAlive>
        <KeepAlive active={mode === 'image'}><ImageStandIn /></KeepAlive>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-keep-alive-'))
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

async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.setContent(html)
    await page.waitForSelector('.composer__input')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('une génération Code survit à un aller-retour vers un autre onglet', options, async () => {
  await withPage(async (page) => {
    await page.fill('.composer__input', 'une todo list')
    await page.click('.composer__send')
    await page.evaluate(() =>
      window.__emitProgress({ label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 1200, thinking: false, idleMs: 0 })
    )
    await page.waitForSelector('.code-panel__live')

    await page.click('#to-chat')
    await page.waitForSelector('.chat-stand-in')
    assert.equal(await page.isVisible('.code-panel__live'), false, 'caché pendant qu’on est ailleurs')

    await page.click('#to-code')
    assert.equal(await page.isVisible('.code-panel__live'), true, 'l’avancement est toujours là au retour')
    assert.match(await page.textContent('.code-panel__live'), /1\s?200 caractères/)
  })
})

test('le résultat arrivé pendant qu’on était ailleurs s’affiche au retour', options, async () => {
  await withPage(async (page) => {
    await page.fill('.composer__input', 'une todo list')
    await page.click('.composer__send')
    await page.click('#to-chat')
    await page.evaluate(() => window.__finishGen())
    await page.waitForTimeout(100)
    await page.click('#to-code')
    await page.waitForSelector('.code-panel__done')
    assert.match(await page.textContent('.code-panel__done'), /Terminé/)
  })
})

test('un onglet jamais ouvert ne charge rien', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.evaluate(() => window.__mounts.image), 0)
  })
})

test('App.tsx garde Chat, Code et Image en vie au lieu de les détruire', () => {
  const app = readFileSync(join(projectRoot, 'src/App.tsx'), 'utf8')
  for (const panel of ['ChatPanel', 'CodePanel', 'ImagePanel', 'VideoPanel']) {
    assert.doesNotMatch(app, new RegExp(`appMode === '\\w+' && <${panel}`), `${panel} ne doit plus être rendu conditionnellement`)
    // Étape 234 : un ErrorBoundary peut s'intercaler (un écran qui plante ne vide plus tout Jaris).
    assert.match(
      app,
      new RegExp(`<KeepAlive active=\\{(?:!(?:optionsShown|screenShown) && )?appMode === '\\w+'\\}>\\s*(?:<ErrorBoundary [^>]*>\\s*)?<${panel} />`),
      `${panel} dans KeepAlive`
    )
  }
})
