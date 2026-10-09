import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 234 (bêta de Jaris) : ouvrir « Cerveau de Jaris » sur une machine sans WebGL levait « Error creating
 * WebGL context » dans la vue 3D, et l'exception non rattrapée vidait TOUTE la fenêtre (menu compris) — seule
 * issue : redémarrer Jaris. Vrai composant MemoryBrain dans un Chromium dont WebGL est coupé.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-error-boundary-entry.tsx')

const ENTRY = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './src/components/ErrorBoundary'
import MemoryBrain from './src/components/MemoryBrain'

const GRAPH = {
  nodes: [{ id: 'Léo', isCenter: true }, { id: 'Guitare' }, { id: 'Recette crêpes' }],
  links: [{ source: 'Léo', target: 'Guitare' }, { source: 'Léo', target: 'Recette crêpes' }]
}
window.jaris = {
  getMemoryNoteContent: (title) => Promise.resolve('# ' + title + '\\nContenu de la note.'),
  openMemoryFolder: () => {}
}

function Boom({ when }) {
  if (when) throw new Error('écran cassé exprès')
  return <div className="boom-ok">écran normal</div>
}

function Harness() {
  const [brain, setBrain] = useState(false)
  const [broken, setBroken] = useState(false)
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <button id="open-brain" onClick={() => setBrain(true)}>cerveau</button>
        <button id="close-brain" onClick={() => setBrain(false)}>chat</button>
        <button id="break" onClick={() => setBroken(true)}>casser</button>
        <button id="repair" onClick={() => setBroken(false)}>réparer</button>
      </nav>
      {/* Comme dans App.tsx depuis l'étape 265 : le Cerveau est un écran de la zone principale, on en sort par le menu. */}
      <main className="app-main">
        {brain ? (
          <ErrorBoundary label="Le Cerveau de Jaris">
            <MemoryBrain graph={GRAPH} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="Le Chat"><Boom when={broken} /></ErrorBoundary>
        )}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-error-boundary-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      alias: { '@': join(projectRoot, 'src') },
      loader: { '.png': 'dataurl' },
      outfile: bundlePath,
      logLevel: 'error'
    })
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
  // --disable-3d-apis : Chromium refuse alors tout contexte WebGL, comme un pilote graphique qui le bloque.
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, args: ['--disable-3d-apis'] })
  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await page.setViewportSize({ width: 1100, height: 760 })
    await page.setContent(html)
    await page.waitForSelector('#open-brain')
    await run(page, pageErrors)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('Cerveau sans WebGL : la liste des notes remplace la vue 3D, et Jaris reste utilisable', options, async () => {
  await withPage(async (page, pageErrors) => {
    assert.equal(await page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl'))), false)
    await page.click('#open-brain')
    await page.waitForSelector('.memory-brain__fallback')
    assert.match(await page.textContent('.memory-brain__fallback-text'), /3D ne peut pas s'afficher/)
    const items = await page.$$eval('.memory-brain__list-item', (els) => els.map((el) => el.textContent))
    assert.deepEqual(items, ['Guitare', 'Recette crêpes'], 'le nœud central (l’utilisateur) n’est pas une note')
    assert.equal(await page.isVisible('.sidebar'), true, 'le menu ne disparaît plus')
    assert.equal(await page.$('.error-panel'), null, 'rattrapé dans le Cerveau lui-même, pas par le garde général')
    assert.deepEqual(pageErrors, [])

    assert.match(await page.textContent('.memory-brain__header'), /^\s*2 notes/, 'le nœud central n’est pas compté')

    await page.click('.memory-brain__list-item >> text=Guitare')
    await page.waitForFunction(() => document.querySelector('.memory-brain__note-content')?.textContent.includes('Contenu'))
    assert.match(await page.textContent('.memory-brain__note-header'), /Guitare/)
    // La fiche s'ouvre en entier DANS la fenêtre (une règle commune la faisait tomber hors de l'écran).
    const box = await page.$eval('.memory-brain__note', (el) => el.getBoundingClientRect().toJSON())
    assert.ok(box.left >= 0 && box.top >= 0, JSON.stringify(box))
    assert.ok(box.right <= 1100 && box.bottom <= 760, JSON.stringify(box))

    await page.click('#close-brain')
    assert.equal(await page.$('.memory-brain'), null)
  })
})

test('un écran qui plante affiche son message à sa place, sans vider le reste', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.isVisible('.boom-ok'), true)
    await page.click('#break')
    await page.waitForSelector('.error-panel')
    assert.match(await page.textContent('.error-panel__title'), /Le Chat a rencontré un problème/)
    assert.match(await page.textContent('.error-panel__detail'), /écran cassé exprès/)
    assert.equal(await page.isVisible('.sidebar'), true, 'le menu reste là')

    // Les boutons rejoignent la famille partagée (pas le style par défaut du navigateur).
    const style = await page.$eval('.error-panel__actions button', (el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderTopLeftRadius, color: s.color }
    })
    assert.equal(style.radius, '9999px')
    assert.notEqual(style.color, 'rgb(0, 0, 0)')

    // « Réessayer » remonte l'écran une fois la cause disparue.
    await page.click('#repair')
    await page.click('.error-panel__actions button >> text=Réessayer')
    await page.waitForSelector('.boom-ok')
  })
})

test('App.tsx protège chaque écran (et on peut toujours quitter le Cerveau)', () => {
  const app = readFileSync(join(projectRoot, 'src/App.tsx'), 'utf8')
  for (const panel of ['ChatPanel', 'CodePanel', 'ImagePanel', 'VideoPanel', 'OptionsMenu']) {
    assert.match(app, new RegExp(`<ErrorBoundary [^>]*>\\s*<${panel}(?: embedded)?(?: navSlot=\\{[^}]+\\})? />`), `${panel} protégé`)
  }
  assert.match(app, /<ErrorBoundary label="L'Agent vocal">\s*<div className="app app--voice[^"]*"/)
  // Étape 265 : le Cerveau est un écran de la zone principale (plus un calque, qui passait sous les boutons
  // de Windows) — protégé comme les autres, et on en sort toujours par le rail, même s'il a planté.
  assert.match(app, /<ErrorBoundary label="Le Cerveau de Jaris">\s*<MemoryBrain graph=/)
  assert.match(app, /const selectMode = \(id: AppMode\): void => \{[^}]*setMemoryGraph\(null\)/)
})
