import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadPhoneModules } from './phone-test-loader.mjs'

/**
 * Étape 214 : la page du téléphone, ouverte dans un vrai navigateur au format téléphone, contre le VRAI
 * serveur (seule la réponse de Jaris est simulée). Le micro est un faux micro de Chromium : le message vocal
 * parcourt donc vraiment tout le chemin — enregistrement, décodage, conversion en WAV 16 kHz par la page,
 * contrôle du format par le serveur.
 */

let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const PAGE_DIR = fileURLToPath(new URL('../phone/', import.meta.url))

async function withPhone(run) {
  const { load } = loadPhoneModules()
  const { PhoneServer } = load('phoneServer')
  const { PhoneDeviceStore } = load('phoneDevices')
  const dir = mkdtempSync(join(tmpdir(), 'jaris-phone-ui-'))
  const devices = new PhoneDeviceStore(join(dir, 'devices.json'))
  const received = { messages: [], wavBytes: [] }
  const exchanges = []
  const server = new PhoneServer({
    devices,
    pageDir: PAGE_DIR,
    history: async () => exchanges.slice(),
    transcribe: async (wav) => {
      received.wavBytes.push(wav.length)
      return 'allume la lumière'
    },
    sendMessage: async (text, onStatus) => {
      received.messages.push(text)
      onStatus('Recherche sur le web…')
      await new Promise((r) => setTimeout(r, 300))
      const reply = text.includes('chat') ? { reply: 'Voici ton **chat**.', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg==' } : { reply: `Réponse à : ${text}` }
      exchanges.push({ role: 'user', content: text }, { role: 'assistant', content: reply.reply })
      return reply
    }
  })
  const port = await server.listen()
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await context.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${port}` })
    const page = await context.newPage()
    await run({ page, server, devices, received, base: `http://127.0.0.1:${port}` })
  } finally {
    await browser.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sans appairage : écran de code ; le lien du QR connecte tout seul et efface le code de l’adresse', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    await page.goto(base + '/')
    await page.waitForSelector('#pair:not([hidden])')
    assert.equal(await page.isVisible('#chat'), false)

    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    assert.equal(new URL(page.url()).hash, '', 'le code ne reste pas dans l’adresse')
    assert.match(await page.textContent('.messages'), /Écris ou envoie un message vocal/)
  })
})

test('mauvais code tapé : message clair, on reste sur l’écran de code', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    const { code } = server.createPairingCode()
    await page.goto(base + '/')
    await page.fill('#pair-code', code === '00000000' ? '11111111' : '00000000')
    await page.click('#pair-submit')
    await page.waitForSelector('#pair-error:not([hidden])')
    assert.match(await page.textContent('#pair-error'), /Code incorrect/)
    await page.fill('#pair-code', code)
    await page.click('#pair-submit')
    await page.waitForSelector('#chat:not([hidden])')
  })
})

test('écrire : la bulle s’affiche, la progression aussi, puis la réponse (gras et image compris)', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    await page.fill('#input', 'dessine un chat')
    await page.click('#send')
    await page.waitForSelector('.message--pending')
    await page.waitForFunction(() => /Recherche sur le web/.test(document.querySelector('.message--pending')?.textContent || ''))
    await page.waitForSelector('.message--assistant:not(.message--pending) img')
    const last = page.locator('.message--assistant').last()
    assert.equal(await last.locator('strong').textContent(), 'chat', 'le gras est mis en forme')
    assert.equal(await last.locator('script').count(), 0)
    assert.deepEqual(received.messages, ['dessine un chat'])

    // La réponse reste dans la conversation : un rechargement la montre encore (même conversation que le PC).
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('.message').length >= 2)
    assert.match(await page.textContent('.messages'), /dessine un chat/)
  })
})

test('le texte de Jaris n’est jamais interprété comme du HTML', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    await page.fill('#input', '<img src=x onerror="window.__pwned=1">')
    await page.click('#send')
    await page.waitForFunction(() => document.querySelectorAll('.message--assistant:not(.message--pending)').length >= 1)
    assert.equal(await page.evaluate(() => window.__pwned), undefined)
    assert.equal(await page.locator('.messages img').count(), 0)
  })
})

test('message vocal : enregistré par le micro, converti en WAV 16 kHz par la page, transcrit puis répondu', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    await page.click('#mic')
    await page.waitForSelector('#recording:not([hidden])')
    await page.waitForTimeout(1200)
    await page.click('#recording-send')
    await page.waitForFunction(() => /Réponse à : allume la lumière/.test(document.querySelector('.messages').textContent))
    assert.equal(received.wavBytes.length, 1)
    // ~1,2 s à 16 kHz mono 16 bits ≈ 38 Ko : bien le format attendu, pas le webm d'origine.
    assert.ok(received.wavBytes[0] > 20_000 && received.wavBytes[0] < 200_000, `taille WAV ${received.wavBytes[0]}`)
    assert.match(await page.locator('.message--user').last().textContent(), /allume la lumière/, 'la transcription remplace « Message vocal… »')
  })
})

test('téléphone déconnecté depuis le PC : retour à l’écran de code avec l’explication', options, async () => {
  await withPhone(async ({ page, server, base, devices }) => {
    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    const [device] = await devices.list()
    await devices.remove(device.id)
    await page.fill('#input', 'tu es là ?')
    await page.click('#send')
    await page.waitForSelector('#pair:not([hidden])')
    assert.match(await page.textContent('#pair-error'), /déconnecté depuis le PC/)
  })
})

test('mise en page téléphone : champ en bas, rien ne déborde, cibles tactiles de 44 px', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    const { code } = server.createPairingCode()
    await page.goto(`${base}/#code=${code}`)
    await page.waitForSelector('#chat:not([hidden])')
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect()
      const mic = document.querySelector('#mic').getBoundingClientRect()
      return { bottom: composer.bottom, height: window.innerHeight, scrollW: document.documentElement.scrollWidth, width: window.innerWidth, mic: mic.width }
    })
    assert.ok(Math.abs(layout.bottom - layout.height) <= 1, 'champ collé en bas de l’écran')
    assert.ok(layout.scrollW <= layout.width, 'pas de défilement horizontal')
    assert.ok(layout.mic >= 44)
  })
})
