import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 355 — l'écran Duel sur le VRAI composant et le vrai CSS compilé : choix de la catégorie et du nombre de
 * modèles, préparation, A puis B (B attend que Léo ait vérifié A), ce que chaque modèle a fait sur le PC, vote, et
 * fin de session avec les noms révélés. Les noms ne doivent JAMAIS s'afficher avant la fin.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-duel-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import DuelPanel from './src/components/DuelPanel'

const side = (patch = {}) => ({ status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null, ...patch })
window.__side = side
window.__calls = []
window.__plan = window.__plan || {
  category: 'conversation', available: 6, freeDiskGb: 120,
  sizes: [{ count: 4, toDownload: 1, downloadGb: 5.2, fitsDisk: true }, { count: 5, toDownload: 2, downloadGb: 9.8, fitsDisk: true }, { count: 6, toDownload: 3, downloadGb: 15.1, fitsDisk: true }],
  downloadBudgetGb: 115,
  models: [
    { model: 'granite4.2:8b', vramGb: 5.2, reason: null, installed: true },
    { model: 'qwen3.5:9b', vramGb: 6.6, reason: null, installed: true },
    { model: 'ministral-3:8b', vramGb: 6, reason: null, installed: false },
    { model: 'gemma4:12b', vramGb: 8, reason: null, installed: false },
    { model: 'qwen3.8:27b', vramGb: 17, reason: null, installed: true },
    { model: 'devstral-small-2:24b', vramGb: 15, reason: { kind: 'tooBig', needGb: 15, budgetGb: 7 } },
    { model: 'nemotron-3.5-bolt:e4b', vramGb: 7.9, reason: { kind: 'ollama', version: '0.40.10' } }
  ]
}
window.__rankings = window.__rankings || [
  { category: 'conversation', votes: 3, ranking: [{ model: 'granite4.2:8b', score: 120.4, margin: 310, strength: 2, rankBest: 1, rankWorst: 2, wins: 2, losses: 0, ties: 1, duels: 3 }, { model: 'qwen3.5:9b', score: -120.4, margin: 310, strength: 0.5, rankBest: 1, rankWorst: 2, wins: 0, losses: 2, ties: 1, duels: 3 }] },
  { category: 'code', votes: 0, ranking: [] },
  { category: 'voice', votes: 0, ranking: [] }
]
window.__view = window.__view === undefined ? null : window.__view
const listeners = []
window.__emit = (view) => { window.__view = view; listeners.forEach((cb) => cb(view)) }
// Comme le vrai main : chaque réponse à une action de l'écran devient l'état courant de la session.
const ready = (round) => (window.__view = { id: 'session-1', category: window.__category || 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: window.__votes || 0, round, error: null })
window.__ready = ready

window.jaris = {
  onDuelChanged: (cb) => { listeners.push(cb); return () => {} },
  duelState: async () => window.__view,
  duelPlan: async (category) => { window.__calls.push(['plan', category]); return { ...window.__plan, category } },
  duelRankings: async () => window.__rankings,
  duelStart: async (category, count, series) => {
    window.__calls.push(series === undefined ? ['start', category, count] : ['start', category, count, series])
    window.__category = category
    return { id: 'session-1', category, phase: 'preparing', modelCount: count, preparing: { done: 0, total: 2, percent: 37, installed: 3 }, dropped: 0, votes: 0, round: null, error: null }
  },
  duelAsk: async (prompt) => {
    window.__calls.push(['ask', prompt])
    return ready({ number: 1, prompt, a: side({ status: 'running', startedAt: Date.now() - 4000, activity: { kind: 'thinking' } }), b: side() })
  },
  duelRunB: async () => {
    window.__calls.push('runB')
    const r = window.__view.round
    return ready({ ...r, b: side({ status: 'running', startedAt: Date.now(), activity: { kind: 'writing' } }) })
  },
  duelStop: async () => { window.__calls.push('stop') },
  duelVote: async (outcome) => {
    window.__calls.push(['vote', outcome])
    window.__votes = (window.__votes || 0) + 1
    // Étape 358 : le même duel, noms révélés juste après le vote.
    return ready({ ...window.__view.round, revealed: { a: 'qwen3.8:27b', b: 'granite4.2:8b', outcome } })
  },
  duelNext: async () => {
    window.__calls.push('next')
    return ready({ number: 2, prompt: null, a: side(), b: side(), revealed: null })
  },
  duelEnd: async (force) => {
    window.__calls.push(force ? ['end', 'force'] : 'end')
    return window.__summary
  },
  duelSeriesMove: async () => {
    window.__calls.push('seriesMove')
    if (window.__moveError) throw new Error(window.__moveError)
    return (window.__view = { ...window.__view, series: { ...window.__view.series, waiting: null } })
  },
  duelClose: async () => { window.__calls.push('close') },
  duelAudio: async () => null,
  duelDeleteModels: async (models) => { window.__calls.push(['delete', models]); return { deleted: models, failed: [] } },
  getProfile: async () => window.__profile ?? null,
  duelRemoteSave: async (settings) => {
    window.__calls.push(['remoteSave', settings])
    if (window.__remoteSaveError) throw new Error(window.__remoteSaveError)
    return settings
  },
  duelHistory: async () => { window.__calls.push('history'); return window.__history || [] },
  duelExportVotes: async () => { window.__calls.push('export'); return window.__exportResult || { saved: true, count: 3 } },
  duelHistoryApp: async (id, side) => { window.__calls.push(['historyApp', id, side]); return 'data:text/html,<p>app</p>' },
  duelHistoryCode: async (id, side) => { window.__calls.push(['historyCode', id, side]); return '<html>\\n<body>serpent</body>\\n</html>' },
  duelSideCode: async (side) => { window.__calls.push(['sideCode', side]); return '<html>\\n<body>\\n<h1>Compteur</h1>\\n</body>\\n</html>' },
  duelRetry: async () => {
    window.__calls.push('retry')
    return ready({ ...window.__view.round, a: side({ status: 'running', startedAt: Date.now(), activity: { kind: 'thinking' } }), b: side() })
  },
  duelBatchStart: async (prompts) => {
    window.__calls.push(['batchStart', prompts])
    const batch = prompts.map((prompt, i) => ({ number: i + 1, prompt, a: i < 2 ? 'running' : 'idle', b: i < 2 ? 'running' : 'idle', revealed: null }))
    return (window.__view = { ...ready(null), batch })
  },
  duelBatchOpen: async (number) => {
    window.__calls.push(['batchOpen', number])
    const batch = window.__view.batch
    const item = batch.find((b) => b.number === number)
    const done = side({ status: 'done', text: 'Fini', durationMs: 4000, previewUrl: 'data:text/html,<p>app</p>' })
    return (window.__view = { ...ready({ number, prompt: item.prompt, a: done, b: done, revealed: null, together: false }), batch })
  },
  duelBatchClose: async () => {
    window.__calls.push('batchClose')
    const batch = window.__view.batch
    return (window.__view = { ...ready(null), batch })
  },
  duelSkip: async () => {
    window.__calls.push('skip')
    return ready({ number: 2, prompt: null, a: side(), b: side() })
  }
}
window.__summary = {
  category: 'conversation',
  rounds: [{ prompt: 'Ouvre le Bloc-notes et écris une liste de courses', modelA: 'qwen3.5:9b', modelB: 'granite4.2:8b', outcome: 'b' }],
  ranking: [{ model: 'granite4.2:8b', score: 180, margin: 250, strength: 2.8, rankBest: 1, rankWorst: 1, wins: 3, losses: 0, ties: 1, duels: 4 }, { model: 'qwen3.5:9b', score: -180, margin: 250, strength: 0.35, rankBest: 2, rankWorst: 2, wins: 0, losses: 3, ties: 1, duels: 4 }],
  changes: [{ role: 'medium', from: 'qwen3.5:9b', to: 'granite4.2:8b', applied: true }, { role: 'large', from: 'qwen3.8:27b', to: 'gemma4:26b', applied: false }],
  downloaded: [{ model: 'granite4.2:8b', sizeGb: 5.2, inUse: true }, { model: 'ministral-3:8b', sizeGb: 6.0, inUse: false }]
}

createRoot(document.getElementById('root')).render(<DuelPanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-duel-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, init = '', size = { width: 1280, height: 860 }) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize(size)
    await page.setContent(init ? html.replace('<body>', `<body><script>${init}</script>`) : html)
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const NAMES = ['qwen3.5', 'granite4.2', 'ministral', 'gemma4', 'Qwen3.5', 'Granite']

/** Laisse React finir son rendu après un évènement simulé (piège noté à l'étape 324). */
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

test('accueil : trois catégories (Conversation, Code, Vocal — pas d’images), le nombre de modèles, ce qui sera téléchargé', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-category')
    assert.deepEqual(await page.locator('.duel-category__name').allTextContents(), ['Conversation', 'Code', 'Vocal'])
    assert.equal(await page.locator('.duel-category[aria-checked="true"] .duel-category__name').textContent(), 'Conversation')
    await page.waitForSelector('.duel-size')
    assert.deepEqual(await page.locator('.duel-sizes:not(.duel-pickmode):not(.duel-remote__mode) .duel-size').allTextContents(), ['4', '5', '6'])
    assert.equal(await page.locator('.duel-sizes:not(.duel-pickmode):not(.duel-remote__mode) .duel-size[aria-checked="true"]').textContent(), '5', '5 modèles par défaut')
    assert.match(await page.textContent('.duel-home'), /Modèles à télécharger : 2 \(9,8 Go\)/)
    await page.click('.duel-size:has-text("4")')
    assert.match(await page.textContent('.duel-home'), /Modèles à télécharger : 1 \(5,2 Go\)/)
    // Le classement des votes déjà donnés, avec les noms : ce sont des duels passés, plus rien n'est anonyme.
    assert.match(await page.textContent('.duel-ranking__list'), /granite4\.2.*Victoires 2 · Défaites 0 · Égalités 1/s)
    // Étape 358, comme Arena : points (tous partent de 0), marge à 95 % et rangs possibles.
    assert.match(await page.textContent('.duel-ranking__list'), /granite4\.2.*\+120 pts ± 310 · Rang 1 à 2/s)
    assert.match(await page.textContent('.duel-ranking__list'), /qwen3\.5.*-120 pts ± 310/s)
    assert.match(await page.textContent('.duel-ranking'), /Tous les modèles partent de 0 point/)
    // Changer de catégorie redemande ce que la session téléchargerait.
    await page.click('.duel-category:has-text("Code")')
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'plan' && c[1] === 'code'))
    assert.match(await page.textContent('.duel-ranking'), /Pas encore de vote/)
    await page.click('.duel-home__start')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'start'), ['start', 'code', 4])
  })
})

test('accueil : pas assez de place sur le disque ou pas assez de modèles — on ne peut pas lancer, et on sait pourquoi', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-size')
      assert.match(await page.textContent('.duel-home__note--warn'), /Pas assez de place sur le disque \(libre : 3 Go\)/)
      assert.equal(await page.isDisabled('.duel-home__start'), true)
    },
    "window.__plan = { category: 'conversation', available: 6, freeDiskGb: 3, sizes: [{ count: 5, toDownload: 2, downloadGb: 9.8, fitsDisk: false }] }"
  )
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-home__note--warn')
      assert.match(await page.textContent('.duel-home__note--warn'), /Pas assez de modèles pour un duel/)
      // La cause se voit : ce que Jaris a détecté sur ce PC, et combien de modèles conviennent.
      assert.match(await page.textContent('.duel-home__note--warn'), /aucune carte graphique détectée, 16 Go de RAM\. Modèles qui conviennent : 1\./)
      assert.equal(await page.isDisabled('.duel-home__start'), true)
    },
    "window.__plan = { category: 'conversation', available: 1, freeDiskGb: 100, sizes: [], machine: { vramGb: null, ramGb: 16 } }"
  )
})

test('étape 377 : les modèles sur une autre machine — adresse, carte et RAM enregistrées, connexion dite, rien ne part si elle ne répond pas', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-remote')
    assert.equal(await page.locator('.duel-remote__mode .duel-size[aria-checked="true"]').textContent(), 'Sur ce PC', 'ce PC par défaut')
    assert.equal(await page.locator('.duel-remote__fields').count(), 0, 'aucun champ tant que ce PC est choisi')
    await page.click('.duel-remote__mode .duel-size:has-text("Sur une autre machine")')
    assert.equal(await page.locator('.duel-remote__fields input').count(), 3)
    assert.match(await page.textContent('.duel-remote'), /Jaris, ses outils et les actions restent sur ton PC/)
    assert.match(await page.textContent('.duel-remote'), /passent par cette machine/)
    const before = (await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'plan').length
    await page.fill('.duel-remote__field--host input', 'pod123-11434.proxy.runpod.net')
    const [vram, ram] = await page.locator('.duel-remote__field:not(.duel-remote__field--host) input').all()
    await vram.fill('288')
    await ram.fill('188,5')
    await page.evaluate(() => {
      window.__plan = { ...window.__plan, machine: { vramGb: 288, ramGb: 188 }, remote: { host: 'https://pod123-11434.proxy.runpod.net', version: '0.40.10', error: null } }
    })
    await page.click('.duel-remote__actions .duel-btn')
    await page.waitForSelector('.duel-remote__status')
    const saved = (await page.evaluate(() => window.__calls)).find((c) => c[0] === 'remoteSave')
    assert.deepEqual(saved, ['remoteSave', { enabled: true, host: 'pod123-11434.proxy.runpod.net', vramGb: 288, ramGb: 188.5 }], 'nombres envoyés comme nombres, virgule comprise')
    assert.ok((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'plan').length > before, 'le plan est recalculé pour l’autre machine')
    assert.equal(await page.textContent('.duel-remote__status'), 'Connecté : Ollama 0.40.10.')
    assert.equal(await page.isDisabled('.duel-home__start'), false)
    // Revenir à ce PC s'applique tout de suite, sans perdre l'adresse.
    await page.click('.duel-remote__mode .duel-size:has-text("Sur ce PC")')
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'remoteSave').length === 2)
    assert.equal((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'remoteSave')[1][1].enabled, false)
  })
  // Une machine enregistrée qui ne répond pas : la raison s'affiche et rien ne peut commencer.
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-remote [role="alert"]')
      assert.equal(await page.inputValue('.duel-remote__field--host input'), 'https://pod123-11434.proxy.runpod.net', 'réglage relu au retour')
      assert.match(await page.textContent('.duel-remote [role="alert"]'), /ne répond pas/)
      assert.equal(await page.isDisabled('.duel-home__start'), true)
    },
    "window.__profile = { name: 'Léo', duelRemote: { enabled: true, host: 'https://pod123-11434.proxy.runpod.net', vramGb: 288, ramGb: 188 } }; window.__plan = { category: 'conversation', available: 6, freeDiskGb: null, sizes: [{ count: 5, toDownload: 0, downloadGb: 0, fitsDisk: true }], machine: { vramGb: 288, ramGb: 188 }, remote: { host: 'https://pod123-11434.proxy.runpod.net', version: null, error: 'La machine des modèles ne répond pas.' } }"
  )
  // Une adresse refusée par le main : son message s'affiche.
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-remote')
      await page.click('.duel-remote__mode .duel-size:has-text("Sur une autre machine")')
      await page.click('.duel-remote__actions .duel-btn')
      await page.waitForSelector('.duel-remote [role="alert"]')
      assert.match(await page.textContent('.duel-remote [role="alert"]'), /Adresse invalide/)
    },
    "window.__remoteSaveError = 'Adresse invalide : colle l’adresse complète.'"
  )
})

test('étape 379 : en Code, A et B écrivent en même temps — la carte de B montre son travail, pas un bouton « Lancer B »', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-round__together')
      assert.match(await page.textContent('.duel-round__together'), /en même temps/)
      assert.equal(await page.locator('.duel-side--idle').count(), 0, 'pas de carte « en attente » pour B')
      assert.equal(await page.locator('button:has-text("Au tour du modèle B")').count(), 0)
    },
    "var s = { status: 'running', text: '', activity: { kind: 'thinking' }, startedAt: Date.now(), durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null }; window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null, round: { number: 1, prompt: 'Un compteur', a: s, b: s, revealed: null, together: true } }"
  )
})

test('préparation : l’avancement du téléchargement, sans nom de modèle', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-home__start:not([disabled])')
    await page.click('.duel-home__start')
    await page.waitForSelector('.duel-preparing')
    assert.match(await page.textContent('.duel-preparing'), /Téléchargement du modèle 1 sur 2/)
    assert.match(await page.textContent('.duel-preparing'), /37\s%/)
    // Étape 365 (Léo : « je choisis 7 modèles, ça met téléchargement des 5 ») : ceux déjà sur le PC sont dits.
    assert.match(await page.textContent('.duel-preparing__step'), /Déjà sur ton PC\s:\s3/)
    assert.equal(await page.$eval('.duel-progress__fill', (el) => el.style.width), '37%')
  })
})

test('un duel : A répond et agit, B attend qu’on ait vérifié, puis le vote — sans jamais un nom de modèle à l’écran', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel__ask .empty-state')
      assert.match(await page.textContent('.duel__bar'), /Duel 1 · Conversation/)
      // Une suggestion remplit le champ, Entrée envoie au modèle A.
      // Étape 372 : 4 idées tirées au hasard parmi 10 ; « Autres idées » en montre 4 autres, jamais les mêmes.
      const ideas = () => page.$$eval('.empty-state__suggestion', (els) => els.map((el) => el.textContent ?? ''))
      const first = await ideas()
      assert.equal(first.length, 4, `4 idées attendues : ${first}`)
      assert.ok(first.every((text) => text && !text.startsWith('duel.suggest')), `idées traduites : ${first}`)
      await page.click('.empty-state__more')
      const second = await ideas()
      assert.equal(second.length, 4)
      assert.ok(second.every((text) => !first.includes(text)), `d'autres idées attendues : ${first} / ${second}`)
      const picked = second[0]
      await page.click('.empty-state__suggestion >> nth=0')
      assert.equal(await page.inputValue('.composer__input'), picked)
      await page.click('.composer__send')
      await page.waitForSelector('.duel-side--running')
      assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'ask'), ['ask', picked])
      assert.equal(await page.locator('.composer').count(), 0, 'plus de champ : une seule demande par duel')
      assert.match(await page.textContent('.duel-side--running'), /Réfléchit/)
      assert.match(await page.textContent('.duel-side--idle'), /Le modèle B répondra quand le modèle A aura fini/)
      assert.equal(await page.locator('.duel-side--idle button').count(), 0, 'B ne peut pas partir avant la fin de A')

      // A a fini : ce qu'il a fait sur le PC, à vérifier, puis le bouton pour lancer B.
      await page.evaluate(() => {
        const r = window.__view.round
        window.__emit(window.__ready({ ...r, a: window.__side({ status: 'done', durationMs: 12000, text: 'C’est fait : **Bloc-notes** ouvert avec ta liste.', actions: [{ tool: 'open_app', detail: 'Bloc-notes' }, { tool: 'type_text', detail: 'Lait, œufs, pain' }] }) }))
      })
      await settle(page)
      assert.match(await page.textContent('.duel-side--done .duel-side__status'), /Fini en 12 s/)
      assert.deepEqual(await page.locator('.duel-side--done .duel-side__actions li').allTextContents(), [
        'Ouvrir une application : « Bloc-notes »',
        'Écrire du texte : « Lait, œufs, pain »'
      ])
      assert.equal(await page.locator('.duel-side--done strong').textContent(), 'Bloc-notes', 'la réponse est mise en forme comme dans le Chat')
      assert.match(await page.textContent('.duel-side--idle'), /Vérifie ce que le modèle A a fait/)
      await page.click('.duel-side--idle .duel-btn--primary')
      assert.ok((await page.evaluate(() => window.__calls)).includes('runB'))
      await page.waitForSelector('.duel-side--running')
      assert.equal(await page.locator('.duel-vote').count(), 0, 'pas de vote tant que B travaille')

      // B a fini sans rien faire sur le PC : c'est dit, pour que Léo le compare à A.
      await page.evaluate(() => {
        const r = window.__view.round
        window.__emit(window.__ready({ ...r, b: window.__side({ status: 'done', durationMs: 65000, text: 'Je vais ouvrir le Bloc-notes.' }) }))
      })
      await settle(page)
      assert.match(await page.textContent('.duel-round__sides > section:nth-child(2)'), /Aucune action sur ton PC/)
      assert.match(await page.textContent('.duel-round__sides > section:nth-child(2) .duel-side__status'), /Fini en 1 min 05/)
      assert.deepEqual(await page.locator('.duel-vote__button').allTextContents(), ['A est meilleur', 'Égalité', 'B est meilleur', 'Les deux sont nuls'])

      const visible = await page.textContent('.duel')
      for (const name of NAMES) assert.ok(!visible.includes(name), `« ${name} » affiché pendant la session`)

      await page.click('.duel-vote__button:has-text("A est meilleur")')
      assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'vote'), ['vote', 'a'])
      // Étape 358, comme Arena : les noms sont révélés juste après le vote, sur chaque côté et dans le résultat.
      await page.waitForSelector('.duel-vote--revealed')
      assert.equal(await page.locator('.duel-vote__button').count(), 0, 'plus de vote une fois les noms connus')
      assert.deepEqual(await page.locator('.duel-side__model').allTextContents(), ['qwen3.8:27b', 'granite4.2:8b'])
      assert.match(await page.textContent('.duel-vote--revealed'), /Noms révélés/)
      assert.match(await page.textContent('.duel-vote--revealed'), /Gagnant : qwen3\.8:27b/)
      assert.match(await page.textContent('.duel__bar'), /Duel 1 · Conversation/, 'on reste sur ce duel tant qu’on n’a pas demandé le suivant')
      await page.click('.duel-vote--revealed .duel-btn--primary')
      assert.ok((await page.evaluate(() => window.__calls)).includes('next'))
      await page.waitForSelector('.duel__ask .empty-state')
      assert.equal(await page.locator('.duel-side__model').count(), 0, 'le duel suivant est de nouveau anonyme')
      assert.match(await page.textContent('.duel__bar'), /Duel 2 · Conversation/)
      assert.match(await page.textContent('.duel__bar'), /Votes : 1/)
    },
    "window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, round: { number: 1, prompt: null, a: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null }, b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null } }, error: null }"
  )
})

test('fin de session : les noms révélés, ce qui change pour Jaris, et la suppression des seuls modèles inutilisés', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel__bar-end')
      await page.click('.duel__bar-end')
      await page.evaluate(() => window.__emit({ ...window.__view, phase: 'ended', round: null }))
      await page.waitForSelector('.duel-summary__rounds')
      assert.match(await page.textContent('.duel-summary__round'), /qwen3\.5:9b contre granite4\.2:8b/i)
      assert.match(await page.textContent('.duel-summary__round'), /Gagnant : granite4\.2:8b/i)
      const changes = await page.locator('.duel-summary__changes li').allTextContents()
      assert.match(changes[0], /Moyen : qwen3\.5:9b → granite4\.2:8b.*En service/i)
      assert.match(changes[1], /Élevé : qwen3\.8:27b → gemma4:26b.*Retester la configuration/i)
      // granite (utilisé désormais) n'est jamais proposé à la suppression ; ministral, si.
      assert.match(await page.textContent('.duel-summary__downloads'), /granite4\.2:8b.*Utilisé par Jaris/i)
      assert.equal(await page.textContent('.duel-summary__section > .duel-btn:not(.duel-btn--primary)'), 'Supprimer les modèles téléchargés (6 Go)')
      await page.click('.duel-summary__section > .duel-btn:not(.duel-btn--primary)')
      assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'delete'), ['delete', ['ministral-3:8b']])
      await page.waitForFunction(() => /Supprimé/.test(document.querySelector('.duel-summary__downloads').textContent))
      // Une seule demande de bilan : un second appel ne verrait plus les changements déjà appliqués.
      assert.equal((await page.evaluate(() => window.__calls)).filter((c) => c === 'end').length, 1)
      await page.click('.duel-summary__again')
      await page.evaluate(() => window.__emit(null))
      await page.waitForSelector('.duel-category')
    },
    "window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 1, round: { number: 2, prompt: null, a: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null }, b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null } }, error: null }"
  )
})

test('mise en page : réellement habillé par le CSS, aucun débordement de côté, pas de texte sous 12 px, A et B côte à côte', options, async () => {
  const init =
    "window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 2, round: { number: 3, prompt: 'Ouvre le Bloc-notes et écris une liste de courses', a: { status: 'done', text: 'C’est fait.', activity: null, startedAt: null, durationMs: 12000, actions: [{ tool: 'open_app', detail: 'Bloc-notes' }], previewUrl: null, audio: false, audioError: null, error: null }, b: { status: 'done', text: 'Voilà.', activity: null, startedAt: null, durationMs: 9000, actions: [], previewUrl: null, audio: false, audioError: null, error: null } }, error: null }"
  for (const size of [{ width: 1280, height: 860 }, { width: 760, height: 700 }]) {
    await withPage(
      async (page) => {
        await page.waitForSelector('.duel-vote__button')
        const layout = await page.evaluate(() => {
          const sides = [...document.querySelectorAll('.duel-round__sides > .duel-side')].map((el) => el.getBoundingClientRect())
          const vote = getComputedStyle(document.querySelector('.duel-vote__button'))
          const tiny = [...document.querySelectorAll('.duel *')].filter(
            (el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12
          )
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            sideBySide: Math.abs(sides[0].top - sides[1].top) < 2 && sides[1].left > sides[0].right,
            stacked: sides[1].top >= sides[0].bottom,
            voteRounded: parseFloat(vote.borderTopLeftRadius) > 10,
            voteBordered: vote.borderTopStyle !== 'none',
            tiny: tiny.map((el) => el.className)
          }
        })
        assert.equal(layout.overflow, 0, `${size.width}px : défilement de côté`)
        if (size.width >= 1000) assert.equal(layout.sideBySide, true, 'A et B côte à côte')
        else assert.equal(layout.stacked, true, `${size.width}px : A au-dessus de B`)
        assert.equal(layout.voteRounded && layout.voteBordered, true, 'boutons de vote habillés par le CSS de Jaris')
        assert.deepEqual(layout.tiny, [], 'texte sous 12 px')
      },
      init,
      size
    )
  }
})

/**
 * Étape 366 (capture de Léo) : dans le Duel, les retours à la ligne d'une réponse disparaissaient (« …contexte). Règles
 * du jeu » collé au texte), et deux sous-puces sous « 2. » faisaient afficher « 5. » au lieu de « 3. ».
 */
test('étape 366 : une réponse garde ses retours à la ligne, ses sous-puces et sa numérotation', options, async () => {
  const reply = [
    'Je vous propose un mini-jeu dans ce contexte.',
    '**Règles du jeu**',
    '1. **Objectif** : le plus long serpent.',
    '2. **Contrôles** :',
    '   - Les flèches du clavier.',
    '   - Rien à taper ici.',
    '3. **Croissance** : il grandit.',
    '---',
    'Veuillez indiquer votre première direction.'
  ].join('\n')
  const init = `window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0,
    round: { number: 1, prompt: 'Fais un jeu style slither.io',
      a: { status: 'done', text: ${JSON.stringify(reply)}, activity: null, startedAt: 1, durationMs: 392000, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null },
      b: { status: 'done', text: 'Voilà.', activity: null, startedAt: 1, durationMs: 105000, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null } } }`
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-side__text ol')
      const shown = await page.evaluate(() => {
        const box = document.querySelector('.duel-side__text')
        const intro = document.createRange()
        intro.selectNodeContents(box.firstChild)
        const title = box.querySelector(':scope > strong')
        const ol = box.querySelector(':scope > ol')
        const rule = box.querySelector(':scope > hr')
        return {
          whiteSpace: getComputedStyle(box).whiteSpace,
          titleBelowIntro: title.getBoundingClientRect().top >= intro.getBoundingClientRect().bottom - 1,
          topItems: [...ol.children].filter((el) => el.tagName === 'LI').length,
          nestedInSecond: ol.children[1].querySelectorAll(':scope > ul > li').length,
          start: ol.getAttribute('start'),
          ruleHeight: rule ? rule.getBoundingClientRect().height : null,
          ruleBorder: rule ? getComputedStyle(rule).borderTopStyle : null,
          dashes: box.textContent.includes('---')
        }
      })
      assert.equal(shown.whiteSpace, 'pre-wrap', 'les retours à la ligne sont gardés, comme dans le Chat')
      assert.equal(shown.titleBelowIntro, true, '« Règles du jeu » sur sa propre ligne')
      assert.equal(shown.topItems, 3, 'trois éléments numérotés : 1, 2, 3')
      assert.equal(shown.nestedInSecond, 2, 'les sous-puces sont DANS le 2e élément')
      assert.equal(shown.start, null)
      assert.equal(shown.ruleBorder, 'solid', 'le séparateur est un vrai trait')
      assert.ok(shown.ruleHeight !== null && shown.ruleHeight <= 2)
      assert.equal(shown.dashes, false)
      const margins = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.duel-side__text > hr'))
        return [parseFloat(style.marginTop), parseFloat(style.marginBottom)]
      })
      assert.ok(margins[0] >= 10 && margins[1] >= 10, `le trait reste espacé (${margins})`)
    },
    init
  )
})

test('outil de Jaris en panne : le côté le dit, le vote disparaît, « Rejouer » et « Passer » le remplacent', options, async () => {
  const init = `
    window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 1, error: null,
      round: { number: 2, prompt: 'Quel temps fera-t-il demain ?',
        a: { status: 'done', text: "Échec de l'outil : recherche impossible.", activity: null, startedAt: 1, durationMs: 4000, actions: [{ tool: 'search_web', detail: 'météo demain' }], previewUrl: null, audio: false, audioError: null, error: null,
             trouble: { tool: 'search_web', message: 'Recherche impossible : vérification anti-robot.' } },
        b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null } } }`
  await withPage(async (page) => {
    await page.waitForSelector('.duel-side__trouble')
    assert.match(await page.textContent('.duel-side__trouble'), /Un outil de Jaris a échoué \(Chercher sur internet\) : ce n'est pas la faute du modèle\./)
    assert.match(await page.textContent('.duel-side__trouble'), /anti-robot/)
    assert.equal((await page.$('.duel-side--idle .duel-btn--primary')) === null, true, 'B ne peut plus départager un duel gâché')
    assert.equal(await page.$$eval('.duel-vote__button', (els) => els.length), 0, 'aucun bouton de vote')
    assert.match(await page.textContent('.duel-vote--trouble'), /Ce duel ne compte pas/)
    const buttons = await page.$$eval('.duel-vote--trouble button', (els) => els.map((el) => el.textContent))
    assert.deepEqual(buttons, ['Rejouer ce duel', 'Passer sans voter'])
    // Habillé comme un avertissement, pas comme une erreur rouge.
    const border = await page.$eval('.duel-side__trouble', (el) => getComputedStyle(el).borderTopStyle)
    assert.equal(border, 'solid')
    await page.click('.duel-vote--trouble .duel-btn--primary')
    await page.waitForFunction(() => window.__calls.includes('retry'))
    await page.waitForSelector('.duel-side--running')
    assert.equal((await page.$('.duel-vote--trouble')) === null, true, 'pendant le nouvel essai, plus de panneau')
  }, init)
})

test('passer un duel gâché revient à la demande suivante, sans vote', options, async () => {
  const init = `
    window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null,
      round: { number: 1, prompt: 'Lis cette page',
        a: { status: 'done', text: 'ok', activity: null, startedAt: 1, durationMs: 1000, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null },
        b: { status: 'done', text: 'ko', activity: null, startedAt: 1, durationMs: 1000, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: { tool: 'read_web_page', message: 'Page injoignable.' } } } }`
  await withPage(async (page) => {
    await page.waitForSelector('.duel-vote--trouble')
    assert.equal(await page.$$eval('.duel-vote__button', (els) => els.length), 0, 'les deux ont fini, mais on ne vote pas un duel gâché')
    await page.click('.duel-vote--trouble .duel-btn:not(.duel-btn--primary)')
    await page.waitForSelector('.composer')
    const calls = await page.evaluate(() => window.__calls)
    assert.ok(calls.includes('skip'))
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === 'vote'))
  }, init)
})

const HISTORY = `window.__history = [
  { id: 'v3', category: 'conversation', at: Date.now() - 60000, prompt: 'Ouvre le Bloc-notes et écris une liste', outcome: 'a', modelA: 'ministral-3:8b', modelB: 'gemma4:e4b',
    sides: { a: { text: 'C’est **fait**.', actions: [{ tool: 'open_app', detail: 'Bloc-notes' }], durationMs: 14000, error: null, app: false },
             b: { text: 'Je ne peux pas.', actions: [], durationMs: 5000, error: null, app: false } } },
  { id: 'v2', category: 'code', at: Date.now() - 3600000, prompt: 'Un jeu du serpent', outcome: 'b', modelA: 'qwen3.8:27b', modelB: 'granite4.2:8b',
    sides: { a: { text: '', actions: [], durationMs: 90000, error: null, app: true }, b: { text: '', actions: [], durationMs: 60000, error: null, app: true } } },
  { id: 'v1', category: 'voice', at: Date.now() - 90000000, prompt: 'Quelle heure est-il ?', outcome: 'tie', modelA: 'gemma4:e4b', modelB: 'ministral-3:8b', sides: null }
]`

test('historique : un petit bouton ouvre tous les duels, avec les réponses et les noms (révélés dès le vote)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-history-button')
    await page.click('.duel-history-button')
    await page.waitForSelector('.duel-history__item')
    assert.equal(await page.$$eval('.duel-history__item', (els) => els.length), 3)
    const first = await page.textContent('.duel-history__item:nth-child(1)')
    assert.match(first, /ministral-3:8b contre gemma4:e4b|ministral-3:8b/)
    assert.match(first, /Gagnant : ministral-3:8b/)
    assert.match(await page.textContent('.duel-history__item:nth-child(2)'), /Gagnant : granite4.2:8b/)
    // Les réponses : déplier, voir ce que chaque modèle a fait et dit.
    await page.click('.duel-history__item:nth-child(1) .duel-history__toggle')
    await page.waitForSelector('.duel-history__item:nth-child(1) .duel-history__sides')
    const sides = await page.textContent('.duel-history__item:nth-child(1) .duel-history__sides')
    assert.match(sides, /Ouvrir une application : « Bloc-notes »/)
    assert.match(sides, /Je ne peux pas\./)
    assert.equal(await page.textContent('.duel-history__item:nth-child(1) .duel-side__text strong'), 'fait')
    // Un duel Code : l'application se rouvre dans l'aperçu.
    await page.click('.duel-history__item:nth-child(2) .duel-history__toggle')
    await page.click('.duel-history__item:nth-child(2) .duel-history__open-app')
    await page.waitForSelector('.duel-history__item:nth-child(2) iframe.duel-side__preview')
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'historyApp' && c[1] === 'v2' && c[2] === 'a'))
    // Un vieux duel sans réponses gardées : le dit au lieu d'un cadre vide.
    await page.click('.duel-history__item:nth-child(3) .duel-history__toggle')
    assert.match(await page.textContent('.duel-history__item:nth-child(3)'), /n'ont pas été gardées/)
    // Filtre : seulement le Code.
    await page.click('.duel-history__filter:has-text("Code")')
    assert.equal(await page.$$eval('.duel-history__item', (els) => els.length), 1)
    // Retour à l'écran d'avant.
    await page.click('.duel-history__back')
    await page.waitForSelector('.duel-categories')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  }, HISTORY)
})

test('étape 362 : « Télécharger les votes » enregistre tout l’historique et dit combien de votes sont partis', options, async () => {
  await withPage(async (page) => {
    await page.click('.duel-history-button')
    await page.waitForSelector('.duel-history__item')
    const button = '.duel-history__download'
    assert.equal(await page.textContent(button), 'Télécharger les votes')
    // Même famille de boutons que « Retour » : habillé par le CSS de Jaris, sur la même ligne.
    const [back, dl] = await Promise.all(['.duel-history__back', button].map((s) => page.$eval(s, (el) => el.getBoundingClientRect().toJSON())))
    assert.ok(Math.abs(back.top - dl.top) < 4 && dl.left > back.right, 'à droite de « Retour »')
    assert.equal(await page.$eval(button, (el) => getComputedStyle(el).cursor), 'pointer')
    await page.click(button)
    await page.waitForSelector('.duel-history__exported')
    assert.equal(await page.textContent('.duel-history__exported'), 'Votes enregistrés : 3')
    assert.ok((await page.evaluate(() => window.__calls)).includes('export'))
    // Annulé : rien d'affiché. Échec : le vrai message.
    await page.evaluate(() => (window.__exportResult = { saved: false }))
    await page.click(button)
    await page.waitForFunction(() => !document.querySelector('.duel-history__exported') && !document.querySelector('.duel__error'))
    await page.evaluate(() => (window.__exportResult = { saved: false, error: 'Disque plein' }))
    await page.click(button)
    await page.waitForSelector('.duel__error')
    assert.equal(await page.textContent('.duel__error'), 'Disque plein')
  }, HISTORY)
})

test('étape 362 : sans aucun duel voté, rien à télécharger', options, async () => {
  await withPage(async (page) => {
    await page.click('.duel-history-button')
    await page.waitForSelector('.duel-history__download')
    await page.waitForFunction(() => document.querySelector('.duel-home__note')?.textContent?.includes('Aucun duel'))
    assert.equal(await page.$eval('.duel-history__download', (el) => el.disabled), true)
  }, '')
})

test('historique : accessible aussi pendant un duel, sans rien perdre du duel en cours', options, async () => {
  const init = `${HISTORY};
    window.__view = { id: 'session-1', category: 'conversation', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 1, error: null,
      round: { number: 2, prompt: null,
        a: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null },
        b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null } } }`
  await withPage(async (page) => {
    await page.waitForSelector('.duel__bar .duel-history-button')
    await page.click('.duel__bar .duel-history-button')
    await page.waitForSelector('.duel-history__item')
    await page.click('.duel-history__back')
    await page.waitForSelector('.duel__bar')
    assert.match(await page.textContent('.duel__bar'), /Duel 2/)
  }, init, { width: 760, height: 700 })
})

test('étape 363 : « Je choisis » montre tous les modèles, grise ceux que le PC ne peut pas, et exige au moins 4', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-pickmode')
    await page.getByRole('radio', { name: 'Je choisis' }).click()
    await page.waitForSelector('.duel-pick')
    const rows = await page.$$eval('.duel-pick', (els) => els.map((el) => ({ text: el.textContent, disabled: el.disabled })))
    assert.equal(rows.length, 7, 'tous les modèles, même ceux que le PC ne peut pas faire tourner')
    const big = rows.find((r) => r.text.includes('Devstral') || r.text.includes('devstral'))
    assert.equal(big.disabled, true)
    assert.match(big.text, /Trop gros pour ce PC/)
    // Étape 376 : un score d'appel d'outils ne grise plus rien ; une version d'Ollama trop ancienne, oui.
    const tooNew = rows.find((r) => /bolt/i.test(r.text))
    assert.equal(tooNew.disabled, true)
    assert.match(tooNew.text, /0\.40\.10/)
    // Grisé pour de vrai (style calculé), et un clic dessus ne coche rien.
    const greyed = await page.$eval('.duel-pick--unavailable', (el) => getComputedStyle(el).color)
    const normal = await page.$eval('.duel-pick:not(.duel-pick--unavailable)', (el) => getComputedStyle(el).color)
    assert.notEqual(greyed, normal)
    await page.locator('.duel-pick--unavailable').first().click({ force: true })
    assert.equal(await page.$$eval('.duel-pick[aria-checked="true"]', (els) => els.length), 0)

    const start = page.locator('.duel-home__start')
    const enabled = [0, 1, 2]
    for (const i of enabled) await page.locator('.duel-pick:not(:disabled)').nth(i).click()
    assert.equal(await start.isDisabled(), true, 'moins de 4 : on ne peut pas lancer')
    assert.match(await page.textContent('.duel-home'), /Modèles choisis : 3 \(minimum 4\)/)
    await page.locator('.duel-pick:not(:disabled)').nth(3).click()
    assert.match(await page.textContent('.duel-home'), /Modèles choisis : 4/)
    assert.match(await page.textContent('.duel-home'), /Modèles à télécharger : 2/)
    assert.equal(await start.isDisabled(), false)
    // La case cochée est habillée par le CSS de Jaris (fond d'accent), pas une case du navigateur.
    const box = await page.$eval('.duel-pick--checked .duel-pick__box', (el) => getComputedStyle(el).backgroundColor)
    assert.notEqual(box, 'rgba(0, 0, 0, 0)')
    await start.click()
    const call = await page.evaluate(() => window.__calls.find((c) => Array.isArray(c) && c[0] === 'start'))
    assert.deepEqual(call, ['start', 'conversation', ['granite4.2:8b', 'qwen3.5:9b', 'ministral-3:8b', 'gemma4:12b']])
  })
})

test('étape 363 : « Au hasard » garde le nombre de modèles comme avant', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-pickmode')
    assert.equal(await page.getByRole('radio', { name: 'Au hasard' }).getAttribute('aria-checked'), 'true')
    assert.equal(await page.$$eval('.duel-pick', (els) => els.length), 0)
    await page.locator('.duel-home__start').click()
    const call = await page.evaluate(() => window.__calls.find((c) => Array.isArray(c) && c[0] === 'start'))
    assert.deepEqual(call, ['start', 'conversation', 5])
  })
})

test('étape 364 : en duel Code, on voit l’aperçu puis le code de chaque application, numéroté', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-app__view--code')
    // Aperçu par défaut.
    assert.equal(await page.$$eval('.duel-side iframe.duel-side__preview', (els) => els.length), 2)
    await page.click('.duel-side:nth-of-type(1) .duel-app__view--code')
    await page.waitForSelector('.duel-app__code .code-browser__code')
    assert.match(await page.textContent('.duel-app__code .code-browser__code'), /Compteur/)
    assert.equal((await page.textContent('.duel-app__code .code-browser__gutter')).trim(), '1\n2\n3\n4\n5')
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'sideCode' && c[1] === 'a'))
    // L'autre côté garde son aperçu, et le bouton actif est réellement habillé par le CSS.
    assert.equal(await page.$$eval('.duel-side iframe.duel-side__preview', (els) => els.length), 1)
    const style = await page.$eval('.duel-app__view--code', (el) => { const s = getComputedStyle(el); return { radius: s.borderRadius, w: el.getBoundingClientRect().width, pressed: el.getAttribute('aria-pressed') } })
    assert.equal(style.radius, '8px')
    assert.equal(style.w, 34)
    assert.equal(style.pressed, 'true')
    // Retour à l'aperçu.
    await page.click('.duel-side:nth-of-type(1) .duel-app__view--preview')
    assert.equal(await page.$$eval('.duel-side iframe.duel-side__preview', (els) => els.length), 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  }, `window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 4, preparing: null, dropped: 0, votes: 0, error: null,
    round: { number: 1, prompt: 'Un compteur', revealed: null,
      a: { status: 'done', text: '', activity: null, startedAt: 1, durationMs: 30000, actions: [], previewUrl: 'data:text/html,<p>A</p>', audio: false, audioError: null, error: null, trouble: null },
      b: { status: 'done', text: '', activity: null, startedAt: 1, durationMs: 40000, actions: [], previewUrl: 'data:text/html,<p>B</p>', audio: false, audioError: null, error: null, trouble: null } } }`)
})

test('étape 364 : le code d’un duel Code de l’historique se lit aussi', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-history-button')
    await page.click('.duel-history-button')
    await page.click('.duel-history__item:nth-child(2) .duel-history__toggle')
    await page.click('.duel-history__item:nth-child(2) .duel-history__open-app')
    await page.click('.duel-history__item:nth-child(2) .duel-app__view--code >> nth=0')
    await page.waitForSelector('.duel-history__item:nth-child(2) .duel-app__code .code-browser__code')
    assert.match(await page.textContent('.duel-history__item:nth-child(2) .duel-app__code'), /serpent/)
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'historyCode' && c[1] === 'v2' && c[2] === 'a'))
  }, HISTORY)
})

test('étape 365 : en duel Code, la génération montre qu’elle avance (étape, caractères), puis son silence', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-side__progress')
    const first = await page.textContent('.duel-side__progress')
    assert.match(first, /Étape 1 sur 2/)
    assert.match(first, /Caractères de réflexion\s:\s12\s400/)
    // Jamais un ElementHandle dans assert (piège de l'étape 126 : le message d'échec bloque tout) : un booléen.
    assert.equal((await page.$('.duel-side__stall')) === null, true, 'pas d’alerte tant que des fragments arrivent')
    // Le modèle avait commencé puis se tait depuis 45 s : on le dit, comme en mode Code.
    await page.evaluate(() => {
      const r = window.__view.round
      window.__emit(window.__ready({ ...r, a: { ...r.a, activity: { kind: 'writing', code: { step: 2, steps: 2, charsWritten: 3200, thinkingChars: 0, idleMs: 45000, elapsedMs: 600000 } } } }))
    })
    await settle(page)
    const second = await page.textContent('.duel-side__progress')
    assert.match(second, /Étape 2 sur 2/)
    assert.match(second, /Caractères écrits\s:\s3\s200/)
    assert.match(await page.textContent('.duel-side__stall'), /rien reçu du modèle depuis 45 s/)
    const color = await page.$eval('.duel-side__stall', (el) => getComputedStyle(el).color)
    assert.notEqual(color, await page.$eval('.duel-side__progress', (el) => getComputedStyle(el).color), 'l’alerte se distingue')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  }, `window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 4, preparing: null, dropped: 0, votes: 0, error: null,
    round: { number: 1, prompt: 'Un compteur', revealed: null,
      a: { status: 'running', text: '', activity: { kind: 'thinking', code: { step: 1, steps: 2, charsWritten: 0, thinkingChars: 12400, idleMs: 0, elapsedMs: 90000 } }, startedAt: Date.now() - 90000, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null },
      b: { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null } } }`)
})

test('étape 381 : plusieurs demandes Code d’un coup — éditeur, liste des duels, ouverture et retour à la liste', options, async () => {
  await withPage(
    async (page) => {
      await page.click('button:has-text("Plusieurs demandes d\'un coup")')
      await page.waitForSelector('.duel-batch-editor')
      assert.equal(await page.locator('.duel > .composer').count(), 0, 'pas de second champ pendant l’édition')
      const start = page.locator('button:has-text("Lancer les duels")')
      assert.equal(await start.isDisabled(), true, 'il faut au moins 2 demandes')
      await page.fill('.duel-batch-editor__row:nth-child(1) textarea', 'Un compteur')
      await page.fill('.duel-batch-editor__row:nth-child(2) textarea', 'Une horloge')
      await page.click('button:has-text("Remplir avec des idées")')
      await settle(page)
      const filled = await page.$$eval('.duel-batch-editor__row textarea', (els) => els.map((e) => e.value))
      assert.equal(filled.length, 6, 'complété jusqu’à 6 demandes')
      assert.deepEqual(filled.slice(0, 2), ['Un compteur', 'Une horloge'], 'les demandes écrites restent')
      assert.ok(filled.every((v) => v.trim()), 'aucune case vide')
      // Les champs sont habillés et ne débordent pas.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, 'pas de défilement de côté')
      await start.click()
      await page.waitForSelector('.duel-batch__list')
      const sent = await page.evaluate(() => window.__calls.find((c) => c[0] === 'batchStart'))
      assert.equal(sent[1].length, 6)
      const statuses = await page.$$eval('.duel-batch__status', (els) => els.map((e) => e.textContent))
      assert.deepEqual(statuses.slice(0, 3), ['En cours', 'En cours', 'En attente'])
      const item = await page.locator('.duel-batch__item').first().evaluate((el) => ({ cursor: getComputedStyle(el).cursor, bg: getComputedStyle(el).backgroundColor }))
      assert.equal(item.cursor, 'pointer', 'une ligne est réellement un bouton habillé')
      await page.locator('.duel-batch__item').first().click()
      await page.waitForSelector('.duel-vote')
      assert.match(await page.textContent('.duel-round__prompt'), /Un compteur/)
      await page.click('.duel__bar button:has-text("Retour à la liste")')
      await page.waitForSelector('.duel-batch__list')
      const calls = await page.evaluate(() => window.__calls.map((c) => (Array.isArray(c) ? c[0] : c)))
      assert.ok(calls.includes('batchOpen') && calls.includes('batchClose'))
    },
    "var i = { status: 'idle', text: '', activity: null, startedAt: null, durationMs: null, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null }; window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null, round: { number: 1, prompt: null, a: i, b: i, revealed: null, together: false } }"
  )
})

test('étape 381 : dans une file, B attend son tour sans bouton « Au tour du modèle B »', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-side--idle')
      assert.equal(await page.locator('button:has-text("Au tour du modèle B")').count(), 0)
      assert.match(await page.textContent('.duel-side--idle'), /En attente/)
    },
    "var s = { status: 'done', text: 'Fini', activity: null, startedAt: null, durationMs: 3000, actions: [], previewUrl: null, audio: false, audioError: null, error: null, trouble: null }; var i = Object.assign({}, s, { status: 'idle', text: '' }); window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 5, preparing: null, dropped: 0, votes: 0, error: null, batch: [{ number: 1, prompt: 'Un compteur', a: 'done', b: 'idle', revealed: null }], round: { number: 1, prompt: 'Un compteur', a: s, b: i, revealed: null, together: false } }"
  )
})

test('étape 382 : en Code, « Série » — nombre de duels par modèle réglable, total annoncé, PC à laisser allumé', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-category')
    // Pas de série hors Code : en Conversation, les modèles agissent sur le PC.
    assert.equal(await page.locator('.duel-series__mode').count(), 0)
    await page.click('.duel-category:has-text("Code")')
    await page.waitForSelector('.duel-series__mode')
    assert.equal(await page.locator('.duel-series__mode [aria-checked="true"]').textContent(), 'Un duel à la fois', 'désactivée par défaut')
    assert.equal(await page.locator('.duel-home__start').textContent(), 'Lancer la session')
    await page.click('.duel-series__mode button:has-text("Série")')
    assert.equal(await page.locator('.duel-series__value').textContent(), '10', '10 duels par modèle par défaut')
    // 5 modèles × 10 duels / 2 = 25 duels.
    assert.match(await page.textContent('.duel-home'), /Duels au total : environ 25/)
    assert.match(await page.textContent('.duel-home'), /Laisse le PC allumé/)
    // Étape 383 : la série ne garde que deux modèles à la fois — la place à prévoir est celle des deux plus gros
    // (8 + 6 Go), pas le total de tous les téléchargements, qui ne s'affiche plus.
    assert.match(await page.textContent('.duel-series__disk'), /au plus 14 Go sur le disque à la fois/)
    assert.doesNotMatch(await page.textContent('.duel-home'), /Modèles à télécharger/)
    await page.click('button[aria-label="Plus de duels"]')
    await page.click('button[aria-label="Plus de duels"]')
    assert.equal(await page.locator('.duel-series__value').textContent(), '12')
    assert.match(await page.textContent('.duel-home'), /environ 30/)
    await page.click('button[aria-label="Moins de duels"]')
    assert.equal(await page.locator('.duel-home__start').textContent(), 'Lancer la série')
    // Les boutons du réglage sont de vrais boutons habillés.
    const step = await page.locator('.duel-series__step').first().evaluate((el) => ({ w: el.getBoundingClientRect().width, cursor: getComputedStyle(el).cursor }))
    assert.ok(step.w >= 32 && step.cursor === 'pointer')
    await page.click('.duel-home__start')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'start'), ['start', 'code', 5, 11])
  })
})

test('étape 382 : « Tout cocher » prend tous les modèles disponibles, jamais ceux que le PC ne peut pas faire tourner', options, async () => {
  await withPage(async (page) => {
    await page.click('.duel-pickmode button:has-text("Je choisis")')
    await page.waitForSelector('.duel-pick')
    await page.click('button:has-text("Tout cocher")')
    await settle(page)
    assert.equal(await page.locator('.duel-pick[aria-checked="true"]').count(), 5)
    assert.equal(await page.locator('.duel-pick--unavailable[aria-checked="true"]').count(), 0)
    assert.equal(await page.locator('button:has-text("Tout cocher")').isDisabled(), true)
    await page.click('button:has-text("Tout décocher")')
    await settle(page)
    assert.equal(await page.locator('.duel-pick[aria-checked="true"]').count(), 0)
  })
})

test('étape 384 : en série, chaque modèle dit ses duels déjà faits et ce qu’il lui reste ; tout fait → départ bloqué et expliqué', options, async () => {
  const plan = (duels) =>
    `window.__plan = { category: 'code', available: 4, freeDiskGb: 120, downloadBudgetGb: 115, sizes: [{ count: 4, toDownload: 0, downloadGb: 0, fitsDisk: true }], machine: { vramGb: 8, ramGb: 32 }, models: [` +
    `{ model: 'granite4.2:8b', vramGb: 5.2, reason: null, installed: true, duels: ${duels[0]} },` +
    `{ model: 'qwen3.5:9b', vramGb: 6.6, reason: null, installed: true, duels: ${duels[1]} },` +
    `{ model: 'ministral-3:8b', vramGb: 6, reason: null, installed: true, duels: ${duels[2]} },` +
    `{ model: 'gemma4:12b', vramGb: 8, reason: null, installed: true, duels: ${duels[3]} }] }`
  const open = async (page) => {
    await page.click('.duel-category:has-text("Code")')
    await page.click('.duel-pickmode button:has-text("Je choisis")')
    await page.click('.duel-series__mode button:has-text("Série")')
    await page.click('button:has-text("Tout cocher")')
    await settle(page)
  }
  await withPage(async (page) => {
    await open(page)
    const lines = await page.locator('.duel-pick__duels').allTextContents()
    assert.deepEqual(lines, ['Faits : 6 · à faire : 4', 'Faits : 10 · à faire : 0', 'Faits : 0 · à faire : 10', 'Faits : 12 · à faire : 0'])
    // Moins de duels qu'en repartant de zéro (4 × 10 / 2 = 20).
    const total = Number((await page.textContent('.duel-home')).match(/environ (\d+)/)[1])
    assert.ok(total < 20 && total >= 10, `${total} duels`)
    assert.equal(await page.locator('.duel-home__start').isDisabled(), false)
    // Sur une ligne, dans la carte du modèle, sans déborder.
    const fits = await page.locator('.duel-pick').first().evaluate((el) => el.scrollWidth <= el.clientWidth)
    assert.ok(fits)
  }, plan([6, 10, 0, 12]))
  await withPage(async (page) => {
    await open(page)
    assert.match(await page.textContent('.duel-home'), /déjà 10 duels chacun/)
    assert.equal(await page.locator('.duel-home__start').isDisabled(), true)
  }, plan([10, 11, 12, 10]))
})

const SERIES_VIEW = (series) =>
  `window.__category = 'code'; window.__view = { id: 'session-1', category: 'code', phase: 'ready', modelCount: 12, preparing: null, dropped: 1, dropReason: 'disque plein', votes: 0, error: null, round: null, batch: [{ number: 1, prompt: 'Un jeu de Tetris', a: 'done', b: 'done', revealed: null }, { number: 2, prompt: 'Un jeu du pendu', a: 'done', b: 'idle', revealed: null }, { number: 3, prompt: 'Un jeu de Sudoku', a: 'idle', b: 'idle', revealed: null }], series: ${JSON.stringify(series)} }`

test('étape 382 : la liste des duels dit où en est la série (téléchargement, modèles supprimés, PC allumé)', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-series-status')
      const text = await page.textContent('.duel-series-status')
      assert.match(text, /La série tourne/)
      assert.match(text, /Téléchargement du modèle suivant : 45 %/)
      assert.match(text, /Modèles supprimés après leurs duels : 2/)
      assert.match(text, /Dernière erreur : disque plein/)
      assert.match(text, /Laisse le PC allumé/)
      // Les duels finis se votent pendant que la série continue.
      assert.deepEqual(await page.$$eval('.duel-batch__status', (els) => els.map((e) => e.textContent)), ['À voter', 'En attente', 'En attente'])
      // Pas de nom de modèle avant le vote.
      const all = await page.innerText('body')
      for (const name of NAMES) assert.ok(!all.includes(name), `nom affiché : ${name}`)
      const fill = await page.locator('.duel-series-status .duel-progress__fill').evaluate((el) => el.style.width)
      assert.equal(fill, '45%')
    },
    SERIES_VIEW({ perModel: 10, download: { percent: 45 }, waiting: null, deleted: 2, active: true })
  )
})

test('étape 382 : Ollama arrêté — la série le dit ; finie — il ne reste qu’à voter', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-series-status')
      assert.match(await page.textContent('.duel-series-status'), /Ollama ne répond plus : nouvel essai toutes les minutes/)
    },
    SERIES_VIEW({ perModel: 10, download: null, waiting: 'ollama', deleted: 0, active: true })
  )
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-series-status')
      const text = await page.textContent('.duel-series-status')
      assert.match(text, /La série ne tourne plus : il ne reste qu'à voter/)
      assert.ok(!/Laisse le PC allumé/.test(text), 'plus besoin de garder le PC allumé')
      assert.equal(await page.locator('.duel-series-status .duel-progress').count(), 0)
    },
    SERIES_VIEW({ perModel: 10, download: null, waiting: null, deleted: 3, active: false })
  )
})

test('étape 388 : « Terminer la session » avec des duels pas votés demande confirmation ; « Voter d’abord » ne touche à rien', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-batch')
      await page.getByRole('button', { name: 'Terminer la session' }).click()
      await page.waitForSelector('.duel-end-confirm')
      assert.match(await page.textContent('.duel-end-confirm'), /Duels pas encore votés : 3\. Si tu termines la session, ils seront effacés pour de bon/)
      assert.ok(!(await page.evaluate(() => window.__calls)).some((c) => c === 'end' || (Array.isArray(c) && c[0] === 'end')), 'rien n’est effacé sans confirmation')
      // Le bouton par défaut ramène au vote.
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Voter d’abord'.replace('’', "'"))
      await page.getByRole('button', { name: "Voter d'abord" }).click()
      await settle(page)
      assert.equal(await page.locator('.duel-end-confirm').count(), 0)
      assert.ok(await page.locator('.duel-batch__item').first().isVisible(), 'la liste des duels est toujours là')
      // Confirmé explicitement : seulement alors la session se termine.
      await page.getByRole('button', { name: 'Terminer la session' }).click()
      await page.getByRole('button', { name: 'Effacer et terminer' }).click()
      await settle(page)
      assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => Array.isArray(c) && c[0] === 'end'), [['end', 'force']])
    },
    SERIES_VIEW({ perModel: 10, download: null, waiting: null, deleted: 0, active: true })
  )
})

test('étape 388 : machine des modèles arrêtée (crédit épuisé) — rien n’est perdu, nouvelle adresse et reprise de la série', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-move')
      const text = await page.textContent('.duel-move')
      assert.match(text, /La machine des modèles ne répond plus/)
      assert.match(text, /Rien n'est perdu : les duels finis restent ici, et tu peux les voter/)
      // L'ancienne adresse est déjà remplie : Léo n'a qu'à la remplacer.
      await page.waitForFunction(() => document.querySelector('.duel-move input[type=url]')?.value === 'https://old-11434.proxy.runpod.net')
      await page.fill('.duel-move input[type=url]', '203.0.113.7:41234')
      const inputs = page.locator('.duel-move input[inputmode=decimal]')
      await inputs.nth(0).fill('140')
      await inputs.nth(1).fill('129')
      await page.getByRole('button', { name: 'Reprendre sur cette machine' }).click()
      await page.waitForFunction(() => window.__calls.includes('seriesMove'))
      const calls = await page.evaluate(() => window.__calls)
      const saved = calls.find((c) => Array.isArray(c) && c[0] === 'remoteSave')
      assert.deepEqual(saved[1], { enabled: true, host: '203.0.113.7:41234', vramGb: 140, ramGb: 129 })
      assert.ok(calls.indexOf(saved) < calls.indexOf('seriesMove'), 'l’adresse est enregistrée avant la reprise')
      // La série tourne de nouveau : le cadre d'alerte disparaît, un simple bouton reste.
      await page.waitForSelector('.duel-move__open')
      assert.equal(await page.locator('.duel-move').count(), 0)
      // Les duels ne sont jamais terminés par cette action.
      assert.ok(!calls.some((c) => c === 'end' || (Array.isArray(c) && c[0] === 'end')))
    },
    `window.__profile = { name: 'Léo', duelRemote: { enabled: true, host: 'https://old-11434.proxy.runpod.net', vramGb: 141, ramGb: 200 } }; ${SERIES_VIEW({ perModel: 10, download: null, waiting: 'ollama', deleted: 0, active: true }).replace("phase: 'ready'", "phase: 'ready', remote: true")}`
  )
})

test('étape 388 : la nouvelle machine ne répond pas — l’erreur s’affiche, la série reste à voter', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-move')
      await page.waitForFunction(() => document.querySelector('.duel-move input[type=url]')?.value !== '')
      await page.getByRole('button', { name: 'Reprendre sur cette machine' }).click()
      await page.waitForSelector('.duel-move [role=alert]')
      assert.match(await page.textContent('.duel-move [role=alert]'), /ne répond pas/)
      assert.ok(await page.locator('.duel-batch__item').first().isVisible())
    },
    `window.__moveError = 'La machine des modèles (http://x) ne répond pas.'; window.__profile = { name: 'Léo', duelRemote: { enabled: true, host: 'http://x', vramGb: 140, ramGb: 129 } }; ${SERIES_VIEW({ perModel: 10, download: null, waiting: 'ollama', deleted: 0, active: true }).replace("phase: 'ready'", "phase: 'ready', remote: true")}`
  )
})

test('étape 388 : série sur CE PC — pas de changement de machine proposé', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel-series-status')
      assert.equal(await page.locator('.duel-move, .duel-move__open').count(), 0)
    },
    SERIES_VIEW({ perModel: 10, download: null, waiting: 'ollama', deleted: 0, active: true })
  )
})
