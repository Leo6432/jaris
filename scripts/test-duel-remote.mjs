import assert from 'node:assert/strict'
import * as asyncHooks from 'node:async_hooks'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 377 (Léo : « tout se passe sur mon PC mais les modèles tournent sur leur site », pour les duels seulement) :
 * les modèles d'un duel tournent sur l'Ollama d'une autre machine (une carte louée sur RunPod), et TOUT LE RESTE reste
 * sur ce PC — les outils de Jaris, la voix, le choix des modèles de Jaris, les mesures de vitesse.
 *
 * Le VRAI config.ts est chargé ici (l'adresse d'Ollama propre à un travail, AsyncLocalStorage) : chaque faux appel à
 * Ollama note l'adresse qu'il aurait jointe, ce qui prouve où chaque morceau du duel est parti.
 */
const LOCAL = 'http://127.0.0.1:11434'
const POD = 'https://pod123-11434.proxy.runpod.net'
const MODELS = ['alpha-model:3b', 'bravo-model:8b', 'charlie-model:4b', 'delta-model:7b']

const configModule = loadTsModule('electron/config.ts', {
  async_hooks: asyncHooks,
  dotenv: { config: () => ({}) },
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/') }
})
const { config } = configModule
const duelModule = loadTsModule('shared/duel.ts')
const effortModule = loadTsModule('shared/effort.ts')
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate, what) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick()
  }
  assert.fail(`jamais arrivé : ${what}`)
}

function setup({ remote, versionFails = null, installedHere = ['vision-model:8b'], installedThere = [], generateGate = null, loaded = () => [], heartbeat = false } = {}) {
  const calls = { version: [], list: [], pulls: [], thinking: [], converse: [], tool: [], deleted: [], candidates: [], lists: [], machines: [], patches: [], generating: [], ps: [] }
  let profile = {
    name: 'Léo',
    models: { flash: 'alpha-model:3b', medium: 'alpha-model:3b', large: 'bravo-model:8b' },
    codeModel: 'bravo-model:8b',
    visionModel: 'vision-model:8b',
    ...(remote ? { duelRemote: remote } : {})
  }
  const here = [...installedHere]
  const there = [...installedThere]
  const votes = []
  const modules = {
    crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${n++}` })() },
    '../config': configModule,
    // Étape 437 : la machine des duels est la machine connectée de la page Machine (ici : celle du profil, activée).
    './remoteMachine': {
      connectedMachine: () => (profile.duelRemote?.enabled ? { host: profile.duelRemote.host, vramGb: profile.duelRemote.vramGb, ramGb: profile.duelRemote.ramGb, diskGb: 100 } : null),
      machineFreeDiskGb: async () => null
    },
    './assistant': {
      converse: async (_prompt, _name, _onReminder, _onLog, _history, _signal, _live, _channel, onToken, _a, _b, restrictions) => {
        calls.converse.push({ host: config.ollama.host, remote: config.ollama.remote, threads: MODELS.map((m) => config.ollama.threadsFor(m)) })
        // Un outil de Jaris pendant le duel : il doit tourner sur CE PC, avec son Ollama à lui.
        await restrictions.runTool?.(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          calls.tool.push({ host: config.ollama.host, remote: config.ollama.remote })
        })
        calls.converse.push({ host: config.ollama.host, after: true })
        onToken?.('Fait.')
        return 'Fait.'
      }
    },
    './codeGenerator': {
      // Étape 456 : une génération qui attend qu'on la libère, pour voir quels modèles tournent en même temps.
      generateApp: async (_prompt, _onProgress, _base, _signal, options) => {
        calls.generating.push(options?.model)
        // Étape 457 : Ollama bloqué envoie encore des signes de vie, sans un caractère de plus.
        const beat = heartbeat
          ? setInterval(() => options?.onProgress?.({ phase: 'writing', stepIndex: 0, stepCount: 1, charsWritten: 0, thinkingChars: 0, idleMs: 1000, elapsedMs: 1000 }), 5)
          : null
        if (generateGate) await generateGate
        if (beat) clearInterval(beat)
        calls.generating.splice(calls.generating.indexOf(options?.model), 1)
        return { html: '<html></html>', issues: [] }
      }
    },
    './generatedAppPreview': { createGeneratedAppPreview: () => 'jaris-preview://app/x/index.html' },
    './imageGenerator': { imageDrawingAvailable: async () => true },
    './hardwareScan': {
      duelMachine: async (machine) => {
        calls.machines.push(machine ?? null)
        return machine ? { vramGb: machine.vramGb, ramGb: Math.round(machine.ramGb) } : { vramGb: 8, ramGb: 32 }
      },
      getDuelCandidates: async (_category, _profile, machine) => {
        calls.candidates.push(machine ?? null)
        return MODELS.map((model, index) => ({ model, vramGb: index + 2, note: null, duels: 0, inUse: false, group: 'card' }))
      },
      getDuelModelList: async (_category, _profile, machine) => {
        calls.lists.push(machine ?? null)
        return MODELS.map((model, index) => ({ model, vramGb: index + 2, reason: null }))
      },
      imageReadingModels: () => ['vision-model:8b'],
      pickModelsForDuelCategory: async () => ({ flash: 'alpha-model:3b', medium: 'alpha-model:3b', large: 'bravo-model:8b', code: 'bravo-model:8b' })
    },
    './ollama': {
      fetchOllamaVersion: async () => {
        calls.version.push(config.ollama.host)
        if (versionFails) throw new Error(versionFails)
        return '0.40.10'
      },
      listInstalledModels: async () => {
        calls.list.push(config.ollama.host)
        return config.ollama.host === LOCAL ? [...here] : [...there]
      },
      repairModelsViewIfNeeded: async () => {
        calls.repair = (calls.repair ?? 0) + 1
        return false
      },
      getModelThinking: async () => {
        calls.thinking.push(config.ollama.host)
        return null
      },
      pullModelIfMissing: async (model) => {
        calls.pulls.push({ model, host: config.ollama.host, remote: config.ollama.remote })
        ;(config.ollama.host === LOCAL ? here : there).push(model)
        return true
      },
      deleteModel: async (model) => {
        calls.deleted.push({ model, host: config.ollama.host })
      },
      // Étape 456 : ce que la machine a VRAIMENT chargé (`/api/ps`), selon les modèles qui génèrent en ce moment.
      loadedOllamaModels: async () => {
        calls.ps.push(config.ollama.host)
        return loaded([...new Set(calls.generating)])
      }
    },
    './profileStore': {
      getProfile: async () => profile,
      patchProfile: async (change) => {
        calls.patches.push(change)
        profile = { ...profile, ...change }
        return profile
      }
    },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => 100 },
    './tools': { TOOLS: ['open_app', 'look_at_screen', 'generate_image', 'shutdown_pc'].map((name) => ({ function: { name } })) },
    './tts': { synthesizeSpeech: async () => Buffer.from('RIFF') },
    // Étape 382 : la série gardée sur le disque (pas exercée ici).
    './duelSeriesStore': {
      SERIES_FORMAT: 'jaris-duel-series',
      SERIES_VERSION: 1,
      saveSeries: async () => {},
      loadSeries: async () => null,
      clearSeries: async () => {},
      saveSeriesApp: async () => {},
      readSeriesApp: async () => null
    },
    './duelStore': {
      addDuelVote: async (vote) => votes.push(vote),
      getDuelVotes: () => votes,
      getRankingVotes: () => votes,
      getAllDuelVotes: () => votes,
      countPendingDuelVotes: () => 0,
      saveDuelApp: async () => {},
      readDuelApp: async () => null,
      addDuelReview: async () => {},
      getDuelReviews: () => [],
      decideDuelReview: async () => false
    },
    './claudeKey': { loadClaudeKey: async () => null },
    './duelJudge': {
      JUDGE_MODEL: 'claude-sonnet-5-5',
      JudgeRefusalError: class JudgeRefusalError extends Error {},
      judgeDuel: async () => { throw new Error('pas de juge ici') },
      writeDuelQuestion: async () => { throw new Error('pas de juge ici') }
    },
    '../../shared/duel': duelModule,
    '../../shared/effort': effortModule
  }
  const session = loadTsModule('electron/services/duelSession.ts', modules)
  session.setDuelEnvironment({ onReminderFire: () => {}, emit: () => {} })
  return {
    session,
    calls,
    votes,
    get profile() {
      return profile
    }
  }
}

const POD_SETTINGS = { enabled: true, host: POD, vramGb: 288, ramGb: 188 }

test('l’adresse propre à un travail suit les await et les minuteurs, et ne déborde jamais sur le reste de Jaris', async () => {
  assert.equal(config.ollama.host, LOCAL)
  assert.equal(config.ollama.remote, false)
  const seen = await configModule.runWithOllamaHost(POD, async () => {
    const first = config.ollama.host
    await new Promise((resolve) => setTimeout(resolve, 5))
    const later = config.ollama.host
    const inner = await configModule.runWithLocalOllama(async () => {
      await tick()
      return { host: config.ollama.host, remote: config.ollama.remote }
    })
    return { first, later, inner, remote: config.ollama.remote, back: config.ollama.host }
  })
  assert.deepEqual(seen, { first: POD, later: POD, inner: { host: LOCAL, remote: false }, remote: true, back: POD })
  // Un travail lancé ailleurs pendant ce temps (le Chat, la voix) n'est jamais concerné.
  assert.equal(config.ollama.host, LOCAL)
})

test('fils de calcul sur une autre machine : seulement pour un modèle qui tient entier sur la carte', () => {
  assert.equal(duelModule.remoteThreadsFor(5, 141), duelModule.DUEL_REMOTE_THREADS)
  assert.equal(duelModule.remoteThreadsFor(120, 141), undefined, 'déborde sur la RAM : le processeur calcule vraiment')
  assert.equal(duelModule.remoteThreadsFor(Number.NaN, 141), undefined, 'taille inconnue : rien de changé')
  assert.equal(duelModule.remoteThreadsFor(5, null), undefined, 'carte inconnue : rien de changé')
  // Sur ce PC (aucun travail à distance) et dans les outils de Jaris pendant un duel : jamais.
  assert.equal(config.ollama.threadsFor('alpha-model:3b'), undefined)
  return configModule.runWithOllamaHost(POD, () => configModule.runWithLocalOllama(async () => {
    assert.equal(config.ollama.threadsFor('alpha-model:3b'), undefined)
  }), () => 4)
})

test('l’adresse d’une autre machine : origine seule, https par défaut pour un nom, http pour une IP, refus du reste', () => {
  const n = duelModule.normalizeRemoteOllamaHost
  assert.equal(n(' https://pod123-11434.proxy.runpod.net/ '), POD)
  assert.equal(n('pod123-11434.proxy.runpod.net'), POD, 'collée sans « https:// »')
  assert.equal(n('https://pod123-11434.proxy.runpod.net/api/tags'), POD, 'un chemin collé en trop est retiré')
  assert.equal(n('203.0.113.7:11434'), 'http://203.0.113.7:11434')
  assert.equal(n('http://localhost:11500'), 'http://localhost:11500')
  for (const bad of ['', 'pas une adresse', 'ftp://exemple.com', 'https://moi:secret@exemple.com', 'http://0.0.0.0:11434', 'file:///C:/x']) {
    assert.equal(n(bad), null, bad)
  }
  assert.deepEqual(duelModule.parseDuelRemote({ enabled: true, host: 'pod123-11434.proxy.runpod.net', vramGb: 288, ramGb: 188 }), POD_SETTINGS)
  assert.equal(duelModule.parseDuelRemote({ enabled: true, host: POD, vramGb: Number.NaN, ramGb: 188 }), null)
  assert.equal(duelModule.parseDuelRemote({ enabled: true, host: POD, vramGb: 288, ramGb: 0 }), null)
  assert.equal(duelModule.parseDuelRemote({ enabled: true, host: POD, vramGb: 99999, ramGb: 188 }), null)
})

test('session sur une autre machine : modèles, téléchargements et suppressions là-bas ; outils, liste de vision et choix de Jaris ici', async () => {
  const env = setup({ remote: POD_SETTINGS, installedThere: ['alpha-model:3b'] })
  const plan = await env.session.planDuel('conversation')
  assert.deepEqual(plan.remote, { host: POD, version: '0.40.10', error: null })
  assert.deepEqual(plan.machine, { vramGb: 288, ramGb: 188 }, 'la carte et la RAM de l’autre machine, pas celles de ce PC')
  assert.equal(plan.freeDiskGb, null, 'le disque de ce PC ne compte pas')
  const machine = { vramGb: 288, ramGb: 188, ollamaVersion: '0.40.10' }
  assert.deepEqual(env.calls.candidates.at(-1), machine)
  assert.deepEqual(env.calls.lists.at(-1), machine)
  assert.ok(plan.models.find((m) => m.model === 'alpha-model:3b').installed, 'déjà sur l’autre machine')
  assert.ok(!plan.models.find((m) => m.model === 'bravo-model:8b').installed, 'sur ce PC seulement : à télécharger là-bas')

  const started = await env.session.startDuel('conversation', 4)
  assert.equal(started.remote, true)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  assert.equal(env.calls.pulls.length, 3)
  assert.ok(env.calls.pulls.every((p) => p.host === POD && p.remote), 'téléchargés sur l’autre machine')
  assert.equal(env.calls.repair ?? 0, 0, 'jamais la réparation du dossier de modèles de CE PC')

  env.calls.list.length = 0
  env.session.askDuel('Ouvre le Bloc-notes')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  assert.deepEqual(env.calls.thinking, [POD], 'la réflexion lue sur l’Ollama qui fait tourner le modèle')
  assert.equal(env.calls.converse[0].host, POD, 'le modèle répond depuis l’autre machine')
  // Étape 387 : sur la carte de 288 Go, chaque modèle tient entier → 4 fils de calcul chacun.
  assert.deepEqual(env.calls.converse[0].threads, [4, 4, 4, 4], 'peu de fils de calcul pour les modèles qui tiennent sur la carte')
  assert.deepEqual(env.calls.tool, [{ host: LOCAL, remote: false }], 'les outils de Jaris restent sur ce PC')
  assert.equal(env.calls.converse[1].host, POD, 'après l’outil, le modèle reprend sur l’autre machine')
  assert.deepEqual(env.calls.list, [LOCAL], 'les modèles de vision cherchés sur CE PC (ce sont ses outils)')

  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B a fini')
  await env.session.voteDuel('a')
  const summary = await env.session.endDuel()
  // alpha-model:3b sert à Jaris sur ce PC, mais le supprimer de l'autre machine ne retire rien ici.
  assert.ok(summary.downloaded.every((d) => d.inUse === false))
  const used = summary.downloaded.map((d) => d.model)
  const result = await env.session.deleteDuelModels(used)
  assert.deepEqual(result.deleted.sort(), used.sort())
  assert.ok(env.calls.deleted.every((d) => d.host === POD), 'supprimés sur l’autre machine, jamais sur ce PC')
})

test('autre machine injoignable : le plan le dit, rien ne démarre, rien n’est téléchargé', async () => {
  const env = setup({ remote: POD_SETTINGS, versionFails: 'La machine des modèles ne répond pas.' })
  const plan = await env.session.planDuel('code')
  assert.equal(plan.remote.error, 'La machine des modèles ne répond pas.')
  assert.equal(plan.remote.version, null)
  assert.equal(plan.models.length, MODELS.length, 'la liste reste visible')
  await assert.rejects(env.session.startDuel('code', 4), /ne répond pas/)
  assert.equal(env.calls.pulls.length, 0)
  assert.ok(!env.calls.list.includes(POD), 'aucune liste demandée à une machine qui ne répond pas')
})

test('réglage désactivé : tout se passe sur ce PC, l’autre machine n’est jamais contactée', async () => {
  const env = setup({ remote: { ...POD_SETTINGS, enabled: false }, installedHere: ['vision-model:8b', 'alpha-model:3b'] })
  const plan = await env.session.planDuel('conversation')
  assert.equal(plan.remote, null)
  assert.deepEqual(plan.machine, { vramGb: 8, ramGb: 32 })
  assert.equal(env.calls.version.length, 0)
  await env.session.startDuel('conversation', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  assert.ok(env.calls.pulls.every((p) => p.host === LOCAL && !p.remote))
  assert.equal(env.session.getDuelView().remote, false)
})

// Étape 437 : les réglages de la machine se revérifient dans remoteMachine.ts (test-machine.mjs), plus dans le Duel.
test('téléchargement sur l’autre machine : ni la mémoire ni le disque de CE PC ne le bloquent, ni la réparation de son dossier', async () => {
  const realFetch = globalThis.fetch
  const GB = 1024 ** 3
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === '/api/tags') return new Response(JSON.stringify({ models: [] }), { status: 200 })
    if (path === '/api/pull') {
      const lines = [{ status: 'pulling', digest: 'sha256:a', total: 40 * GB, completed: 0 }, { status: 'pulling', digest: 'sha256:a', total: 40 * GB, completed: 40 * GB }, { status: 'success' }]
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
  const load = (remote) =>
    loadTsModule('electron/services/ollama.ts', {
      '../config': { config: { ollama: { host: remote ? POD : LOCAL, model: 'x', numCtx: 8192, remote } } },
      '../../shared/effort': { parseModelThinking: () => null },
      // CE PC : 5 Go pour faire tourner un modèle, 1 Go de disque.
      './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => 6, getDownloadBudgetGb: async () => 5 },
      './modelDefaults': { applyModelDefaults: async () => {} },
      './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
    })
  try {
    const away = load(true)
    let repairs = 0
    away.setModelsViewRepair(async () => {
      repairs++
      return false
    })
    assert.equal(await away.pullModelIfMissing('gros-modele:70b'), true, 'téléchargé sur l’autre machine')
    assert.equal(repairs, 0, 'la liste vide d’un pod neuf n’est pas une panne du dossier de CE PC')
    // Sur ce PC, le même téléchargement reste refusé avant d'aller plus loin.
    const here = load(false)
    await assert.rejects(here.pullModelIfMissing('gros-modele:70b'), (err) => err.name === 'ModelTooLargeError' || /trop/i.test(err.message))
  } finally {
    globalThis.fetch = realFetch
  }
})

// Étape 456 (capture de Léo, OVH 4 × V100S : un 6e modèle d'une série Code à « 78%/22% CPU/GPU ») : sur la machine louée,
// un NOUVEAU modèle de la série ne démarre que s'il tient vraiment, d'après ce qu'Ollama a chargé.
test('étape 456 : série Code sur la machine louée — un nouveau modèle attend la place réelle, et jamais pendant un débordement', async () => {
  const run = async (vramGb, loaded) => {
    let release
    const generateGate = new Promise((resolve) => (release = resolve))
    const env = setup({ remote: { enabled: true, host: POD, vramGb, ramGb: 188 }, installedThere: [...MODELS], generateGate, loaded })
    env.session.setDuelSeriesDelays({ idleCheckMs: 10 })
    try {
      await env.session.startDuel('code', [...MODELS], 2)
      await waitFor(() => env.calls.ps.length >= 1 && new Set(env.calls.generating).size >= 1, 'premiers modèles lancés')
      // Plusieurs relectures de la machine : ce qui devait démarrer a démarré.
      const before = env.calls.ps.length
      await waitFor(() => env.calls.ps.length >= before + 5, 'relectures de la machine')
      assert.ok(env.calls.ps.every((host) => host === POD), 'la place lue sur la machine louée')
      return new Set(env.calls.generating).size
    } finally {
      // Toujours libérer et fermer : une série laissée en route garderait le test ouvert.
      release()
      await env.session.endDuel().catch(() => {})
    }
  }
  // 45 Go de cartes : par estimation, 2 modèles (4 duels chacun) tiennent au départ ; une fois chargés ils prennent peu
  // (5 Go chacun) → les 2 autres démarrent ensuite, au fil des relectures.
  assert.equal(await run(45, (models) => models.map((model) => ({ model, vramGb: 5, sizeGb: 5 }))), 4)
  // Même machine, mais le premier modèle déborde sur le processeur : aucun nouveau modèle (étape 458 : un seul nouveau
  // modèle à la fois, donc le premier est seul quand le débordement est vu).
  assert.equal(await run(45, (models) => models.map((model, i) => ({ model, vramGb: i === 0 ? 3 : 5, sizeGb: 5 }))), 1)
  // 60 Go : l'estimation laisse partir 2 modèles, mais chacun en prend vraiment 25 → pas de 3e.
  assert.equal(await run(60, (models) => models.map((model) => ({ model, vramGb: 25, sizeGb: 25 }))), 2)
})

// Étape 457 (Léo, OVH : LFM2.5 resté « Stopping… », la série attendait sans rien dire) : rien n'avance → Jaris le dit.
test('étape 457 : série sur la machine louée — rien n’avance depuis longtemps, l’écran le dit, puis l’efface dès que ça repart', async () => {
  let release
  const generateGate = new Promise((resolve) => (release = resolve))
  const env = setup({ remote: { enabled: true, host: POD, vramGb: 288, ramGb: 188 }, installedThere: [...MODELS], generateGate, heartbeat: true })
  env.session.setDuelSeriesDelays({ idleCheckMs: 10, stallMs: 150 })
  try {
    await env.session.startDuel('code', [...MODELS], 2)
    await waitFor(() => env.calls.generating.length > 0, 'des duels tournent')
    // Des signes de vie arrivent, mais aucun caractère : au bout du délai, l'avertissement.
    await waitFor(() => env.session.getDuelView()?.series?.stalledMinutes >= 1, 'blocage signalé')
    release()
    await waitFor(() => env.session.getDuelView()?.series?.stalledMinutes === null, 'avertissement effacé quand ça repart')
  } finally {
    release()
    env.session.setDuelSeriesDelays({ stallMs: 10 * 60_000 })
    await env.session.endDuel().catch(() => {})
  }
})

test('étape 457 : des duels qui finissent → jamais d’avertissement', async () => {
  let release
  const generateGate = new Promise((resolve) => (release = resolve))
  const env = setup({ remote: { enabled: true, host: POD, vramGb: 288, ramGb: 188 }, installedThere: [...MODELS], generateGate })
  env.session.setDuelSeriesDelays({ idleCheckMs: 10, stallMs: 150 })
  try {
    await env.session.startDuel('code', [...MODELS], 2)
    await waitFor(() => env.calls.generating.length > 0, 'des duels tournent')
    release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(!env.session.getDuelView()?.series?.stalledMinutes, 'des côtés finissent : pas de blocage')
  } finally {
    release()
    env.session.setDuelSeriesDelays({ stallMs: 10 * 60_000 })
    await env.session.endDuel().catch(() => {})
  }
})

// Étape 458 (journal d'Ollama chez Léo : « GPU discovery watchdog timed out » quand plusieurs modèles se chargent ensemble).
test('étape 458 : un seul NOUVEAU modèle se charge à la fois sur la machine louée ; débordement cartes libres → Léo le sait', async () => {
  let release
  const generateGate = new Promise((resolve) => (release = resolve))
  // La machine ne « voit » un modèle chargé qu'à partir de la 4e relecture qui suit son démarrage.
  const reads = new Map()
  let spill = false
  let crowd = false
  const loaded = (models) => [
    ...models
      .filter((model) => {
        reads.set(model, (reads.get(model) ?? 0) + 1)
        return reads.get(model) >= 4
      })
      .map((model, i) => ({ model, vramGb: spill && i === 0 ? 1 : 5, sizeGb: 5 })),
    // Des modèles d'avant, encore chargés le temps qu'Ollama les libère (150 Go sur 288).
    ...(crowd === 'half' ? [{ model: 'moitie-model:70b', vramGb: 100, sizeGb: 100 }] : crowd ? [{ model: 'fini-model:70b', vramGb: 150, sizeGb: 150 }] : [])
  ]
  const env = setup({ remote: { enabled: true, host: POD, vramGb: 288, ramGb: 188 }, installedThere: [...MODELS], generateGate, loaded })
  env.session.setDuelSeriesDelays({ idleCheckMs: 10, loadCheckMs: 10 })
  const seen = []
  try {
    await env.session.startDuel('code', [...MODELS], 2)
    await waitFor(() => {
      seen.push(new Set(env.calls.generating).size)
      return new Set(env.calls.generating).size === 4
    }, 'les 4 modèles finissent par tourner')
    // Jamais deux nouveaux d'un coup : le nombre de modèles monte de 1 en 1.
    const steps = [...new Set(seen)]
    assert.deepEqual(steps, [...steps].sort((x, y) => x - y))
    assert.ok(seen.every((n, i) => i === 0 || n - seen[i - 1] <= 1), `montée : ${steps.join(' → ')}`)
    assert.equal(env.session.getDuelView().series.cpuFallback, false)
    // Un modèle part sur le processeur alors que les cartes sont presque vides (20 Go sur 288) : l'écran le dit.
    spill = true
    await waitFor(() => env.session.getDuelView()?.series?.cpuFallback === true, 'débordement cartes libres signalé')
    spill = false
    await waitFor(() => env.session.getDuelView()?.series?.cpuFallback === false, 'effacé quand ça va mieux')
    // Étape 461 (capture de Léo : 61 Go pris sur 126) : un quart des cartes ou plus déjà pris → pas « presque libres ».
    crowd = 'half'
    spill = true
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(env.session.getDuelView().series.cpuFallback, false, 'cartes à moitié prises : pas « presque libres »')
    crowd = false
    spill = false
    // Étape 459 : débordement alors que les cartes sont bien remplies par d'AUTRES modèles chargés (qui finissent) —
    // ce n'est pas un démarrage raté des cartes : pas cet avertissement.
    crowd = true
    spill = true
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(env.session.getDuelView().series.cpuFallback, false, 'cartes déjà bien prises : pas « presque libres »')
    crowd = false
    spill = false
  } finally {
    release()
    env.session.setDuelSeriesDelays({ loadCheckMs: 5000 })
    await env.session.endDuel().catch(() => {})
  }
})
