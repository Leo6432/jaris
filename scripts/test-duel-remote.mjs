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

function setup({ remote, versionFails = null, installedHere = ['vision-model:8b'], installedThere = [] } = {}) {
  const calls = { version: [], list: [], pulls: [], thinking: [], converse: [], tool: [], deleted: [], candidates: [], lists: [], machines: [], patches: [] }
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
    './codeGenerator': { generateApp: async () => ({ html: '<html></html>', issues: [] }) },
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
      saveDuelApp: async () => {},
      readDuelApp: async () => null
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

test('enregistrer la machine : revérifiée par le main, adresse normalisée, désactiver garde l’adresse', async () => {
  const env = setup()
  const saved = await env.session.saveDuelRemote({ enabled: true, host: 'pod123-11434.proxy.runpod.net/', vramGb: 288, ramGb: 188 })
  assert.deepEqual(saved, POD_SETTINGS)
  assert.deepEqual(env.profile.duelRemote, POD_SETTINGS)
  await assert.rejects(env.session.saveDuelRemote({ enabled: true, host: 'n’importe quoi', vramGb: 288, ramGb: 188 }), /Adresse invalide/)
  await assert.rejects(env.session.saveDuelRemote({ enabled: true, host: POD, vramGb: Number.NaN, ramGb: 188 }), /mémoire de la carte graphique/)
  assert.deepEqual(env.profile.duelRemote, POD_SETTINGS, 'un réglage refusé ne remplace pas le bon')
  // Revenir à ce PC sans avoir à retaper l'adresse plus tard.
  const off = await env.session.saveDuelRemote({ enabled: false, host: '', vramGb: Number.NaN, ramGb: Number.NaN })
  assert.deepEqual(off, { ...POD_SETTINGS, enabled: false })
  assert.equal(await env.session.saveDuelRemote(null), null)
  assert.equal(env.profile.duelRemote, undefined)
  await assert.rejects(env.session.saveDuelRemote('https://pod'), /invalide/i)
})

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
