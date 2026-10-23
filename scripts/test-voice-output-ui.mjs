import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 346 — dans le widget, la voix de Jaris passe par l'AudioContext de l'orbe (qui l'analyse pour la faire
 * vibrer). Deux défauts : (1) le haut-parleur choisi dans Options n'était appliqué qu'à l'élément <audio>, que
 * l'AudioContext court-circuite ; (2) après un passage par le Chat, le lecteur n'existait plus. Vrai composant
 * JarisOrb dans Chromium, avec un lecteur qui reste monté pendant que l'orbe apparaît et disparaît (comme App.tsx).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-voice-output-entry.tsx')

const ENTRY = `
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import JarisOrb, { setVoiceOutputDevice } from './src/components/JarisOrb'

window.__sinks = []
window.__contexts = 0
const RealContext = window.AudioContext
window.AudioContext = class extends RealContext {
  constructor(...args) { super(...args); window.__contexts++ }
  setSinkId(id) { window.__sinks.push(['context', id]); return Promise.resolve() }
}
HTMLMediaElement.prototype.setSinkId = function (id) { window.__sinks.push(['element', id]); return Promise.resolve() }

function Harness() {
  const audioRef = useRef(null)
  const [form, setForm] = useState('voice')
  window.__setForm = setForm
  window.__applySink = (id) => setVoiceOutputDevice(audioRef.current, id)
  window.__audio = () => audioRef.current
  const audio = <audio key="widget-audio" ref={audioRef} hidden />
  return form === 'voice'
    ? <div><JarisOrb emotion="idle" audioElRef={audioRef} size={40} />{audio}</div>
    : <div><span className="chat-form">chat</span>{audio}</div>
}

createRoot(document.getElementById('root')).render(<Harness />)
`

function buildPage() {
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-voice-output-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  return `<!doctype html><html><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('la sortie choisie s’applique à l’AudioContext de l’orbe, et le lecteur survit au passage par le Chat', options, async () => {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.setContent(html)
    await page.waitForFunction(() => window.__contexts === 1)
    await page.evaluate(() => window.__applySink('casque-123'))
    assert.deepEqual(await page.evaluate(() => window.__sinks), [['element', 'casque-123'], ['context', 'casque-123']])

    // Forme Chat puis retour à la voix : le même lecteur, donc le même AudioContext (pas un de plus à chaque passage).
    await page.evaluate(() => (window.__first = window.__audio()))
    await page.evaluate(() => window.__setForm('chat'))
    await page.waitForSelector('.chat-form')
    assert.equal(await page.evaluate(() => window.__audio() === window.__first), true, 'le lecteur existe encore sous la forme Chat')
    await page.evaluate(() => window.__setForm('voice'))
    await page.waitForSelector('.jaris-orb')
    assert.equal(await page.evaluate(() => window.__audio() === window.__first), true)
    assert.equal(await page.evaluate(() => window.__contexts), 1, 'aucun AudioContext de plus')
  } finally {
    await browser.close()
  }
})

test('App.tsx monte le lecteur de la voix sous les deux formes du widget, avec une clé stable', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const widgetAudio = \(\s*<audio\s+key="widget-audio"/)
  const chatBranch = app.slice(app.indexOf("if (widgetMode === 'chat' || widgetMode === 'chat-idle') {"), app.indexOf('const widgetCollapsed'))
  assert.match(chatBranch, /\{widgetAudio\}/)
  assert.equal(app.match(/\{widgetAudio\}/g).length, 2)
  assert.match(app, /setVoiceOutputDevice\(el, profile\?\.audioOutputDeviceId \?\? ''\)/)
})
