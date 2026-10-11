import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 294 — l'écran de démarrage (vrai composant StartupSplash + vrai CSS compilé) : il dit l'étape en cours dans la
 * langue de Jaris, la barre avance avec les étapes terminées, et quand tout est prêt la carte s'efface VRAIMENT
 * (opacité mesurée), puisque c'est juste après que Jaris apparaît à sa place.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = `
import { createRoot } from 'react-dom/client'
import StartupSplash from './src/components/StartupSplash'
import { initRendererLanguage } from './src/lib/i18n'
let listener = null
window.jaris = new Proxy({}, { get: (_target, name) => {
  if (name === 'getLanguageState') return () => window.__lang ?? null
  if (name === 'getStartupState') return async () => window.__state ?? null
  if (name === 'onStartupState') return (cb) => { listener = cb; return () => {} }
  if (typeof name === 'string' && name.startsWith('on')) return () => () => {}
  return async () => null
}})
window.__push = (state) => listener && listener(state)
initRendererLanguage()
createRoot(document.getElementById('root')).render(<StartupSplash />)
`

let bundle = null
function buildBundle() {
  if (bundle) return bundle
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-splash-'))
  const entryPath = join(projectRoot, 'tmp-startup-splash-entry.tsx')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: join(outDir, 'bundle.js'), logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  bundle = readFileSync(join(outDir, 'bundle.js'), 'utf8')
  return bundle
}

const steps = (states) => ['engine', 'listening', 'voice', 'brain'].map((id, i) => ({ id, state: states[i] }))
const state = (states, ready = false) => ({ ready, timedOut: false, steps: steps(states) })

const mainSource = readFileSync(join(projectRoot, 'electron/main.ts'), 'utf8')
const SPLASH = {
  width: Number(/const SPLASH_WIDTH = (\d+)/.exec(mainSource)[1]),
  height: Number(/const SPLASH_HEIGHT = (\d+)/.exec(mainSource)[1])
}

async function withSplash(initial, lang, run) {
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  const messages = lang === 'fr' ? {} : JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${lang}.json`), 'utf8'))
  const init = `<script>window.__state=${JSON.stringify(initial)};window.__lang=${JSON.stringify({ code: lang, setting: lang, systemCode: lang, messages }).replace(/</g, '\\u003c')}</script>`
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize(SPLASH)
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div>${init}<script>${buildBundle()}</script></body></html>`)
    await page.waitForSelector('.startup__card')
    await run(page)
  } finally {
    await browser.close()
  }
}

const fillScale = (page) =>
  page.$eval('.startup__bar-fill', (el) => {
    const m = /scaleX\(([\d.]+)\)/.exec(el.style.transform)
    return m ? Number(m[1]) : null
  })

test('l’étape en cours est annoncée dans l’ordre, la barre avance, puis « Prêt »', options, async () => {
  await withSplash(state(['running', 'running', 'running', 'running']), 'fr', async (page) => {
    await page.waitForFunction(() => document.querySelector('.startup__step')?.textContent === 'Démarrage du moteur…')
    assert.equal(await fillScale(page), 0)

    await page.evaluate((s) => window.__push(s), state(['done', 'running', 'done', 'running']))
    await page.waitForFunction(() => document.querySelector('.startup__step')?.textContent === "Préparation de l'écoute…")
    assert.equal(await fillScale(page), 0.5)

    // Un échec compte comme terminé : l'écran passe à la suite au lieu de rester bloqué dessus.
    await page.evaluate((s) => window.__push(s), state(['done', 'failed', 'done', 'running']))
    await page.waitForFunction(() => document.querySelector('.startup__step')?.textContent === 'Chargement du modèle…')

    await page.evaluate((s) => window.__push(s), state(['done', 'failed', 'done', 'done'], true))
    await page.waitForFunction(() => document.querySelector('.startup__step')?.textContent === 'Prêt')
    assert.equal(await fillScale(page), 1)
  })
})

test('quand tout est prêt, la carte s’efface vraiment (Jaris apparaît juste après à sa place)', options, async () => {
  await withSplash(state(['done', 'done', 'done', 'running']), 'fr', async (page) => {
    await page.waitForTimeout(500)
    assert.equal(await page.$eval('.startup__card', (el) => Number(getComputedStyle(el).opacity)), 1, 'visible pendant l’attente')
    await page.evaluate((s) => window.__push(s), state(['done', 'done', 'done', 'done'], true))
    await page.waitForSelector('.startup--leaving')
    // La sortie dure moins que le délai laissé par le processus principal avant d'afficher Jaris (SPLASH_EXIT_MS).
    await page.waitForTimeout(360)
    const opacity = await page.$eval('.startup__card', (el) => Number(getComputedStyle(el).opacity))
    assert.ok(opacity < 0.05, `opacité ${opacity} à la fin de la sortie`)
  })
  const exitMs = Number(/const SPLASH_EXIT_MS = (\d+)/.exec(mainSource)?.[1])
  const css = readFileSync(join(projectRoot, 'src/index.css'), 'utf8')
  const outMs = Number(/\.startup--leaving \.startup__card \{\s*animation: startup-out (\d+)ms/.exec(css)?.[1])
  assert.ok(outMs > 0 && exitMs > outMs, `sortie ${outMs} ms, Jaris affiché après ${exitMs} ms`)
})

test('dans la langue de Jaris (ici l’allemand), sans un mot de français', options, async () => {
  await withSplash(state(['done', 'running', 'running', 'running']), 'de', async (page) => {
    await page.waitForFunction(() => document.querySelector('.startup__step')?.textContent === 'Zuhören wird vorbereitet…')
    assert.equal(await page.$eval('.startup__card', (el) => el.getAttribute('aria-label')), 'Jaris startet')
  })
})

test('la carte est décollée des bords de la fenêtre transparente (coins arrondis propres sous Windows)', options, async () => {
  await withSplash(state(['running', 'running', 'running', 'running']), 'fr', async (page) => {
    // Mesure APRÈS les animations d'entrée (la carte et l'orbe grandissent en apparaissant).
    await page.waitForTimeout(800)
    const box = await page.$eval('.startup__card', (el) => el.getBoundingClientRect().toJSON())
    assert.ok(box.x >= 12 && box.y >= 12 && box.right <= SPLASH.width - 12 && box.bottom <= SPLASH.height - 12, JSON.stringify(box))
    // Étape 295 : l'orbe agrandi tient dans la carte, sans pousser le texte ni le trait hors du cadre.
    const orb = await page.$eval('.startup__card .jaris-orb, .startup__card canvas', (el) => el.getBoundingClientRect().toJSON())
    assert.ok(orb.width >= 170, `orbe de ${orb.width}px`)
    const bar = await page.$eval('.startup__bar', (el) => el.getBoundingClientRect().toJSON())
    assert.ok(orb.top >= box.y && bar.bottom <= box.bottom - 16, JSON.stringify({ orb, bar, box }))
    assert.equal(await page.$eval('body', (el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'fond transparent')
  })
})
