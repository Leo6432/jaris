import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 450 (Léo : « dans le mode Vocal du duel, parler et pas écrire, mais toujours le duel avec 2 modèles ») : en
 * Duel Vocal, un clic sur l'orbe enregistre (vrai micro simulé par Chromium), un second arrête ; la question transcrite
 * part TOUTE SEULE aux deux modèles (duelAsk), sans passer par le champ ni par « Envoyer ». Vrai DuelPanel, CSS compilé.
 * Hors Vocal (Conversation), pas d'orbe : la question s'écrit comme avant.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-duel-voice-ask-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import DuelPanel from './src/components/DuelPanel'

window.__calls = []
const side = () => ({ status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null })
const view = (round) => ({ id: 'session-1', category: window.__category || 'voice', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null, round })
window.__view = view({ number: 1, prompt: null, a: side(), b: side() })
const plan = {
  category: 'voice', available: 6, freeDiskGb: 120, downloadBudgetGb: 115,
  sizes: [{ count: 4, toDownload: 0, downloadGb: 0, fitsDisk: true }],
  models: [{ model: 'granite4.2:8b', vramGb: 5.2, reason: null, installed: true }, { model: 'qwen3.5:9b', vramGb: 6.6, reason: null, installed: true }]
}
const known = {
  duelState: async () => window.__view,
  duelPlan: async (category) => ({ ...plan, category }),
  duelRankings: async () => [{ category: 'conversation', votes: 0, pending: 0, ranking: [] }, { category: 'code', votes: 0, pending: 0, ranking: [] }, { category: 'voice', votes: 0, pending: 0, ranking: [] }],
  duelHistory: async () => [],
  duelAsk: async (prompt) => {
    window.__calls.push(['ask', prompt])
    return (window.__view = view({ number: 1, prompt, a: { ...side(), status: 'running', startedAt: Date.now() }, b: side() }))
  },
  transcribeDictation: async (wav) => {
    window.__calls.push(['transcribe', wav.length])
    return window.__transcript ?? 'Quelle heure est-il ?'
  },
  getProfile: async () => ({ name: 'Léo' })
}
window.jaris = new Proxy(known, {
  get: (target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in target) return target[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})
createRoot(document.getElementById('root')).render(<DuelPanel />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-duel-voice-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#root{height:100%;display:flex}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** Un faux micro (son de test de Chromium), page servie depuis http://localhost (getUserMedia exige un contexte sûr). */
async function withPage(run, init = '') {
  const html = buildPage()
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    if (init) await page.addInitScript(init)
    await page.route('http://localhost/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
    await page.goto('http://localhost/')
    await run(page)
  } finally {
    await browser.close()
  }
}

test('Duel Vocal : un clic sur l’orbe écoute, un second envoie la question dite aux deux modèles', options, async () => {
  await withPage(async (page) => {
    const orb = page.locator('.duel-voice-ask [role="button"]')
    await orb.waitFor()
    assert.match(await page.textContent('.duel-voice-ask__status'), /pose ta question à voix haute/)
    assert.equal(await orb.getAttribute('aria-label'), 'Poser la question à voix haute')
    // Le champ texte reste là, en secours (micro absent ou en panne).
    assert.equal(await page.locator('.composer__input').count(), 1)
    await orb.click()
    await page.waitForSelector('.duel-voice-ask--recording')
    assert.match(await page.textContent('.duel-voice-ask__status'), /Je t’écoute|Je t'écoute/)
    await page.waitForTimeout(900)
    await page.locator('.duel-voice-ask [role="button"]').click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'ask'))
    const calls = await page.evaluate(() => window.__calls)
    assert.ok(calls.some((c) => c[0] === 'transcribe' && c[1] > 44), 'le son enregistré part à la transcription')
    assert.deepEqual(calls.find((c) => c[0] === 'ask'), ['ask', 'Quelle heure est-il ?'], 'la question dite part telle quelle, sans « Envoyer »')
    // La question posée : plus d'orbe de question (le duel tourne).
    await page.waitForFunction(() => !document.querySelector('.duel-voice-ask'))
  })
})

test('Duel Conversation : pas d’orbe, la question s’écrit comme avant', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    assert.equal(await page.locator('.duel-voice-ask').count(), 0)
  }, "window.__category = 'conversation'")
})
