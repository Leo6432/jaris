import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Liste des conversations du Chat, dans la colonne de gauche partagée avec le mode Code (Workspace, étape
 * 97) — sur le VRAI composant et le vrai CSS compilé.
 *
 * Ce que ce test protège vraiment : qu'un changement de fil RECHARGE le fil affiché. Côté main, chaque
 * bascule remet à zéro le fil et le contexte du modèle ; si le renderer oubliait de relire, le nouveau fil
 * s'ouvrirait avec les messages de l'ancien encore à l'écran — le genre de bug qu'on ne voit pas en
 * relisant le code, mais tout de suite en cliquant.
 *
 * Playwright n'est pas une dépendance du projet (absent du runner Windows de la CI) : import dynamique,
 * tests explicitement ignorés s'il manque.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-chat-conversations-entry.tsx')

/** PNG 8x8 gris, pour une vraie image décodable par le navigateur. */
/**
 * PNG gris de 256×256, fabriqué ici (zlib de Node) : une vraie image dessinée fait 1024 px, et une image de 8 px
 * ne laisse aucune place au bouton « Télécharger » posé dessus (étape 185).
 */
function grayPng(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // 8 bits
  header[9] = 0 // niveaux de gris
  const rows = Buffer.alloc((size + 1) * size, 128)
  for (let y = 0; y < size; y++) rows[y * (size + 1)] = 0 // filtre « aucun » en tête de chaque ligne
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const TEST_PNG = grayPng(256)

/** Faux main process : deux conversations, chacune avec ses propres messages. */
const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/ChatPanel'

const THREADS = {
  a: [
    { role: 'user', content: 'parle moi des chats' },
    { role: 'assistant', content: 'Les chats dorment beaucoup.' },
    { role: 'user', content: 'dessine-moi un chat' },
    // Étape 173 : image dessinée par Jaris (PNG 8x8 réel), renvoyée par le main sur le message assistant.
    { role: 'assistant', content: 'Voilà ton image.', image: 'data:image/png;base64,${TEST_PNG.toString('base64')}' }
  ],
  b: [{ role: 'user', content: 'recette de crêpes' }]
}

window.__state = {
  activeId: 'a',
  conversations: [
    { id: 'a', title: 'parle moi des chats', createdAt: '', updatedAt: '2026-09-14T10:00:00.000Z', messageCount: 1 },
    { id: 'b', title: 'recette de crêpes', createdAt: '', updatedAt: '2026-09-13T10:00:00.000Z', messageCount: 1 }
  ]
}
window.__calls = []

const list = () => Promise.resolve(JSON.parse(JSON.stringify(window.__state)))

window.jaris = {
  getChatHistory: () => Promise.resolve(THREADS[window.__state.activeId] ?? []),
  listConversations: list,
  selectConversation: (id) => {
    window.__calls.push(['select', id])
    window.__state.activeId = id
    return list()
  },
  createConversation: () => {
    window.__calls.push(['create'])
    window.__state.conversations.unshift({ id: 'neuf', title: 'Nouvelle conversation', createdAt: '', updatedAt: '2026-09-15T10:00:00.000Z', messageCount: 0 })
    window.__state.activeId = 'neuf'
    return list()
  },
  deleteConversation: (id) => {
    window.__calls.push(['delete', id])
    window.__state.conversations = window.__state.conversations.filter((c) => c.id !== id)
    window.__state.activeId = window.__state.conversations[0].id
    return list()
  },
  onLog: () => () => {},
  onChatStreamToken: () => () => {},
  getProfile: () => Promise.resolve({ soundEffectsEnabled: false }),
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null }),
  setModelChoice: () => Promise.resolve(),
  pickImageFile: () => Promise.resolve(null),
  // Étape 185 : le test choisit lui-même la réponse de la fenêtre « Enregistrer sous ».
  saveGeneratedImage: (dataUrl) => {
    window.__saved = (window.__saved ?? []).concat(dataUrl)
    return Promise.resolve(window.__saveResult ?? { saved: true })
  },
  sendChatMessage: () => Promise.resolve({ role: 'assistant', content: 'ok' })
}

createRoot(document.getElementById('root')).render(<Panel />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-chat-ui-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        entryPath,
        '--bundle',
        '--format=iife',
        '--loader:.tsx=tsx',
        '--jsx=automatic',
        `--alias:@=${join(projectRoot, 'src')}`,
        `--outfile=${bundlePath}`
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally : sinon une assertion qui échoue laisse Chromium ouvert et `node --test` ne se termine jamais. */
async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(html)
    await page.waitForSelector('.workspace__rail')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('les conversations sont listées en colonne, la conversation ouverte est signalée', options, async () => {
  await withPage(async (page) => {
    // Toujours visible, sans rien déplier : c'est ce que Léo demandait ("comme claude ou chatgpt").
    assert.equal(await page.locator('.workspace__list li').count(), 2)
    assert.equal(await page.locator('.workspace__item--active').count(), 1)
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'parle moi des chats')

    // Le bouton de création est bien rendu dans le style de l'application, pas en gris (défaut signalé par
    // Léo en v0.8.0 : la classe manquait dans la famille de boutons partagée, le bouton restait blanc).
    const style = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.workspace__new'))
      return { color: s.color, hasBackground: s.backgroundImage !== 'none' }
    })
    assert.equal(style.hasBackground, true, 'le bouton "Nouvelle conversation" est resté sans fond')
    assert.notEqual(style.color, 'rgb(255, 255, 255)', 'le bouton est resté au style par défaut du navigateur')
  })
})

test('changer de conversation recharge VRAIMENT le fil affiché', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.chat-panel__message')
    assert.match(await page.textContent('.chat-panel__thread'), /chats dorment/)

    await page.click('.workspace__list li:nth-child(2) .workspace__item')

    await page.waitForFunction(() => document.querySelector('.chat-panel__thread').textContent.includes('crêpes'))
    const thread = await page.textContent('.chat-panel__thread')
    assert.doesNotMatch(thread, /chats dorment/, "les messages de l'ancien fil sont restés à l'écran")
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'recette de crêpes')
    assert.deepEqual(await page.evaluate(() => window.__calls), [['select', 'b']])
  })
})

test('"Nouvelle conversation" ouvre un fil vide', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.chat-panel__message')
    await page.click('.workspace__new')

    await page.waitForFunction(() => document.querySelectorAll('.chat-panel__message').length === 0)
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'Nouvelle conversation')
    assert.deepEqual(await page.evaluate(() => window.__calls), [['create']])
  })
})

test('supprimer une conversation demande confirmation', options, async () => {
  await withPage(async (page) => {
    await page.click('.workspace__list li:nth-child(2) .workspace__delete')
    await page.waitForSelector('.workspace__confirm')
    // Rien n'est supprimé tant que la confirmation n'est pas validée.
    assert.deepEqual(await page.evaluate(() => window.__calls), [])

    await page.click('.workspace__confirm-no')
    assert.equal(await page.locator('.workspace__confirm').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__calls), [])

    await page.click('.workspace__list li:nth-child(2) .workspace__delete')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction(() => window.__calls.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__calls), [['delete', 'b']])
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

test('image dessinée par Jaris : affichée EN GRAND sous sa réponse, jamais en vignette de pièce jointe', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.chat-panel__message-image--generated')
    const info = await page.evaluate(() => {
      const img = document.querySelector('.chat-panel__message-image--generated')
      const message = img.closest('.chat-panel__message')
      const text = [...message.childNodes].find((n) => n !== img)
      return {
        role: message.className,
        alt: img.alt,
        imageAfterText: text.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING,
        maxHeight: getComputedStyle(img).maxHeight,
        decoded: img.naturalWidth
      }
    })
    assert.match(info.role, /chat-panel__message--assistant/)
    assert.equal(info.alt, 'Image dessinée par Jaris')
    assert.ok(info.imageAfterText, 'l’image vient après le texte de la réponse')
    assert.notEqual(info.maxHeight, '260px', 'pas la petite taille des images jointes')
    assert.equal(info.decoded, 256, 'l’image est réellement décodée')
  })
})

test('image dessinée : l’icône « Télécharger » envoie l’image à enregistrer, et confirme seulement si c’est fait', options, async () => {
  await withPage(async (page) => {
    const button = page.locator('.chat-panel__save-image')
    await button.waitFor()
    assert.equal(await button.getAttribute('aria-label'), "Télécharger l'image")

    // Annulé dans la fenêtre de Windows : rien d'enregistré, aucune fausse confirmation.
    await page.evaluate(() => { window.__saveResult = { saved: false } })
    await button.click()
    await page.waitForFunction(() => (window.__saved ?? []).length === 1)
    assert.equal(await button.getAttribute('aria-label'), "Télécharger l'image")

    await page.evaluate(() => { window.__saveResult = { saved: true } })
    await button.click()
    await page.waitForFunction(() => document.querySelector('.chat-panel__save-image').getAttribute('aria-label') === 'Image enregistrée')
    const sent = await page.evaluate(() => window.__saved[1])
    assert.match(sent, /^data:image\/png;base64,/, 'c’est bien l’image affichée qui est envoyée')

    // Échec d'écriture : le message lisible s'affiche.
    await page.evaluate(() => { window.__saveResult = { saved: false, error: "Impossible d'enregistrer l'image : disque plein" } })
    await page.waitForTimeout(2100)
    await button.click()
    await page.waitForSelector('.chat-panel__error')
    assert.match(await page.textContent('.chat-panel__error'), /disque plein/)

    // Le bouton est dans le coin de l'image, pas une ligne de plus dans le fil.
    const box = await page.evaluate(() => {
      const img = document.querySelector('.chat-panel__message-image--generated').getBoundingClientRect()
      const btn = document.querySelector('.chat-panel__save-image').getBoundingClientRect()
      return { inside: btn.left >= img.left && btn.right <= img.right && btn.top >= img.top && btn.bottom <= img.bottom }
    })
    assert.ok(box.inside, 'le bouton doit être posé sur l’image')
  })
})
