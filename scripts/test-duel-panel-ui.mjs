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
    { model: 'phi4-mini', vramGb: 2.5, reason: { kind: 'tools', score: '7/78' } }
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
  duelStart: async (category, count) => {
    window.__calls.push(['start', category, count])
    window.__category = category
    return { id: 'session-1', category, phase: 'preparing', modelCount: count, preparing: { done: 0, total: 2, percent: 37 }, dropped: 0, votes: 0, round: null, error: null }
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
  duelEnd: async () => {
    window.__calls.push('end')
    return window.__summary
  },
  duelClose: async () => { window.__calls.push('close') },
  duelAudio: async () => null,
  duelDeleteModels: async (models) => { window.__calls.push(['delete', models]); return { deleted: models, failed: [] } },
  getProfile: async () => null,
  duelHistory: async () => { window.__calls.push('history'); return window.__history || [] },
  duelExportVotes: async () => { window.__calls.push('export'); return window.__exportResult || { saved: true, count: 3 } },
  duelHistoryApp: async (id, side) => { window.__calls.push(['historyApp', id, side]); return 'data:text/html,<p>app</p>' },
  duelRetry: async () => {
    window.__calls.push('retry')
    return ready({ ...window.__view.round, a: side({ status: 'running', startedAt: Date.now(), activity: { kind: 'thinking' } }), b: side() })
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
    assert.deepEqual(await page.locator('.duel-sizes:not(.duel-pickmode) .duel-size').allTextContents(), ['4', '5', '6'])
    assert.equal(await page.locator('.duel-sizes:not(.duel-pickmode) .duel-size[aria-checked="true"]').textContent(), '5', '5 modèles par défaut')
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

test('préparation : l’avancement du téléchargement, sans nom de modèle', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duel-home__start:not([disabled])')
    await page.click('.duel-home__start')
    await page.waitForSelector('.duel-preparing')
    assert.match(await page.textContent('.duel-preparing'), /Téléchargement du modèle 1 sur 2/)
    assert.match(await page.textContent('.duel-preparing'), /37\s%/)
    assert.equal(await page.$eval('.duel-progress__fill', (el) => el.style.width), '37%')
  })
})

test('un duel : A répond et agit, B attend qu’on ait vérifié, puis le vote — sans jamais un nom de modèle à l’écran', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.duel__ask .empty-state')
      assert.match(await page.textContent('.duel__bar'), /Duel 1 · Conversation/)
      // Une suggestion remplit le champ, Entrée envoie au modèle A.
      await page.click('.empty-state__suggestion >> nth=0')
      assert.equal(await page.inputValue('.composer__input'), 'Ouvre le Bloc-notes et écris une liste de courses')
      await page.click('.composer__send')
      await page.waitForSelector('.duel-side--running')
      assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'ask'), ['ask', 'Ouvre le Bloc-notes et écris une liste de courses'])
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
    assert.equal(await page.$('.duel-side--idle .duel-btn--primary'), null, 'B ne peut plus départager un duel gâché')
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
    assert.equal(await page.$('.duel-vote--trouble'), null, 'pendant le nouvel essai, plus de panneau')
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
    const weak = rows.find((r) => /phi/i.test(r.text))
    assert.equal(weak.disabled, true)
    assert.match(weak.text, /7\/78/)
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
