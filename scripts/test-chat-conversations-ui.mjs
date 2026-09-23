import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Faux main process : deux conversations, chacune avec ses propres messages. */
const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/ChatPanel'

const THREADS = {
  a: [
    { role: 'user', content: 'parle moi des chats' },
    { role: 'assistant', content: 'Les chats dorment beaucoup.' }
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
