import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * La mascotte de Jaris (étapes 144-145, src/components/JarisOrb.tsx : une bulle bleue à deux yeux blancs) dans un vrai navigateur, avec le vrai CSS
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

test('chaque humeur change vraiment la bulle : halo, yeux, bulles de pensée', options, async () => {
  await withPage(async (page) => {
    const look = await page.evaluate(() =>
      Object.fromEntries(
        ['idle', 'listening', 'thinking', 'happy', 'surprised'].map((e) => {
          const root = document.querySelector('#m-' + e)
          const eye = root.querySelector('.jaris-mascot__eye')
          return [
            e,
            {
              halo: getComputedStyle(root.querySelector('.jaris-mascot__halo')).animationName,
              eyes: root.querySelectorAll('.jaris-mascot__eye').length,
              happyEyes: root.querySelectorAll('.jaris-mascot__eyes--happy path').length,
              eyeTransform: eye ? getComputedStyle(eye).transform : null,
              dots: Boolean(root.querySelector('.jaris-mascot__dots'))
            }
          ]
        })
      )
    )
    assert.equal(look.listening.halo, 'mascot-halo', 'halo qui pulse quand Jaris écoute')
    assert.equal(look.idle.halo, 'none', 'pas de halo au repos')
    assert.ok(look.thinking.dots && !look.idle.dots, 'bulles de pensée seulement quand il réfléchit')
    assert.equal(look.happy.happyEyes, 2, 'yeux plissés en sourire quand il répond')
    assert.equal(look.happy.eyes, 0)
    assert.equal(look.idle.eyes, 2, 'deux yeux ovales au repos')
    assert.equal(look.surprised.eyes, 2)
    assert.notEqual(look.surprised.eyeTransform, look.idle.eyeTransform, 'yeux agrandis quand il est surpris')
  })
})

test('au repos, les yeux regardent vraiment ailleurs de temps en temps ; à l’écoute, ils restent fixés sur toi', options, async () => {
  await withPage(async (page) => {
    const gaze = await page.evaluate(() => {
      const at = (id, ms) => {
        const el = document.querySelector(id + ' .jaris-mascot__gaze')
        const anim = el.getAnimations().find((a) => a.animationName === 'mascot-gaze')
        if (!anim) return getComputedStyle(el).transform
        anim.pause()
        anim.currentTime = ms
        return getComputedStyle(el).transform
      }
      return {
        idleStart: at('#m-idle', 0),
        idleLookRight: at('#m-idle', 4400), // ~40 % de l'animation : coup d'œil en haut à droite
        idleLookLeft: at('#m-idle', 7800), // ~71 % : coup d'œil à gauche
        listening: at('#m-listening', 4400),
        thinking: getComputedStyle(document.querySelector('#m-thinking .jaris-mascot__gaze')).transform
      }
    })
    const tx = (m) => (m === 'none' ? 0 : Number(m.match(/matrix\(([^)]+)\)/)[1].split(',')[4]))
    assert.equal(tx(gaze.idleStart), 0, 'regard centré au départ')
    assert.ok(tx(gaze.idleLookRight) > 4, `coup d’œil à droite attendu, obtenu ${gaze.idleLookRight}`)
    assert.ok(tx(gaze.idleLookLeft) < -4, `coup d’œil à gauche attendu, obtenu ${gaze.idleLookLeft}`)
    assert.equal(tx(gaze.listening), 0, 'à l’écoute, le regard ne se promène pas')
    assert.ok(tx(gaze.thinking) > 4, 'en réfléchissant, il regarde en l’air sur le côté')
  })
})

test('en tout petit (widget replié), la bulle et ses deux yeux, sans ombre ni bulles de pensée', options, async () => {
  await withPage(async (page) => {
    const small = await page.evaluate(() => {
      const root = document.querySelector('#m-small')
      return {
        shadow: Boolean(root.querySelector('.jaris-mascot__shadow')),
        eyes: root.querySelectorAll('.jaris-mascot__eye').length,
        w: root.querySelector('.jaris-orb').offsetWidth // taille de mise en page : l'animation d'apparition (zoom) ne la fausse pas
      }
    })
    assert.equal(small.shadow, false)
    assert.equal(small.eyes, 2)
    assert.equal(Math.round(small.w), 24)
  })
})

test('la couleur d’une voix s’applique à la bulle, les yeux restent blancs', options, async () => {
  await withPage(async (page) => {
    const stop = await page.evaluate(() => document.querySelector('#m-voice radialGradient stop:nth-child(2)').getAttribute('stop-color'))
    assert.equal(stop, '#e07a5f')
    const eye = await page.evaluate(() => getComputedStyle(document.querySelector('#m-voice .jaris-mascot__eye')).fill)
    assert.equal(eye, 'rgb(255, 255, 255)', 'les yeux restent blancs (le CSS de la mascotte est bien appliqué)')
  })
})

test('cliquer sur Jaris déclenche bien l’action (activer l’écoute)', options, async () => {
  await withPage(async (page) => {
    await page.locator('#m-click svg').click()
    assert.equal(await page.evaluate(() => window.__clicks), 1)
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#m-click .jaris-orb')).cursor), 'pointer')
  })
})
