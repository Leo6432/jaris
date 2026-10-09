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
    // Étape 273 : réponse précédée d'une recherche web (bloc dépliable).
    {
      role: 'assistant',
      content: 'Les chats dorment beaucoup.',
      web: [{ kind: 'search', query: 'combien de temps dort un chat', results: [{ title: 'Le sommeil du chat', url: 'https://www.exemple-chats.fr/sommeil' }] }]
    },
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
  // Étape 273 : le test envoie lui-même les recherches web « en direct » (window.__web).
  onChatWebActivity: (cb) => {
    window.__web = cb
    return () => {}
  },
  getProfile: () => Promise.resolve({ soundEffectsEnabled: false }),
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null }),
  setModelChoice: () => Promise.resolve(),
  pickImageFile: () => Promise.resolve(null),
  // Étape 185 : le test choisit lui-même la réponse de la fenêtre « Enregistrer sous ».
  saveGeneratedImage: (dataUrl) => {
    window.__saved = (window.__saved ?? []).concat(dataUrl)
    return Promise.resolve(window.__saveResult ?? { saved: true })
  },
  // Étape 272 : « longue » ne répond qu'une fois « Arrêter » cliqué, comme une vraie réponse interrompue.
  sendChatMessage: (prompt) => {
    if (!prompt.startsWith('longue')) return Promise.resolve({ role: 'assistant', content: 'ok' })
    return new Promise((resolve) => {
      window.__stopChat = () => resolve({ role: 'assistant', content: 'Bonjour, voici le début', stopped: true })
    })
  },
  cancelChat: () => {
    window.__calls.push(['cancel'])
    window.__stopChat?.()
  }
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
        '--loader:.png=dataurl',
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

    // Le bouton de création est bien rendu dans le style de l'application (défaut signalé par Léo en v0.8.0 :
    // la classe manquait, le bouton restait au style du navigateur). Depuis la refonte « design sobre », c'est
    // une rangée de la barre latérale ; design v2 (Windows 11) : 36px de haut, coins de 6px, sans cadre.
    const style = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.workspace__new'))
      return { color: s.color, font: s.fontFamily, height: s.height, radius: s.borderTopLeftRadius, border: s.borderTopStyle }
    })
    assert.match(style.font, /Geist/, 'le bouton est resté à la police par défaut du navigateur')
    assert.equal(style.height, '36px')
    assert.equal(style.radius, '6px')
    assert.equal(style.border, 'none', 'le bouton a gardé le cadre par défaut du navigateur')
    assert.notEqual(style.color, 'rgb(0, 0, 0)', 'le bouton est resté au style par défaut du navigateur')
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

test('« Arrêter » comme ChatGPT (étape 272) : le bouton d’envoi devient un carré qui interrompt la réponse', options, async () => {
  await withPage(async (page) => {
    await page.fill('.composer__input', 'longue histoire, s’il te plaît')
    await page.click('.composer__send')
    // Pendant la réponse : le même bouton, actif, devenu « Arrêter ».
    await page.waitForSelector('.composer__send--stop')
    const stop = page.locator('.composer__send--stop')
    assert.equal(await stop.getAttribute('aria-label'), 'Arrêter')
    assert.equal(await stop.isEnabled(), true, 'bouton Arrêter désactivé')
    const look = await stop.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, w: el.getBoundingClientRect().width }
    })
    assert.ok(look.w >= 30, `bouton Arrêter trop petit : ${look.w}px`)
    assert.notEqual(look.bg, 'rgba(0, 0, 0, 0)', 'bouton Arrêter sans fond (style du navigateur)')
    await stop.click()
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'cancel'), 'cancelChat jamais appelé')
    // Le début déjà écrit reste, signalé comme coupé ; le bouton redevient « Envoyer ».
    await page.waitForSelector('.chat-panel__stopped')
    assert.match(await page.textContent('.chat-panel__message--assistant:last-of-type'), /Bonjour, voici le début/)
    assert.equal(await page.locator('.composer__send--stop').count(), 0)
    assert.equal(await page.locator('.composer__send').getAttribute('aria-label'), 'Envoyer')
    assert.equal(await page.locator('.code-panel__error, .chat-panel__error').count(), 0, 'erreur affichée pour un arrêt voulu')
  })
})

test('recherches web façon Claude (étape 273) : une ligne repliée avec sa flèche, dépliée elle montre la recherche et les pages', options, async () => {
  await withPage(async (page) => {
    const toggle = page.locator('.web-activity__toggle')
    await toggle.waitFor()
    assert.match(await toggle.textContent(), /A cherché sur le web/)
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('.web-activity__source').count(), 0, 'repliée par défaut : la réponse reste la première chose lue')
    // Le bloc est AU-DESSUS de la réponse.
    const order = await page.evaluate(() => {
      const block = document.querySelector('.web-activity').getBoundingClientRect()
      // Le texte de la réponse, où qu'il soit rendu : son nœud texte, mesuré par une plage.
      const walker = document.createTreeWalker(document.querySelector('.web-activity').closest('.chat-panel__body'), NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !/dorment/.test(node.textContent)) node = walker.nextNode()
      const range = document.createRange()
      range.selectNodeContents(node)
      return block.bottom <= range.getBoundingClientRect().top + 1
    })
    assert.ok(order, 'le bloc n’est pas au-dessus de la réponse')

    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.match(await page.textContent('.web-activity__steps'), /combien de temps dort un chat/)
    const link = page.locator('a.web-activity__source')
    assert.equal(await link.getAttribute('href'), 'https://www.exemple-chats.fr/sommeil')
    assert.equal(await link.getAttribute('target'), '_blank', 'le lien doit s’ouvrir dans le navigateur')
    assert.match(await link.textContent(), /Le sommeil du chat.*exemple-chats\.fr/)
    assert.equal(await link.evaluate((el) => getComputedStyle(el).textDecorationLine), 'none', 'liens soulignés (style des liens d’une réponse)')
  })
})

test('recherche web en direct : le bloc AU-DESSUS de l’indicateur, et ce qui est cherché dès le début', options, async () => {
  // Étape 274 (Léo : « il est mal fait », capture) : le bloc était posé à CÔTÉ de « Recherche sur internet… », qui
  // s'écrasait sur trois lignes à droite et répétait la même chose.
  await withPage(async (page) => {
    await page.fill('.composer__input', 'longue histoire sur Rennes')
    await page.click('.composer__send')
    await page.waitForSelector('.composer__send--stop')
    // Début de la recherche : le bloc dit ce qui est cherché, sans indicateur qui le répète.
    await page.evaluate(() => window.__web({ kind: 'search', query: 'histoire de Rennes', results: [], pending: true }))
    const live = page.locator('.chat-panel__message--pending .web-activity--running .web-activity__toggle')
    await live.waitFor()
    assert.match(await live.textContent(), /Recherche : « histoire de Rennes »/)
    assert.equal(await page.locator('.chat-panel__thinking').count(), 0, 'l’indicateur répète la recherche en cours')
    // Fin de la recherche : résumé, puis l'indicateur EN DESSOUS du bloc, sur une ligne.
    await page.evaluate(() => window.__web({ kind: 'search', query: 'histoire de Rennes', results: [{ title: 'Rennes', url: 'https://rennes.fr' }] }))
    await page.waitForSelector('.chat-panel__thinking')
    assert.equal(await page.locator('.chat-panel__message--pending .web-activity__toggle').count(), 1, 'deux blocs dans la réponse en cours')
    await page.locator('.chat-panel__message--pending .web-activity__toggle').click()
    assert.equal(await page.locator('.chat-panel__message--pending .web-activity__step').count(), 1, 'la recherche terminée s’est ajoutée à côté de celle en cours')
    assert.match(await page.textContent('.chat-panel__message--pending .web-activity__toggle'), /A cherché sur le web/)
    const layout = await page.evaluate(() => {
      const block = document.querySelector('.chat-panel__message--pending .web-activity').getBoundingClientRect()
      const row = document.querySelector('.chat-panel__thinking').getBoundingClientRect()
      const text = document.querySelector('.chat-panel__progress').getBoundingClientRect()
      return { below: row.top >= block.bottom - 1, oneLine: text.height < 30 }
    })
    assert.ok(layout.below, 'l’indicateur n’est pas sous le bloc')
    assert.ok(layout.oneLine, 'le texte de l’indicateur est écrasé sur plusieurs lignes')
    await page.click('.composer__send--stop')
    await page.waitForSelector('.chat-panel__stopped')
    assert.equal(await page.locator('.web-activity--running').count(), 0, 'le bloc « en direct » reste après la réponse')
  })
})
