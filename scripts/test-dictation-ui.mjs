import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 276 (Léo : « quand on clique sur le micro dans le Chat, ça ne doit pas aller en vocal, ça doit enregistrer
 * et transcrire en texte ») : le VRAI champ de saisie (Composer.tsx, partagé par le Chat, Code, Image et Vidéo)
 * dans un vrai navigateur, avec le faux micro de Chromium (un son de test). Vérifie qu'un clic enregistre, qu'un
 * second envoie un WAV 16 kHz à la transcription, que le texte s'ajoute au champ SANS être envoyé, et que rien ne
 * bascule plus vers l'Agent vocal.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-dictation-entry.tsx')

const ENTRY = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Composer from './src/components/Composer'

window.__calls = []
window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name === 'transcribeDictation') {
      return async (wav) => {
        window.__calls.push(['transcribe', Array.from(wav.slice(0, 44)), wav.length])
        if (window.__transcribeError) throw new Error(window.__transcribeError)
        return window.__transcript ?? 'un mail à Paul'
      }
    }
    if (name.startsWith('on')) return () => () => {}
    return async (...args) => {
      window.__calls.push([name, ...args])
      return null
    }
  }
})

function Harness() {
  const [value, setValue] = useState('Écris')
  const [error, setError] = useState('')
  return (
    <div className="chat-panel" style={{ height: '100vh' }}>
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={() => window.__calls.push(['submit', value])}
        placeholder="Écris à Jaris…"
        submitLabel="Envoyer"
        busyLabel="Envoi…"
        busy={false}
        attachment={null}
        onAttachmentChange={() => {}}
        onError={setError}
        submitOnEnter
      />
      <p className="harness-error">{error}</p>
    </div>
  )
}
createRoot(document.getElementById('root')).render(<Harness />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-dictation-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** Un faux micro (son de test de Chromium) et l'autorisation accordée d'office, comme dans Jaris (main.ts). */
async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 900, height: 400 })
    // Page servie depuis http://localhost (contexte sûr) : getUserMedia n'existe pas sur about:blank.
    await page.route('http://localhost/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
    await page.goto('http://localhost/')
    await page.waitForSelector('.composer__mic')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'playwright introuvable (absent du runner CI)' }

test('micro du champ : un clic enregistre, un second transcrit — le texte s’ajoute au champ, rien n’est envoyé', options, async () => {
  await withPage(async (page) => {
    const mic = page.locator('.composer__mic')
    assert.equal(await mic.getAttribute('aria-label'), 'Dicter')
    await mic.click()
    await page.waitForSelector('.composer__mic--recording')
    assert.equal(await mic.getAttribute('aria-pressed'), 'true')
    assert.match(await page.textContent('.composer__dictation'), /0:0\d/, 'pas de compteur pendant la dictée')
    await page.waitForTimeout(900)
    await mic.click()
    await page.waitForFunction(() => document.querySelector('.composer__input').value === 'Écris un mail à Paul')
    assert.equal(await page.locator('.composer__mic--recording').count(), 0)
    const calls = await page.evaluate(() => window.__calls)
    const transcribe = calls.find((c) => c[0] === 'transcribe')
    assert.ok(transcribe, 'la transcription n’a pas été demandée')
    const header = Buffer.from(transcribe[1])
    assert.equal(header.toString('ascii', 0, 4), 'RIFF')
    assert.equal(header.readUInt32LE(24), 16000, 'le son n’est pas ramené à 16 kHz')
    assert.equal(header.readUInt16LE(22), 1, 'le son n’est pas mono')
    assert.ok(transcribe[2] > 44 + 16000 * 2 * 0.5, `enregistrement trop court : ${transcribe[2]} octets`)
    // Plus de bascule vers l'Agent vocal, et rien n'est envoyé tout seul : Léo relit puis envoie.
    assert.deepEqual(calls.filter((c) => ['setActiveMode', 'triggerWake', 'submit'].includes(c[0])), [])
  })
})

test('dictée : une erreur de transcription s’affiche en clair, sans le préfixe technique d’Electron', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__transcribeError = "Error invoking remote method 'jaris:transcribe-dictation': Error: L'écoute n'est pas lancée sur le PC."
    })
    await page.click('.composer__mic')
    await page.waitForSelector('.composer__mic--recording')
    await page.waitForTimeout(500)
    await page.click('.composer__mic')
    await page.waitForFunction(() => document.querySelector('.harness-error').textContent.length > 0)
    assert.equal(await page.textContent('.harness-error'), "L'écoute n'est pas lancée sur le PC.")
    assert.equal(await page.inputValue('.composer__input'), 'Écris', 'le champ a changé malgré l’échec')
  })
})
