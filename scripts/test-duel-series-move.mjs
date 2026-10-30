import assert from 'node:assert/strict'
import * as asyncHooks from 'node:async_hooks'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 388 (Léo, après avoir perdu une série de 2 h : « si j'ai plus de crédit, un système pour que je reprenne ») :
 * la machine louée s'arrête en pleine série (crédit épuisé). Les duels finis restent sur ce PC ; la série reprend sur
 * une NOUVELLE machine dès que son adresse est donnée. Le vrai config.ts est chargé : chaque faux appel à Ollama note
 * l'adresse qu'il aurait jointe.
 */
const POD = 'https://old-pod-11434.proxy.runpod.net'
const POD2 = 'http://203.0.113.7:41234'
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, what) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  assert.fail(`jamais arrivé : ${what}`)
}

function setup(t) {
  const calls = { generate: [], pulls: [], deleted: [], saved: [] }
  const down = new Set()
  const machines = new Map([
    [POD, []],
    [POD2, []]
  ])
  let blockAfter = Infinity
  let profile = { name: 'Léo', duelRemote: { enabled: true, host: POD, vramGb: 80, ramGb: 128 } }
  const modules = {
    crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${n++}` })() },
    '../config': configModule,
    './assistant': { converse: async () => 'ok' },
    './codeGenerator': {
      generateApp: async (prompt, _onStatus, _current, _image, options) => {
        const host = config.ollama.host
        calls.generate.push({ host, model: options.model, prompt })
        // L'ancienne machine tourne encore, puis son crédit s'épuise : la génération ne finit jamais, elle échoue.
        // Les premières applications passent ; ensuite, plus rien ne finit sur l'ancienne machine.
        if (host === POD && calls.generate.filter((g) => g.host === POD).length > blockAfter) while (!down.has(host) && !options.signal?.aborted) await sleep(3)
        if (options.signal?.aborted) throw Object.assign(new Error('arrêté'), { name: 'AbortError' })
        if (down.has(host)) throw new Error('fetch failed')
        if (!machines.get(host)?.includes(options.model)) {
          calls.notFound = (calls.notFound ?? 0) + 1
          throw new Error(`model '${options.model}' not found`)
        }
        await sleep(2)
        return { html: `<html><body>${host}|${options.model}</body></html>`, issues: [] }
      }
    },
    './generatedAppPreview': { createGeneratedAppPreview: (html) => `jaris-preview://app/${html.length}/index.html` },
    './imageGenerator': { imageDrawingAvailable: async () => true },
    './hardwareScan': {
      duelMachine: async (machine) => (machine ? { vramGb: machine.vramGb, ramGb: machine.ramGb } : { vramGb: 8, ramGb: 32 }),
      getDuelCandidates: async () => MODELS.map((model, index) => ({ model, vramGb: index + 2, note: null, duels: 0, inUse: false, group: 'card' })),
      getDuelModelList: async () => MODELS.map((model, index) => ({ model, vramGb: index + 2, reason: null })),
      imageReadingModels: () => [],
      pickModelsForDuelCategory: async () => ({ flash: 'alpha-model:3b', medium: 'alpha-model:3b', large: 'bravo-model:8b', code: 'bravo-model:8b' })
    },
    './ollama': {
      fetchOllamaVersion: async () => {
        if (down.has(config.ollama.host)) throw new Error('fetch failed')
        return '0.40.10'
      },
      listInstalledModels: async () => {
        if (down.has(config.ollama.host)) throw new Error('fetch failed')
        return [...(machines.get(config.ollama.host) ?? [])]
      },
      repairModelsViewIfNeeded: async () => false,
      getModelThinking: async () => null,
      pullModelIfMissing: async (model, _onStatus, _onProgress, signal) => {
        const host = config.ollama.host
        calls.pulls.push({ model, host })
        if (down.has(host)) throw new Error('fetch failed')
        if (signal?.aborted) throw new Error('arrêté')
        const list = machines.get(host)
        if (list.includes(model)) return false
        list.push(model)
        return true
      },
      deleteModel: async (model) => {
        const host = config.ollama.host
        calls.deleted.push({ model, host })
        if (down.has(host)) throw new Error('fetch failed')
        machines.set(host, machines.get(host).filter((m) => m !== model))
      }
    },
    './profileStore': {
      getProfile: async () => profile,
      patchProfile: async (change) => {
        profile = { ...profile, ...change }
        return profile
      }
    },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => 100 },
    './tools': { TOOLS: [] },
    './tts': { synthesizeSpeech: async () => Buffer.from('RIFF') },
    './duelSeriesStore': {
      SERIES_FORMAT: 'jaris-duel-series',
      SERIES_VERSION: 1,
      saveSeries: async (snapshot) => {
        calls.saved.push(JSON.parse(JSON.stringify(snapshot)))
      },
      loadSeries: async () => null,
      clearSeries: async () => {},
      saveSeriesApp: async () => {},
      readSeriesApp: async () => null
    },
    './duelStore': {
      addDuelVote: async () => {},
      getDuelVotes: () => [],
      getRankingVotes: () => [],
      saveDuelApp: async () => {},
      readDuelApp: async () => null
    },
    '../../shared/duel': duelModule,
    '../../shared/effort': effortModule
  }
  const session = loadTsModule('electron/services/duelSession.ts', modules)
  session.setDuelEnvironment({ onReminderFire: () => {}, emit: () => {} })
  session.setDuelSeriesDelays({ idleCheckMs: 10, ollamaRetryMs: 20 })
  // Un test qui échoue ne laisse jamais une série tourner (sinon node --test ne rend jamais la main).
  t?.after(() => session.endDuel(true).catch(() => {}))
  return {
    session,
    calls,
    machines,
    killOld: () => down.add(POD),
    blockOld: (after = 0) => {
      blockAfter = after
    },
    killNew: () => down.add(POD2),
    reviveNew: () => down.delete(POD2)
  }
}

const finished = (status) => status === 'done' || status === 'error'
const readyRounds = (view) => (view?.batch ?? []).filter((r) => finished(r.a) && finished(r.b))
const seriesDone = (view) => Boolean(view?.batch?.length) && readyRounds(view).length === view.batch.length && !view.series?.active

test('crédit épuisé en pleine série : rien n’est perdu, et la série reprend sur une nouvelle machine', async (t) => {
  const env = setup(t)
  env.blockOld(6)
  await env.session.startDuel('code', 4, 3)
  await waitFor(() => readyRounds(env.session.getDuelView()).length >= 1, 'un premier duel fini sur l’ancienne machine')
  await waitFor(() => env.session.getDuelView().batch.some((r) => r.a === 'running' || r.b === 'running'), 'des duels tournent encore')
  env.killOld()
  await waitFor(() => env.session.getDuelView().series?.waiting === 'ollama', 'la série attend la machine')

  const before = env.session.getDuelView()
  const doneBefore = readyRounds(before).map((r) => r.number)
  assert.ok(doneBefore.length >= 1)
  assert.ok(before.batch.every((r) => r.a !== 'error' && r.b !== 'error'), 'aucune panne de machine comptée contre un modèle')
  const generatedBefore = env.calls.generate.length
  const deletedBefore = env.calls.deleted.length

  // Léo loue une nouvelle machine et donne son adresse.
  await env.session.saveDuelRemote({ enabled: true, host: POD2, vramGb: 80, ramGb: 128 })
  const moved = await env.session.moveDuelSeries()
  assert.equal(moved.series.waiting, null)
  await waitFor(() => seriesDone(env.session.getDuelView()), 'la série a fini sur la nouvelle machine')

  const after = env.session.getDuelView()
  assert.ok(after.batch.every((r) => r.a === 'done' && r.b === 'done'), 'tous les duels finis, aucun en erreur')
  for (const number of doneBefore) {
    assert.ok(readyRounds(after).some((r) => r.number === number), `le duel ${number}, fini avant la panne, est toujours là`)
  }
  const later = env.calls.generate.slice(generatedBefore)
  assert.ok(later.length > 0)
  assert.ok(later.every((g) => g.host === POD2), 'tout le reste est écrit sur la nouvelle machine')
  assert.ok(env.calls.pulls.filter((p) => p.host === POD2).length > 0, 'les modèles sont téléchargés sur la nouvelle machine')
  assert.equal(env.calls.notFound ?? 0, 0, 'jamais une génération lancée avant que son modèle soit sur la nouvelle machine')
  assert.ok(env.calls.deleted.slice(deletedBefore).every((d) => d.host === POD2), 'rien n’est supprimé sur l’ancienne machine après la reprise')
  assert.equal(env.calls.saved.at(-1).remote.host, POD2, 'la série gardée sur le disque reprendra sur la nouvelle machine')
  // Les duels finis restent à voter.
  await env.session.endDuel(true)
})

test('nouvelle machine injoignable : refusé avec une raison, la série reste sur l’ancienne et attend', async (t) => {
  const env = setup(t)
  env.blockOld(4)
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => readyRounds(env.session.getDuelView()).length >= 1, 'un premier duel fini')
  env.killOld()
  env.killNew()
  await waitFor(() => env.session.getDuelView().series?.waiting === 'ollama' || seriesDone(env.session.getDuelView()), 'la série attend')
  await env.session.saveDuelRemote({ enabled: true, host: POD2, vramGb: 80, ramGb: 128 })
  await assert.rejects(env.session.moveDuelSeries(), /ne répond pas/)
  assert.ok(env.calls.saved.every((s) => s.remote.host === POD), 'la série gardée pointe toujours sur l’ancienne machine')
  // La nouvelle machine démarre : la reprise marche alors.
  env.reviveNew()
  await env.session.moveDuelSeries()
  await waitFor(() => seriesDone(env.session.getDuelView()), 'la série a fini sur la nouvelle machine')
  await env.session.endDuel(true)
})

test('machine figée (ni morte ni vivante) : changer de machine reprend aussi les duels qui tournaient', async (t) => {
  const env = setup(t)
  // L'ancienne machine ne répond plus aux générations, mais rien n'échoue : sans reprise, la série resterait bloquée.
  env.blockOld(4)
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => env.session.getDuelView().batch.some((r) => r.a === 'running' || r.b === 'running') && env.calls.generate.length > 4, 'des duels bloqués sur l’ancienne machine')
  const running = env.session.getDuelView().batch.filter((r) => r.a === 'running' || r.b === 'running').map((r) => r.number)
  assert.ok(running.length >= 1)
  await env.session.saveDuelRemote({ enabled: true, host: POD2, vramGb: 80, ramGb: 128 })
  await env.session.moveDuelSeries()
  await waitFor(() => seriesDone(env.session.getDuelView()), 'la série a fini sur la nouvelle machine')
  const after = env.session.getDuelView()
  for (const number of running) {
    const round = after.batch.find((r) => r.number === number)
    assert.equal(round.a, 'done', `duel ${number} : A refait, ni « arrêté » ni en erreur`)
    assert.equal(round.b, 'done', `duel ${number} : B refait, ni « arrêté » ni en erreur`)
  }
})

test('sans série en cours, changer de machine est refusé', async (t) => {
  const env = setup(t)
  await assert.rejects(env.session.moveDuelSeries(), /série/)
})
