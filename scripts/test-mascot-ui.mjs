import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * La mascotte de Jaris (étape 144, src/components/JarisOrb.tsx) dans un vrai navigateur, avec le vrai CSS
 * compilé : chaque humeur se voit sur le visage (pas seulement dans une classe), les petites tailles
 * restent un visage lisible, la couleur d'une voix s'applique, et un clic déclenche bien l'écoute.
 * Playwright absent : tests ignorés, jamais verts en silence.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-mascot-entry.tsx')
const ENTRY = `
import { createRoot } from 'react-dom/client'
import JarisOrb from './src/components/JarisOrb'
window.__clicks = 0
const emotions = ['idle', 'listening', 'thinking', 'happy', 'surprised']
createRoot(document.getElementById('root')).render(
  <div>
    {emotions.map((e) => <div key={e} id={'m-' + e}><JarisOrb emotion={e} size={160} /></div>)}
    <div id="m-small"><JarisOrb emotion="idle" size={24} /></div>
    <div id="m-voice"><JarisOrb emotion="idle" size={100} color="#e07a5f" /></div>
    <div id="m-click"><JarisOrb emotion="idle" size={120} onClick={() => { window.__clicks++ }} /></div>
  </div>
)
`

let html = null
function buildPage() {
  if (html) return html
  const out = mkdtempSync(join(tmpdir(), 'jaris-mascot-'))
  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync('npx', ['esbuild', entryPath, '--bundle', '--format=iife', '--loader:.tsx=tsx', '--jsx=automatic', `--alias:@=${join(projectRoot, 'src')}`, `--outfile=${join(out, 'b.js')}`], { cwd: projectRoot, stdio: 'pipe' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  html = `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${readFileSync(join(out, 'b.js'), 'utf8')}</script></body></html>`
  rmSync(out, { recursive: true, force: true })
  return html
}

async function withPage(run) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(buildPage())
    await page.waitForSelector('#m-click svg')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('chaque humeur change vraiment le visage : antenne, bouche, petits points de réflexion', options, async () => {
  await withPage(async (page) => {
    const look = await page.evaluate(() =>
      Object.fromEntries(
        ['idle', 'listening', 'thinking', 'happy', 'surprised'].map((e) => {
          const root = document.querySelector('#m-' + e)
          return [
            e,
            {
              bulb: root.querySelector('.jaris-mascot__bulb').getAttribute('fill'),
              smile: Boolean(root.querySelector('.jaris-mascot__mouth')),
              open: Boolean(root.querySelector('.jaris-mascot__mouth-open')),
              o: Boolean(root.querySelector('.jaris-mascot__mouth-o')),
              dots: Boolean(root.querySelector('.jaris-mascot__dots'))
            }
          ]
        })
      )
    )
    assert.equal(look.listening.bulb, '#34c27a', 'antenne verte quand Jaris écoute')
    assert.notEqual(look.idle.bulb, look.listening.bulb)
    assert.ok(look.thinking.dots && !look.idle.dots, 'petits points seulement quand il réfléchit')
    assert.ok(look.happy.open && !look.happy.smile, 'sourire ouvert quand il répond')
    assert.ok(look.surprised.o, 'bouche en « o » quand il est surpris')
    assert.ok(look.idle.smile)
  })
})

test('en tout petit (widget replié), un visage lisible sans antenne ni joues', options, async () => {
  await withPage(async (page) => {
    const small = await page.evaluate(() => {
      const root = document.querySelector('#m-small')
      const box = { width: root.querySelector('.jaris-orb').offsetWidth } // taille de mise en page : l'animation d'apparition (zoom) ne la fausse pas
      return { antenna: Boolean(root.querySelector('.jaris-mascot__antenna')), cheeks: root.querySelectorAll('.jaris-mascot__cheek').length, eyes: root.querySelectorAll('.jaris-mascot__eye').length, w: box.width }
    })
    assert.equal(small.antenna, false)
    assert.equal(small.cheeks, 0)
    assert.equal(small.eyes, 2)
    assert.equal(Math.round(small.w), 24)
  })
})

test('la couleur d’une voix s’applique au corps, le reste du visage ne change pas', options, async () => {
  await withPage(async (page) => {
    const stop = await page.evaluate(() => document.querySelector('#m-voice radialGradient stop:last-child').getAttribute('stop-color'))
    assert.equal(stop, '#e07a5f')
    const face = await page.evaluate(() => getComputedStyle(document.querySelector('#m-voice .jaris-mascot__face')).fill)
    assert.equal(face, 'rgb(255, 255, 255)', 'le visage reste blanc (le CSS de la mascotte est bien appliqué)')
  })
})

test('cliquer sur Jaris déclenche bien l’action (activer l’écoute)', options, async () => {
  await withPage(async (page) => {
    await page.locator('#m-click svg').click()
    assert.equal(await page.evaluate(() => window.__clicks), 1)
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#m-click .jaris-orb')).cursor), 'pointer')
  })
})
