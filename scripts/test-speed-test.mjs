import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 514 (Léo : « un bouton pour tester la vitesse de tous les modèles, pouvoir choisir ceux que je veux ou tout, et
 * les mêmes questions pour tout le monde… comme l'analyse mais pour la vitesse ») : electron/services/speedTest.ts,
 * avec un faux Ollama qui note chaque question reçue et répond comme le vrai (flux NDJSON, eval_count / eval_duration
 * sur le dernier fragment).
 */
const localSpeed = loadTsModule('shared/localSpeed.ts')

const CANDIDATES = [
  { model: 'petit:1b', sizeGb: 1 },
  { model: 'moyen:4b', sizeGb: 3 },
  { model: 'gros:70b', sizeGb: 40 },
  { model: 'utilise:8b', sizeGb: 5 }
]

function setup({ installed = ['petit:1b'], tooBig = ['gros:70b'], speeds = {}, refuseThink = [], stallOn = null, stored = {} } = {}) {
  const calls = { pulled: [], deleted: [], preloaded: [], questions: [], unloaded: [], saved: [] }
  const ollama = {
    listInstalledModels: async () => [...installed],
    unloadOllamaModels: async () => [],
    fitToModelContext: async (_model, numCtx) => numCtx,
    preloadModel: async (model, numCtx) => {
      calls.preloaded.push([model, numCtx])
      return true
    },
    pullModelIfMissing: async (model, _status, onProgress) => {
      if (installed.includes(model)) return false
      if (tooBig.includes(model)) throw new Error(`${model} est trop gros pour ce PC`)
      onProgress?.({ model, completed: 50, total: 100, percent: 50 })
      calls.pulled.push(model)
      installed.push(model)
      return true
    },
    deleteModel: async (model) => {
      calls.deleted.push(model)
    },
    fetchOllamaVersion: async () => '0.40.17'
  }
  const store = {
    getSpeedResults: () => stored,
    saveSpeedResult: async (model, speed) => {
      calls.saved.push([model, speed])
    }
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.keep_alive === 0) {
      calls.unloaded.push(body.model)
      return new Response('{}', { status: 200 })
    }
    if (refuseThink.includes(body.model) && 'think' in body) {
      return new Response(JSON.stringify({ error: `"${body.model}" does not support thinking` }), { status: 400 })
    }
    calls.questions.push({ model: body.model, prompt: body.prompt, options: body.options, think: body.think, stream: body.stream })
    if (stallOn === body.model) {
      // Ne répond jamais : seul le chien de garde (inactivité) ou l'arrêt y met fin.
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }
    const tokensPerSecond = speeds[body.model] ?? 50
    const lines = [
      JSON.stringify({ response: 'Il était', done: false }),
      JSON.stringify({ response: ' une fois', done: true, eval_count: 256, eval_duration: (256 / tokensPerSecond) * 1e9 })
    ]
    return new Response(lines.join('\n') + '\n', { status: 200 })
  }
  const runner = loadTsModule('electron/services/speedTest.ts', {
    '../config': { config: { ollama: { host: 'http://ollama.test' } }, runWithLocalOllama: (fn) => fn() },
    './ollama': ollama,
    './hardwareScan': { getAllCandidateSizes: () => CANDIDATES, detectGpu: async () => ({ name: 'NVIDIA GeForce RTX 3070', vramGb: 8 }) },
    './systemResources': { detectRamGb: () => 32 },
    './profileStore': { getProfile: async () => ({ models: { flash: 'utilise:8b', medium: 'utilise:8b', large: 'utilise:8b' }, visionModel: 'utilise:8b' }) },
    './speedStore': store,
    '../../shared/localSpeed': localSpeed
  })
  return { runner, calls, restore: () => (globalThis.fetch = realFetch) }
}

test('étape 514 : chaque modèle reçoit EXACTEMENT les mêmes questions et réglages ; vitesse = médiane', async () => {
  const { runner, calls, restore } = setup({ speeds: { 'petit:1b': 120, 'moyen:4b': 40 } })
  try {
    const events = []
    const result = await runner.runSpeedTest(['petit:1b', 'moyen:4b'], (e) => events.push(e))
    assert.deepEqual(result, { tested: 2 })
    const byModel = (m) => calls.questions.filter((q) => q.model === m)
    assert.equal(byModel('petit:1b').length, 3)
    assert.deepEqual(
      byModel('petit:1b').map(({ prompt, options, think, stream }) => ({ prompt, options, think, stream })),
      byModel('moyen:4b').map(({ prompt, options, think, stream }) => ({ prompt, options, think, stream })),
      'mêmes questions, mêmes réglages'
    )
    assert.deepEqual(byModel('petit:1b').map((q) => q.prompt), [...localSpeed.SPEED_TEST_PROMPTS])
    assert.deepEqual(byModel('petit:1b')[0].options, { ...localSpeed.SPEED_TEST_OPTIONS })
    assert.equal(byModel('petit:1b')[0].think, false, 'pas de réflexion cachée')
    assert.deepEqual(calls.saved.map(([m, s]) => [m, Math.round(s)]), [['petit:1b', 120], ['moyen:4b', 40]])
    assert.deepEqual(calls.preloaded, [['petit:1b', 16384], ['moyen:4b', 16384]], 'chargé d’abord, jamais compté')
    assert.deepEqual(calls.unloaded, ['petit:1b', 'moyen:4b'], 'déchargé après : le suivant a toute la carte')
    assert.ok(events.some((e) => e.type === 'measuring' && e.model === 'moyen:4b' && e.question === 3 && e.total === 3))
    assert.deepEqual(events.at(-1), { type: 'progress', done: 2, total: 2 })
  } finally {
    restore()
  }
})

test('étape 514 : un modèle absent est téléchargé, puis supprimé — sauf s’il sert à Jaris ; trop gros = sauté avec la raison', async () => {
  const { runner, calls, restore } = setup({ installed: [] })
  try {
    const events = []
    await runner.runSpeedTest(['moyen:4b', 'utilise:8b', 'gros:70b'], (e) => events.push(e))
    assert.deepEqual(calls.pulled, ['moyen:4b', 'utilise:8b'])
    assert.deepEqual(calls.deleted, ['moyen:4b'], 'utilise:8b sert à Jaris : gardé')
    assert.ok(events.some((e) => e.type === 'downloading' && e.model === 'moyen:4b' && e.percent === 50))
    assert.deepEqual(events.find((e) => e.type === 'skipped'), { type: 'skipped', model: 'gros:70b', reason: 'gros:70b est trop gros pour ce PC' })
    assert.equal(calls.questions.filter((q) => q.model === 'gros:70b').length, 0)
  } finally {
    restore()
  }
})

test('étape 514 : un nom venu de l’écran qui n’est pas un modèle de Jaris est ignoré', async () => {
  const { runner, calls, restore } = setup()
  try {
    await runner.runSpeedTest(['petit:1b', 'pirate:1b', '../../etc'], () => {})
    assert.deepEqual([...new Set(calls.questions.map((q) => q.model))], ['petit:1b'])
  } finally {
    restore()
  }
})

test('étape 514 : un modèle sans mode réflexion refuse « think » — même question sans lui, même mesure', async () => {
  const { runner, calls, restore } = setup({ refuseThink: ['petit:1b'] })
  try {
    await runner.runSpeedTest(['petit:1b'], () => {})
    assert.equal(calls.questions.length, 3)
    assert.ok(calls.questions.every((q) => q.think === undefined))
    assert.equal(calls.saved.length, 1)
  } finally {
    restore()
  }
})

test('étape 514 : « Arrêter » pendant une question — rien d’enregistré pour ce modèle, rien de plus demandé, Jaris libéré', async () => {
  const { runner, calls, restore } = setup({ stallOn: 'petit:1b' })
  try {
    const done = runner.runSpeedTest(['petit:1b', 'moyen:4b'], () => {})
    while (calls.questions.length === 0) await new Promise((r) => setTimeout(r, 5))
    assert.equal(runner.isSpeedTestRunning(), true)
    runner.stopSpeedTest()
    assert.deepEqual(await done, { tested: 0, stopped: true })
    assert.deepEqual(calls.saved, [])
    assert.equal(calls.questions.filter((q) => q.model === 'moyen:4b').length, 0, 'le modèle suivant n’est jamais commencé')
    assert.equal(runner.isSpeedTestRunning(), false)
  } finally {
    restore()
  }
})

test('étape 514 : un second lancement pendant un test est refusé avec un vrai message', async () => {
  const { runner, calls, restore } = setup({ stallOn: 'petit:1b' })
  try {
    const first = runner.runSpeedTest(['petit:1b'], () => {})
    while (calls.questions.length === 0) await new Promise((r) => setTimeout(r, 5))
    await assert.rejects(runner.runSpeedTest(['moyen:4b'], () => {}), /Un test de vitesse est déjà en cours\./)
    runner.stopSpeedTest()
    await first
  } finally {
    restore()
  }
})

test('étape 514 : un modèle qui n’écrit plus rien est abandonné après le délai d’inactivité, avec la raison', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, calls, restore } = setup({ stallOn: 'petit:1b' })
  try {
    const events = []
    const done = runner.runSpeedTest(['petit:1b'], (e) => events.push(e))
    while (calls.questions.length === 0) {
      t.mock.timers.tick(0)
      await new Promise((r) => setImmediate(r))
    }
    t.mock.timers.tick(runner.SPEED_IDLE_MS)
    assert.deepEqual(await done, { tested: 0 })
    const skipped = events.find((e) => e.type === 'skipped')
    assert.match(skipped.reason, /n'a rien écrit pendant 180 s/)
  } finally {
    restore()
  }
})

test('étape 514 : la liste de l’écran — du plus petit au plus gros, installé ou non, vitesse actuelle', async () => {
  const { runner, restore } = setup()
  try {
    const list = await runner.getSpeedTestModels()
    assert.deepEqual(list.map((m) => m.model), ['petit:1b', 'moyen:4b', 'utilise:8b', 'gros:70b'])
    assert.deepEqual(list[0], { model: 'petit:1b', sizeGb: 1, installed: true, speed: null, testedAt: null })
    assert.equal(list[1].installed, false)
  } finally {
    restore()
  }
})

// Étape 516 (Léo : « je vais te donner les résultats et personne ne va faire de test… l'utilisateur ne fait rien ») :
// le fichier des vitesses à m'envoyer dit sur QUELLE machine elles ont été mesurées.
test('étape 516 : le fichier à m’envoyer — vitesses, carte graphique, mémoire, Ollama, Jaris, version du test', async () => {
  const stored = { 'petit:1b': { speed: 182.2, testedAt: '2026-11-23T10:00:00.000Z' } }
  const { runner, restore } = setup({ stored })
  try {
    const built = await runner.buildSpeedExport('0.76.1')
    assert.equal(built.models, 1)
    const file = JSON.parse(built.json)
    assert.equal(file.kind, 'jaris-speed-test')
    assert.equal(file.testVersion, localSpeed.SPEED_TEST_VERSION)
    assert.equal(file.jaris, '0.76.1')
    assert.equal(file.ollama, '0.40.17')
    assert.equal(file.gpu, 'NVIDIA GeForce RTX 3070')
    assert.equal(file.vramGb, 8)
    assert.equal(file.ramGb, 32)
    assert.deepEqual(file.results, stored)
  } finally {
    restore()
  }
})

test('étape 516 : aucune vitesse mesurée = rien à envoyer', async () => {
  const { runner, restore } = setup()
  try {
    assert.equal(await runner.buildSpeedExport('0.76.1'), null)
  } finally {
    restore()
  }
})
