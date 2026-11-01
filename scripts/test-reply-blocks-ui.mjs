import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 380 (Léo : « sur ChatGPT ils ont ajouté l'UI, on peut faire pareil ») : les blocs interactifs dans le VRAI
 * Chat (ChatPanel), avec le vrai CSS compilé. Ce que ça protège : qu'un clic sur un choix ENVOIE vraiment ce choix
 * (et seulement depuis la dernière réponse), que les cases, le calculateur et le survol du graphique réagissent, et
 * que rien ne déborde en fenêtre étroite.
 *
 * Playwright n'est pas une dépendance du projet (absent du runner Windows de la CI) : tests ignorés s'il manque.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-reply-blocks-entry.tsx')
const fence = (json) => '\n```jaris-ui\n' + JSON.stringify(json) + '\n```\n'

const THREAD = [
  // Étape 403 : une liste de courses écrite en simples puces par le modèle, sans bloc checklist.
  { role: 'user', content: 'fais-moi une liste de courses pour des crêpes' },
  { role: 'assistant', content: 'Il te faut :\n- Farine\n- Œufs\n- Lait' },
  { role: 'user', content: 'une question ?' },
  { role: 'assistant', content: 'Choisis :' + fence({ type: 'choices', options: ['Vieux A', 'Vieux B'] }) },
  { role: 'user', content: 'compare et calcule' },
  {
    role: 'assistant',
    content:
      'Voici la météo :' +
      fence({ type: 'chart', kind: 'bar', title: 'Températures', unit: '°C', labels: ['Lun', 'Mar', 'Mer'], values: [12, 15, 9] }) +
      'Les courses :' +
      fence({ type: 'checklist', title: 'Courses', items: ['Pain', 'Lait', 'Œufs'] }) +
      'Le prix :' +
      fence({
        type: 'calculator',
        title: 'Remise',
        inputs: [
          { name: 'prix', label: 'Prix', value: 100, unit: '€' },
          { name: 'remise', label: 'Remise', value: 20, unit: '%' }
        ],
        outputs: [{ label: 'Prix final', formula: 'prix*(1-remise/100)', unit: '€' }]
      }) +
      'Un tableau large :' +
      fence({
        type: 'table',
        columns: ['Modèle', 'Prix', 'Autonomie', 'Poids', 'Couleur', 'Garantie'],
        rows: [['Un nom de modèle vraiment très long', '1 299 €', '12 h', '1,4 kg', 'Gris sidéral', '2 ans']]
      }) +
      'Et toi ?' +
      fence({ type: 'choices', title: 'Lequel préfères-tu ?', options: ['Choix A', 'Choix B'] })
  }
]

const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/ChatPanel'

const THREADS = { a: ${JSON.stringify(THREAD)} }
window.__state = {
  activeId: 'a',
  conversations: [{ id: 'a', title: 'blocs', createdAt: '', updatedAt: '2026-11-01T10:00:00.000Z', messageCount: 6 }]
}
window.__calls = []
window.__sent = []
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
  // Étape 325 : le test envoie lui-même une ligne du journal (window.__log), comme le main pendant une réponse.
  onLog: (cb) => {
    window.__log = cb
    return () => {}
  },
  onChatStreamToken: () => () => {},
  // Étape 346 : le test annonce lui-même une réponse en cours ailleurs (petit widget), comme le main.
  getChatBusy: () => Promise.resolve(false),
  onChatBusy: (cb) => {
    window.__busy = cb
    return () => {}
  },
  onChatHistoryChanged: (cb) => {
    window.__historyChanged = cb
    return () => {}
  },
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
    window.__sent.push(prompt)
    return Promise.resolve({ role: 'assistant', content: 'Bien noté.' })
  },
  cancelChat: () => {
    window.__calls.push(['cancel'])
    window.__stopChat?.()
  }
}


createRoot(document.getElementById('root')).render(<Panel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-reply-blocks-'))
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
  rmSync(outDir, { recursive: true, force: true })
  return pageHtml
}

/** try/finally : sinon une assertion qui échoue laisse Chromium ouvert et `node --test` ne se termine jamais. */
async function withPage(run, width = 1100) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.reply-ui--choices')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('un clic sur un choix de la dernière réponse l’envoie ; ceux d’une ancienne réponse ne sont pas cliquables', options, async () => {
  await withPage(async (page) => {
    const old = page.locator('.reply-ui__choice', { hasText: 'Vieux A' })
    assert.equal(await old.isDisabled(), true, 'un choix d’une ancienne réponse partirait hors de propos')
    await page.click('.reply-ui__choice:has-text("Choix B")')
    await page.waitForFunction(() => window.__sent.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__sent), ['Choix B'])
    // Le choix fait reste visible et marqué ; plus aucun autre ne part.
    assert.equal(await page.locator('.reply-ui__choice--chosen').textContent(), 'Choix B')
  })
})

test('liste à cocher : un clic coche, raye et compte', options, async () => {
  await withPage(async (page) => {
    const block = page.locator('.reply-ui--checklist')
    assert.equal((await block.locator('.reply-ui__count').textContent()).trim(), '0/3')
    await block.locator('.reply-ui__tick', { hasText: 'Lait' }).click()
    assert.equal((await block.locator('.reply-ui__count').textContent()).trim(), '1/3')
    const deco = await block
      .locator('.reply-ui__tick--done .reply-ui__tick-text')
      .evaluate((el) => getComputedStyle(el).textDecorationLine)
    assert.equal(deco, 'line-through')
  })
})

test('calculateur : le résultat suit les valeurs tapées, « — » si une valeur n’est pas un nombre', options, async () => {
  await withPage(async (page) => {
    const block = page.locator('.reply-ui--calculator')
    assert.equal((await block.locator('dd').textContent()).trim(), '80 €')
    await block.locator('input').first().fill('250')
    assert.equal((await block.locator('dd').textContent()).trim(), '200 €')
    await block.locator('input').nth(1).fill('dix')
    assert.equal((await block.locator('dd').textContent()).trim(), '—')
    // Le champ n'a pas récupéré le cadre de la règle générale des champs (il est déjà dans sa propre boîte).
    const border = await block.locator('input').first().evaluate((el) => getComputedStyle(el).borderTopStyle)
    assert.equal(border, 'none')
  })
})

test('graphique : le survol d’une colonne affiche sa valeur exacte', options, async () => {
  await withPage(async (page) => {
    const hit = page.locator('.reply-ui--chart .reply-ui__hit').nth(1)
    await hit.hover()
    assert.equal((await page.locator('.reply-ui__readout').textContent()).trim(), 'Mar : 15 °C')
    // Une seule couleur, celle du texte : pas de couleur vive dans le Chat.
    const fill = await page.locator('.reply-ui__bar').first().evaluate((el) => getComputedStyle(el).fill)
    const [r, g, b] = fill.match(/\d+/g).map(Number)
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 16, `couleur vive dans le graphique : ${fill}`)
  })
})

test('fenêtre étroite : rien ne déborde, un tableau trop large défile dans sa carte', options, async () => {
  await withPage(async (page) => {
    const overflow = await page.evaluate(() => {
      const thread = document.querySelector('.chat-panel__thread')
      return { thread: thread.scrollWidth - thread.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth }
    })
    assert.ok(overflow.thread <= 1, `le fil déborde de ${overflow.thread}px`)
    assert.ok(overflow.page <= 1, `la page déborde de ${overflow.page}px`)
    const card = await page.locator('.reply-ui--table').evaluate((el) => {
      const scroll = el.querySelector('.reply-ui__scroll')
      return { card: el.getBoundingClientRect().right, body: el.closest('.chat-panel__body').getBoundingClientRect().right, scrolls: scroll.scrollWidth > scroll.clientWidth }
    })
    assert.ok(card.card <= card.body + 1, 'la carte du tableau sort de la réponse')
    assert.equal(card.scrolls, true, 'le tableau large devrait défiler dans sa carte')
  }, 620)
})

test('liste de courses en simples puces : chaque ligne se coche quand même ; une liste ordinaire non', options, async () => {
  await withPage(async (page) => {
    const list = page.locator('.reply-ui__ticks--inline')
    assert.equal(await list.count(), 1, 'seule la réponse à la liste de courses devient cochable')
    await list.locator('.reply-ui__tick', { hasText: 'Œufs' }).click()
    const deco = await list.locator('.reply-ui__tick--done .reply-ui__tick-text').evaluate((el) => getComputedStyle(el).textDecorationLine)
    assert.equal(deco, 'line-through')
    assert.equal(await list.locator('.reply-ui__tick--done').count(), 1)
  })
})
