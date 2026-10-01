import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadPhoneModules, makeWav } from './phone-test-loader.mjs'

/**
 * Étapes 214-215 : la page du téléphone, ouverte dans un vrai navigateur au format téléphone, contre le VRAI
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
const SHOTS = process.env.PHONE_SHOTS || null
/** Une vraie petite image (1x1) : la galerie doit vraiment l'afficher, pas seulement créer la balise. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg==', 'base64')
const READY = {
  image: { ready: true, reason: null },
  video: { ready: true, reason: null, qualities: [{ id: 'q6', label: 'Équilibrée' }, { id: 'q8', label: 'Fidèle' }], durations: [1, 2, 3, 4, 5] }
}

async function withPhone(run, overrides = {}) {
  const { load } = loadPhoneModules()
  const { PhoneServer } = load('phoneServer')
  const { PhoneDeviceStore } = load('phoneDevices')
  const dir = mkdtempSync(join(tmpdir(), 'jaris-phone-ui-'))
  const devices = new PhoneDeviceStore(join(dir, 'devices.json'))
  const received = { messages: [], modes: [], wavBytes: [], spoken: [], images: [], videos: [] }
  const exchanges = []
  const images = [
    { fileName: '2026-09-30T08-00-00-un-phare.png', label: 'un phare', timestamp: Date.parse('2026-09-30T08:00:00Z') },
    { fileName: '2026-09-29T08-00-00-une-foret.png', label: 'une forêt', timestamp: Date.parse('2026-09-29T08:00:00Z') }
  ]
  const videos = [{ fileName: '2026-09-30T08-00-00-des-vagues.webm', label: 'des vagues', timestamp: Date.parse('2026-09-30T08:00:00Z') }]
  const server = new PhoneServer({
    devices,
    pageDir: PAGE_DIR,
    history: async () => exchanges.slice(),
    transcribe: async (wav) => {
      received.wavBytes.push(wav.length)
      return 'allume la lumière'
    },
    sendMessage: async (text, onStatus, mode) => {
      received.messages.push(text)
      received.modes.push(mode)
      onStatus('Recherche sur le web…')
      await new Promise((r) => setTimeout(r, 300))
      const reply = text.includes('chat') ? { reply: 'Voici ton **chat**.', image: 'data:image/png;base64,' + PNG.toString('base64') } : { reply: `Réponse à : ${text}` }
      exchanges.push({ role: 'user', content: text }, { role: 'assistant', content: reply.reply })
      return reply
    },
    speak: async (text) => {
      received.spoken.push(text)
      return makeWav(400)
    },
    studio: async () => READY,
    generateImage: async (prompt, onStatus) => {
      received.images.push(prompt)
      onStatus('Dessin : étape 2 sur 4')
      await new Promise((r) => setTimeout(r, 600))
      const made = { fileName: '2026-10-01T09-00-00-un-chat.png', label: 'un chat', timestamp: Date.now() }
      images.unshift(made)
      return made
    },
    generateVideo: async (prompt, seconds, quality, onStatus) => {
      received.videos.push({ prompt, seconds, quality })
      onStatus('Vidéo : étape 1 sur 8')
      await new Promise((r) => setTimeout(r, 400))
      const made = { fileName: '2026-10-01T09-00-00-un-volcan.webm', label: 'un volcan', timestamp: Date.now() }
      videos.unshift(made)
      return made
    },
    listImages: async () => images.slice(),
    listVideos: async () => videos.slice(),
    readImage: async () => PNG,
    readImageThumbnail: async () => PNG,
    readVideo: async () => Buffer.from('1a45dfa3', 'hex'),
    ...overrides
  })
  const port = await server.listen()
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=user-gesture-required']
  })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await context.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${port}` })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await run({ page, server, devices, received, base: `http://127.0.0.1:${port}` })
    assert.deepEqual(errors, [], 'aucune erreur JavaScript dans la page')
  } finally {
    await browser.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function open(page, server, base) {
  const { code } = server.createPairingCode()
  await page.goto(`${base}/#code=${code}`)
  await page.waitForSelector('#app:not([hidden])')
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') })
}

test('sans appairage : écran de code ; le lien du QR connecte tout seul et efface le code de l’adresse', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    await page.goto(base + '/')
    await page.waitForSelector('#pair:not([hidden])')
    assert.equal(await page.isVisible('#app'), false)
    await open(page, server, base)
    assert.equal(new URL(page.url()).hash, '', 'le code ne reste pas dans l’adresse')
    assert.match(await page.textContent('.messages'), /Écris à Jaris/)
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
    await page.waitForSelector('#app:not([hidden])')
  })
})

test('Chat : plus de dictaphone ; écrire affiche la progression puis la réponse (gras et image compris)', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    await open(page, server, base)
    assert.equal(await page.locator('#mic, #recording, .composer__mic').count(), 0, 'le micro du Chat a été retiré')
    await page.fill('#input', 'dessine un chat')
    await page.click('#send')
    await page.waitForSelector('.message--pending')
    await page.waitForFunction(() => /Recherche sur le web/.test(document.querySelector('.message--pending')?.textContent || ''))
    await page.waitForSelector('.message--assistant:not(.message--pending) img')
    const last = page.locator('.message--assistant').last()
    assert.equal(await last.locator('strong').textContent(), 'chat', 'le gras est mis en forme')
    assert.deepEqual(received.messages, ['dessine un chat'])
    assert.deepEqual(received.modes, ['chat'])
    await shot(page, 'phone-chat')

    // La réponse reste dans la conversation : un rechargement la montre encore (même conversation que le PC).
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('.message').length >= 2)
    assert.match(await page.textContent('.messages'), /dessine un chat/)
  })
})

test('le texte de Jaris n’est jamais interprété comme du HTML', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    await open(page, server, base)
    await page.fill('#input', '<img src=x onerror="window.__pwned=1">')
    await page.click('#send')
    await page.waitForFunction(() => document.querySelectorAll('.message--assistant:not(.message--pending)').length >= 1)
    assert.equal(await page.evaluate(() => window.__pwned), undefined)
    assert.equal(await page.locator('.messages img').count(), 0)
  })
})

test('Vocal : toucher Jaris, parler, il envoie après la pause et répond à voix haute', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    await open(page, server, base)
    await page.click('.tabbar__item[data-target="voice"]')
    await page.waitForSelector('#tab-voice:not([hidden])')
    assert.match(await page.textContent('#voice-state'), /Touche Jaris pour parler/)
    await shot(page, 'phone-voice')
    await page.click('#voice-orb')
    await page.waitForFunction(() => /écoute/.test(document.querySelector('#voice-state').textContent))
    assert.equal(await page.isVisible('#voice-cancel'), true)
    await page.waitForTimeout(1300)
    // Toucher encore Jaris envoie (la pause, elle, n'arrive pas forcément avec le faux micro du navigateur).
    if ((await page.getAttribute('#voice-orb', 'class')).includes('listening')) await page.click('#voice-orb')
    await page.waitForFunction(() => /Réponse à : allume la lumière/.test(document.querySelector('#voice-reply').textContent))
    assert.equal(await page.textContent('#voice-transcript'), 'allume la lumière')
    assert.equal(received.wavBytes.length, 1)
    // ~1 à 2 s à 16 kHz mono 16 bits : bien le format attendu, pas le webm d'origine.
    assert.ok(received.wavBytes[0] > 10_000 && received.wavBytes[0] < 200_000, `taille WAV ${received.wavBytes[0]}`)
    assert.deepEqual(received.modes, ['voice'], 'réponse prévue pour être lue à voix haute')
    assert.deepEqual(received.spoken, ['Réponse à : allume la lumière'])
    // La voix est jouée par le lecteur « ouvert » pendant le toucher, puis Jaris se remet au repos.
    await page.waitForFunction(() => document.querySelector('#voice-audio').src.startsWith('blob:'))
    await page.waitForFunction(() => /Touche Jaris pour reparler$/.test(document.querySelector('#voice-state').textContent), null, { timeout: 8000 })
    assert.equal(await page.isVisible('#voice-replay'), true, 'on peut toujours réécouter')
    await shot(page, 'phone-voice-done')

    // L'échange fait partie de la conversation : le Chat le montre en y revenant.
    await page.click('.tabbar__item[data-target="chat"]')
    await page.waitForFunction(() => /allume la lumière/.test(document.querySelector('.messages').textContent))
  })
})

test('Vocal : Annuler n’envoie rien au PC', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    await open(page, server, base)
    await page.click('.tabbar__item[data-target="voice"]')
    await page.click('#voice-orb')
    await page.waitForSelector('#voice-cancel:not([hidden])')
    await page.waitForTimeout(400)
    await page.click('#voice-cancel')
    await page.waitForTimeout(800)
    assert.equal(received.wavBytes.length, 0)
    assert.match(await page.textContent('#voice-state'), /Touche Jaris pour parler/)
  })
})

test('Image : la galerie montre les images du PC ; créer affiche l’avancement puis ouvre l’image', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    await open(page, server, base)
    await page.click('.tabbar__item[data-target="image"]')
    await page.waitForFunction(() => document.querySelectorAll('#image-gallery .tile img').length === 2)
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#image-gallery .tile img')].every((img) => img.complete && img.naturalWidth > 0)), 'vignettes vraiment affichées')
    assert.match(await page.textContent('#image-gallery'), /un phare/)
    await shot(page, 'phone-image')

    await page.fill('#image-prompt', 'un chat astronaute')
    await page.click('#image-create')
    await page.waitForSelector('#image-progress:not([hidden])')
    await page.waitForFunction(() => /étape 2 sur 4/.test(document.querySelector('#image-status').textContent))
    await page.waitForSelector('#viewer:not([hidden]) .viewer__media img')
    assert.deepEqual(received.images, ['un chat astronaute'])
    assert.equal(await page.textContent('#viewer-title'), 'un chat')
    assert.equal(await page.getAttribute('#viewer-save', 'download'), '2026-10-01T09-00-00-un-chat.png')
    assert.match(await page.getAttribute('#viewer-save', 'href'), /^blob:/, 'jamais une adresse publique du fichier')
    await shot(page, 'phone-image-viewer')
    await page.click('#viewer-close')
    assert.equal(await page.isVisible('#viewer'), false)
    assert.equal(await page.locator('#image-gallery .tile').count(), 3, 'la nouvelle image rejoint la galerie')
    assert.equal(await page.isVisible('#image-progress'), false)
  })
})

test('Image : pas prête sur le PC -> la raison s’affiche et rien ne peut être lancé', options, async () => {
  await withPhone(
    async ({ page, server, base }) => {
      await open(page, server, base)
      await page.click('.tabbar__item[data-target="image"]')
      await page.waitForSelector('#image-unavailable:not([hidden])')
      assert.match(await page.textContent('#image-unavailable'), /installe-le une fois depuis Jaris sur ton PC/)
      assert.equal(await page.isVisible('#image-form'), false)
    },
    {
      studio: async () => ({
        image: { ready: false, reason: 'Le mode Image n’est pas encore installé : installe-le une fois depuis Jaris sur ton PC (mode Image).' },
        video: { ready: false, reason: 'Pas prêt.', qualities: [], durations: [1, 2, 3, 4, 5] }
      })
    }
  )
})

test('Vidéo : qualités installées et durées en choix ; la durée choisie part bien au PC', options, async () => {
  await withPhone(async ({ page, server, base, received }) => {
    await open(page, server, base)
    await page.click('.tabbar__item[data-target="video"]')
    await page.waitForSelector('#video-qualities .chip')
    assert.deepEqual(await page.locator('#video-qualities .chip').allTextContents(), ['Équilibrée', 'Fidèle'])
    assert.deepEqual(await page.locator('#video-durations .chip').allTextContents(), ['1 s', '2 s', '3 s', '4 s', '5 s'])
    assert.equal(await page.textContent('#video-durations .chip--active'), '2 s', 'durée par défaut')
    await page.click('#video-durations .chip:has-text("4 s")')
    await page.click('#video-qualities .chip:has-text("Fidèle")')
    await page.waitForSelector('#video-gallery .tile--video')
    await shot(page, 'phone-video')
    await page.fill('#video-prompt', 'un volcan')
    await page.click('#video-create')
    await page.waitForSelector('#viewer:not([hidden]) video')
    assert.deepEqual(received.videos, [{ prompt: 'un volcan', seconds: 4, quality: 'q8' }])
    // Les choix sont gardés pour la prochaine fois.
    await page.click('#viewer-close')
    await page.reload()
    await page.waitForSelector('#video-durations .chip--active')
    assert.equal(await page.textContent('#video-durations .chip--active'), '4 s')
  })
})

test('Vidéo : « Arrêter » arrête vraiment la création sur le PC', options, async () => {
  let aborted = false
  await withPhone(
    async ({ page, server, base }) => {
      await open(page, server, base)
      await page.click('.tabbar__item[data-target="video"]')
      await page.waitForSelector('#video-qualities .chip')
      await page.fill('#video-prompt', 'un volcan')
      await page.click('#video-create')
      await page.waitForSelector('#video-progress:not([hidden])')
      await page.click('#video-stop')
      await page.waitForSelector('#video-error:not([hidden])')
      assert.match(await page.textContent('#video-error'), /Création arrêtée/)
      assert.equal(aborted, true)
      assert.equal(await page.isDisabled('#video-create'), false, 'on peut relancer')
    },
    {
      generateVideo: (prompt, seconds, quality, onStatus, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('arrêtée'))
          })
        )
    }
  )
})

test('téléphone déconnecté depuis le PC : retour à l’écran de code avec l’explication', options, async () => {
  await withPhone(async ({ page, server, base, devices }) => {
    await open(page, server, base)
    const [device] = await devices.list()
    await devices.remove(device.id)
    await page.fill('#input', 'tu es là ?')
    await page.click('#send')
    await page.waitForSelector('#pair:not([hidden])')
    assert.match(await page.textContent('#pair-error'), /déconnecté depuis le PC/)
  })
})

test('mise en page téléphone : barre d’onglets en bas, rien ne déborde, cibles tactiles de 44 px', options, async () => {
  await withPhone(async ({ page, server, base }) => {
    await open(page, server, base)
    for (const tab of ['chat', 'voice', 'image', 'video']) {
      await page.click(`.tabbar__item[data-target="${tab}"]`)
      await page.waitForSelector(`#tab-${tab}:not([hidden])`)
      const layout = await page.evaluate((tab) => {
        const bar = document.querySelector('.tabbar').getBoundingClientRect()
        const items = [...document.querySelectorAll('.tabbar__item')].map((b) => b.getBoundingClientRect())
        const visible = document.querySelectorAll('[data-tab]:not([hidden])')
        const active = document.querySelector('.tabbar__item--active').getAttribute('data-target')
        return {
          bottom: bar.bottom,
          height: window.innerHeight,
          scrollW: document.documentElement.scrollWidth,
          width: window.innerWidth,
          smallest: Math.min(...items.map((r) => Math.min(r.width, r.height))),
          visible: visible.length,
          active,
          send: tab === 'chat' ? document.querySelector('#send').getBoundingClientRect().width : 44
        }
      }, tab)
      assert.ok(Math.abs(layout.bottom - layout.height) <= 1, `${tab} : barre collée en bas`)
      assert.ok(layout.scrollW <= layout.width, `${tab} : pas de défilement horizontal`)
      assert.ok(layout.smallest >= 44, `${tab} : onglets assez grands au doigt`)
      assert.equal(layout.visible, 1, `${tab} : un seul onglet affiché`)
      assert.equal(layout.active, tab)
      assert.ok(layout.send >= 44)
    }
    // L'onglet choisi est retrouvé à la réouverture.
    await page.reload()
    await page.waitForSelector('#tab-video:not([hidden])')
  })
})
