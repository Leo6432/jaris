import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Sélecteur de conversations du Chat (étape 96), sur le VRAI composant et le vrai CSS compilé.
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
    await page.waitForSelector('.chat-panel__bar')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('la barre nomme la conversation en cours, la liste ne s\'ouvre qu\'à la demande', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.textContent('.chat-panel__picker-title'), 'parle moi des chats')
    assert.equal(await page.locator('.chat-panel__picker').count(), 0)

    await page.click('.chat-panel__picker-toggle')
    await page.waitForSelector('.chat-panel__picker')
    assert.equal(await page.locator('.chat-panel__picker li').count(), 2)
    // La conversation ouverte est signalée dans la liste.
    assert.equal(await page.locator('.chat-panel__picker-item--active').count(), 1)
  })
})

test('changer de conversation recharge VRAIMENT le fil affiché', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.chat-panel__message')
    assert.match(await page.textContent('.chat-panel__thread'), /chats dorment/)

    await page.click('.chat-panel__picker-toggle')
    await page.click('.chat-panel__picker li:nth-child(2) .chat-panel__picker-item')

    await page.waitForFunction(() => document.querySelector('.chat-panel__thread').textContent.includes('crêpes'))
    const thread = await page.textContent('.chat-panel__thread')
    assert.doesNotMatch(thread, /chats dorment/, "les messages de l'ancien fil sont restés à l'écran")
    assert.equal(await page.textContent('.chat-panel__picker-title'), 'recette de crêpes')
    // La liste se referme après le choix : on revient à la discussion.
    assert.equal(await page.locator('.chat-panel__picker').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__calls), [['select', 'b']])
  })
})

test('"Nouvelle conversation" ouvre un fil vide', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.chat-panel__message')
    await page.click('.chat-panel__new')

    await page.waitForFunction(() => document.querySelectorAll('.chat-panel__message').length === 0)
    assert.equal(await page.textContent('.chat-panel__picker-title'), 'Nouvelle conversation')
    assert.deepEqual(await page.evaluate(() => window.__calls), [['create']])
  })
})

test('supprimer une conversation demande confirmation', options, async () => {
  await withPage(async (page) => {
    await page.click('.chat-panel__picker-toggle')
    await page.click('.chat-panel__picker li:nth-child(2) .chat-panel__picker-delete')
    await page.waitForSelector('.chat-panel__picker-confirm')
    // Rien n'est supprimé tant que la confirmation n'est pas validée.
    assert.deepEqual(await page.evaluate(() => window.__calls), [])

    await page.click('.chat-panel__picker-confirm-no')
    assert.equal(await page.locator('.chat-panel__picker-confirm').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__calls), [])

    await page.click('.chat-panel__picker li:nth-child(2) .chat-panel__picker-delete')
    await page.click('.chat-panel__picker-confirm-yes')
    await page.waitForFunction(() => window.__calls.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__calls), [['delete', 'b']])
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
