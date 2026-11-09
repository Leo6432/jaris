import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 450 (Léo : « le Duel Vocal doit être vocal comme le Vocal : le modèle répond en vocal, comme le Vocal, et un
 * bouton envoie le même prompt dit à voix haute au second ») : vrai DuelPanel, CSS compilé, faux micro de Chromium.
 * - Avant la question : la scène de l'Agent vocal (grand orbe), pas de cartes ni de champ (« Écrire plutôt » en
 *   secours). Un clic sur l'orbe écoute, un second envoie la question transcrite à duelAsk, sans « Envoyer ».
 * - Le modèle A a répondu : sa réponse se lit à voix haute (play) et s'affiche en sous-titres ; « Poser la même
 *   question au modèle B » appelle duelRunB. Les deux ont répondu : « Réécouter A/B » et le vote, comme avant.
 * Hors Vocal (Conversation), rien de tout ça : la question s'écrit comme avant.
 * Avec SHOTS=<dossier>, des captures de chaque étape y sont enregistrées (pour les montrer à Léo).
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
window.__media = []
HTMLMediaElement.prototype.play = function () { window.__media.push('play'); return Promise.resolve() }
HTMLMediaElement.prototype.pause = function () { window.__media.push('pause') }
const side = (extra = {}) => ({ status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null, ...extra })
const said = (text) => side({ status: 'done', text, durationMs: 2000, audio: true })
window.__side = side
window.__said = said
const view = (round) => ({ id: 'session-1', category: window.__category || 'voice', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null, round })
window.__makeView = view
window.__view = window.__initialRound ? view(window.__initialRound) : view({ number: 1, prompt: null, a: side(), b: side() })
const listeners = []
window.__emit = (next) => { window.__view = next; listeners.forEach((cb) => cb(next)) }
const plan = {
  category: 'voice', available: 6, freeDiskGb: 120, downloadBudgetGb: 115,
  sizes: [{ count: 4, toDownload: 0, downloadGb: 0, fitsDisk: true }],
  models: [{ model: 'granite4.2:8b', vramGb: 5.2, reason: null, installed: true }, { model: 'qwen3.5:9b', vramGb: 6.6, reason: null, installed: true }]
}
const known = {
  onDuelChanged: (cb) => { listeners.push(cb); return () => {} },
  duelState: async () => window.__view,
  duelPlan: async (category) => ({ ...plan, category }),
  duelRankings: async () => [{ category: 'conversation', votes: 0, pending: 0, ranking: [] }, { category: 'code', votes: 0, pending: 0, ranking: [] }, { category: 'voice', votes: 0, pending: 0, ranking: [] }],
  duelHistory: async () => [],
  duelAudio: async () => new Uint8Array([82, 73, 70, 70]),
  duelAsk: async (prompt) => {
    window.__calls.push(['ask', prompt])
    return (window.__view = view({ number: 1, prompt, a: side({ status: 'running', startedAt: Date.now(), activity: { kind: 'thinking' } }), b: side() }))
  },
  duelRunB: async () => {
    window.__calls.push('runB')
    const r = window.__view.round
    return (window.__view = view({ ...r, b: side({ status: 'running', startedAt: Date.now(), activity: { kind: 'thinking' } }) }))
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
async function withPage(run, init = '', colorScheme = 'dark') {
  const html = buildPage()
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, colorScheme })
    if (init) await page.addInitScript(init)
    await page.route('http://localhost/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
    await page.goto('http://localhost/')
    await run(page)
  } finally {
    await browser.close()
  }
}

const shot = async (page, name) => {
  if (!process.env.SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) })
}

test('Duel Vocal : on parle à l’orbe comme au Vocal, la question part toute seule ; pas de cartes ni de champ', options, async () => {
  await withPage(async (page) => {
    const orb = page.locator('.duel-voice [role="button"]')
    await orb.waitFor()
    assert.equal((await page.textContent('.duel-voice .app__status')).trim(), 'Pose ta question à voix haute')
    assert.equal(await orb.getAttribute('aria-label'), 'Poser la question à voix haute')
    assert.equal(await page.locator('.duel-side').count(), 0, 'pas de cartes de texte en Vocal')
    assert.equal(await page.locator('.composer__input').count(), 0, 'pas de champ : on parle')
    assert.equal(await page.locator('button', { hasText: 'Écrire plutôt' }).count(), 1, 'le champ reste possible en secours')
    await shot(page, '1-question')
    await orb.click()
    await page.waitForSelector('.duel-voice--recording')
    assert.match(await page.textContent('.duel-voice .app__status'), /écoute/)
    await shot(page, '2-ecoute')
    await page.waitForTimeout(900)
    await page.locator('.duel-voice [role="button"]').click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'ask'))
    const calls = await page.evaluate(() => window.__calls)
    assert.ok(calls.some((c) => c[0] === 'transcribe' && c[1] > 44), 'le son enregistré part à la transcription')
    assert.deepEqual(calls.find((c) => c[0] === 'ask'), ['ask', 'Quelle heure est-il ?'], 'la question dite part telle quelle, sans « Envoyer »')
    await page.waitForFunction(() => document.querySelector('.duel-voice .app__status')?.textContent.includes('Le modèle A réfléchit'))
    assert.match(await page.textContent('.duel-voice .app__transcript'), /Quelle heure est-il/)
    await shot(page, '3-a-reflechit')
  })
})

test('Duel Vocal : A répond à voix haute, un bouton pose la même question à B, puis réécouter et voter', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-voice')
      // La réponse de A arrive : elle se lit toute seule et s'affiche en sous-titres.
      await page.evaluate(() => window.__emit(window.__makeView({ number: 1, prompt: 'Quelle heure est-il ?', a: window.__said('Il est midi et quart.'), b: window.__side() })))
      await page.waitForFunction(() => window.__media.includes('play'))
      await page.waitForFunction(() => document.querySelector('.duel-voice .app__reply')?.textContent.includes('Il est midi et quart.'))
      const runB = page.locator('button', { hasText: 'Poser la même question au modèle B' })
      assert.equal(await runB.count(), 1)
      await shot(page, '4-a-repond')
      await runB.click()
      await page.waitForFunction(() => window.__calls.includes('runB'))
      await page.waitForFunction(() => document.querySelector('.duel-voice .app__status')?.textContent.includes('Le modèle B réfléchit'))
      // B a répondu : réécouter A ou B, et le vote habituel.
      await page.evaluate(() => window.__emit(window.__makeView({ number: 1, prompt: 'Quelle heure est-il ?', a: window.__said('Il est midi et quart.'), b: window.__said('Midi quinze.') })))
      await page.waitForSelector('.duel-vote')
      assert.equal(await page.locator('button', { hasText: 'Réécouter A' }).count(), 1)
      assert.equal(await page.locator('button', { hasText: 'Réécouter B' }).count(), 1)
      assert.ok((await page.locator('.duel-vote__button').count()) >= 3, 'les boutons de vote')
      assert.equal(await page.locator('.duel-side').count(), 0, 'toujours pas de cartes de texte')
      // Répondre à un modèle qui pose une question : à l'orbe, pas « en bas » (il n'y a plus de champ en Vocal).
      assert.match(await page.textContent('.duel-vote__follow-hint'), /orbe/)
      assert.equal(await page.locator('.composer__input').count(), 0)
      await page.waitForTimeout(300)
      await shot(page, '5-vote')
      // « Écrire plutôt » : le champ revient, et l'indication avec lui.
      await page.locator('button', { hasText: 'Écrire plutôt' }).click()
      await page.waitForSelector('.composer__input')
      assert.match(await page.textContent('.duel-vote__follow-hint'), /en bas/)
    },
    "window.__initialRound = { number: 1, prompt: 'Quelle heure est-il ?', a: { status: 'running', text: '', activity: { kind: 'thinking' }, startedAt: Date.now(), durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null }, b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null } }"
  )
})

test('Duel Conversation : pas de scène vocale, la question s’écrit comme avant', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    assert.equal(await page.locator('.duel-voice').count(), 0)
  }, "window.__category = 'conversation'")
})
