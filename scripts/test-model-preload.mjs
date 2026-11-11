import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 294 — le modèle de conversation est préchargé pendant l'écran de démarrage, et ne doit plus être rechargé
 * entre deux appels. Fait vérifié dans le code source d'Ollama (server/sched.go, `needsReload`) : une fenêtre de
 * contexte (`num_ctx`) différente de celle du modèle déjà chargé le fait recharger entièrement. Jusqu'ici, à la voix,
 * la correction de la phrase (2048) puis la réponse (8192) rechargeaient le modèle rapide deux fois par phrase.
 */
const calls = []
let respond = async () => new Response('{}', { status: 200 })
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
  return respond(String(url), init)
}
test.after(() => {
  globalThis.fetch = realFetch
})

const fakeConfig = { ollama: { host: 'http://ollama.test', model: 'modele-defaut', numCtx: 8192 } }
const ollama = loadTsModule('electron/services/ollama.ts', {
  '../config': { config: fakeConfig },
  '../../shared/effort': { parseModelThinking: () => null },
  './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
  './modelDefaults': { applyModelDefaults: async () => {} },
  './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
})

test('préchargement : une requête vide sur /api/generate, avec la fenêtre des vraies demandes', async () => {
  calls.length = 0
  respond = async () => new Response(JSON.stringify({ model: 'qwen3.5:4b', response: '', done: true }), { status: 200 })
  assert.equal(await ollama.preloadModel('qwen3.5:4b', 16384), true)
  const generate = calls.filter((call) => call.url.endsWith('/api/generate'))
  assert.equal(generate.length, 1)
  assert.equal(generate[0].url, 'http://ollama.test/api/generate')
  assert.deepEqual(generate[0].body, { model: 'qwen3.5:4b', prompt: '', options: { num_ctx: 16384 } })
})

// Étape 299 (Léo : « on est d'accord que tous les modèles n'ont pas le même contexte ? ») : la mémoire réglée vaut pour
// tous les modèles, mais un modèle ne reçoit jamais plus que son propre maximum — au préchargement comme aux vraies
// demandes, sinon Ollama le rechargerait entre les deux (étape 294).
test('fenêtre ramenée au maximum du modèle, la même au préchargement et aux demandes, lue une seule fois', async () => {
  calls.length = 0
  respond = async (url) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'qwen3.context_length': 40960 } }), { status: 200 })
    if (url.endsWith('/api/generate')) return new Response('{"done":true}', { status: 200 })
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 900, eval_count: 100 }), { status: 200 })
  }
  assert.equal(await ollama.preloadModel('qwen3:1.7b', 65536), true)
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3:1.7b', 'low', undefined, 65536)
  await ollama.structuredChat([{ role: 'user', content: 'x' }], 'qwen3:1.7b', { type: 'object' }, undefined, 65536)
  const sent = calls.filter((call) => !call.url.endsWith('/api/show')).map((call) => call.body.options.num_ctx)
  assert.deepEqual(sent, [40960, 40960, 40960])
  assert.equal(calls.filter((call) => call.url.endsWith('/api/show')).length, 1, 'le maximum est mis en cache')

  // Un réglage plus petit que le maximum du modèle est gardé tel quel.
  calls.length = 0
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3:1.7b', 'low', undefined, 16384)
  assert.equal(calls.at(-1).body.options.num_ctx, 16384)
})

test('maximum du modèle illisible (Ollama injoignable) : aucun plafond, et on réessaiera plus tard', async () => {
  calls.length = 0
  let showAnswers = false
  respond = async (url) => {
    if (url.endsWith('/api/show')) {
      if (!showAnswers) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ model_info: { 'gemma4.context_length': 32768 } }), { status: 200 })
    }
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), { status: 200 })
  }
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'gemma4:e4b', 'low', undefined, 65536)
  assert.equal(calls.at(-1).body.options.num_ctx, 65536)
  showAnswers = true
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'gemma4:e4b', 'low', undefined, 65536)
  assert.equal(calls.at(-1).body.options.num_ctx, 32768)
})

test('préchargement raté (modèle absent, Ollama arrêté) : `false`, jamais d’exception', async () => {
  respond = async () => new Response('model not found', { status: 404 })
  assert.equal(await ollama.preloadModel('absent:1b', 8192), false)
  respond = async () => {
    throw new TypeError('fetch failed')
  }
  assert.equal(await ollama.preloadModel('qwen3.5:4b', 8192), false)
})

test('attente du moteur : `true` dès qu’Ollama répond, `false` au délai sans réponse', async () => {
  let attempts = 0
  respond = async () => {
    attempts++
    if (attempts < 3) throw new TypeError('ECONNREFUSED')
    return new Response('{"models":[]}', { status: 200 })
  }
  assert.equal(await ollama.waitForOllama(5_000, 5), true)
  assert.equal(attempts, 3)
  respond = async () => {
    throw new TypeError('ECONNREFUSED')
  }
  assert.equal(await ollama.waitForOllama(40, 5), false)
})

test('correction de la transcription : une fenêtre imposée est envoyée telle quelle, sinon la fenêtre automatique', async () => {
  calls.length = 0
  respond = async () => new Response(JSON.stringify({ message: { role: 'assistant', content: '{"text":"ok"}' }, done: true }), { status: 200 })
  await ollama.structuredChat([{ role: 'user', content: 'x' }], 'correcteur:4b', { type: 'object' }, undefined, 8192)
  assert.equal(calls.at(-1).body.options.num_ctx, 8192)
  calls.length = 0
  await ollama.structuredChat([{ role: 'user', content: 'x' }], 'autre-correcteur:4b', { type: 'object' })
  assert.equal(calls.at(-1).body.options.num_ctx, 16384)
})

// Léo (« tout automatique », comme le mode Code) : sans fenêtre imposée, elle est calculée d'après ce qu'il y a à lire,
// et ne redescend pas tant que le modèle est sans doute encore chargé (sinon Ollama le recharge, étape 294).
test('fenêtre automatique : grandit avec la demande, ne redescend pas, et reste la même au préchargement', async () => {
  calls.length = 0
  respond = async (url) =>
    url.endsWith('/api/generate')
      ? new Response('{"done":true}', { status: 200 })
      : new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), { status: 200 })
  const chat = async (text) => {
    await ollama.chatWithOllama([{ role: 'user', content: text }], undefined, 'auto:9b', 'low')
    return calls.filter((call) => call.url.endsWith('/api/chat')).at(-1).body.options.num_ctx
  }
  assert.equal(await chat('Bonjour'), 16384, 'une petite demande : le premier palier')
  // Une longue page lue : ~60 000 caractères -> ~24 000 tokens + la réserve -> 32k.
  assert.equal(await chat('x'.repeat(60_000)), 32768)
  assert.equal(await chat('Merci'), 32768, 'ne redescend pas : le modèle est encore chargé à 32k')
  assert.equal(await ollama.preloadModel('auto:9b'), true)
  assert.equal(calls.at(-1).body.options.num_ctx, 32768, 'le préchargement reprend la même fenêtre')
  assert.equal(await ollama.autoContextFor('jamais-vu:4b'), 16384)
})

test('fenêtre automatique remplie par la réflexion : un seul nouvel essai au palier suivant', async () => {
  calls.length = 0
  let first = true
  respond = async (url) => {
    if (!url.endsWith('/api/chat')) return new Response('{}', { status: 200 })
    if (first) {
      first = false
      return new Response(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' }), { status: 200 })
    }
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Réponse.' }, done: true }), { status: 200 })
  }
  const reply = await ollama.chatWithOllama([{ role: 'user', content: 'Explique-moi' }], undefined, 'pense:9b', 'low')
  assert.equal(reply.content, 'Réponse.')
  const sent = calls.filter((call) => call.url.endsWith('/api/chat')).map((call) => call.body.options.num_ctx)
  assert.deepEqual(sent, [16384, 32768])
})

test('toutes les demandes au modèle de conversation passent par la fenêtre automatique (une seule règle, ollama.ts)', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const assistant = read('electron/services/assistant.ts')
  assert.ok(assistant.includes('const numCtx = undefined'), 'la conversation')
  assert.ok(!/contextLength/.test(assistant + read('electron/services/voicePipeline.ts') + read('electron/services/memoryExtractor.ts')))
  assert.ok(read('electron/main.ts').includes('return preloadModel(model)'), 'le préchargement au démarrage')
})

// Étape 346 : le modèle de vision est souvent aussi celui de la conversation — une autre fenêtre le faisait recharger.
test('regarder l’écran et piloter reprennent la fenêtre automatique du modèle', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  for (const path of ['electron/services/vision.ts', 'electron/services/computerUse.ts']) {
    const source = read(path)
    assert.ok(!source.includes('num_ctx: config.ollama.numCtx'), `${path} : plus de fenêtre fixe`)
    assert.ok(source.includes('num_ctx: await sharedNumCtx(model)') || /chatWithOllama\([\s\S]{0,400}?await sharedNumCtx\(model\)\s*\)/.test(source), path)
    const helper = source.slice(source.indexOf('async function sharedNumCtx'), source.indexOf('async function sharedNumCtx') + 400)
    assert.ok(helper.includes('autoContextFor(model)'), path)
  }
})

// Étape 346 (« sur ton PC, chaque phrase dite à voix haute recharge deux modèles ») : la correction de la phrase et la
// mémoire automatique prennent le modèle de Jaris déjà chargé, au lieu d'en charger un autre à chaque phrase.
test('étape 346 : le modèle de Jaris déjà chargé est préféré, sinon le modèle prévu', async () => {
  respond = async (url) =>
    url.endsWith('/api/ps')
      ? new Response(JSON.stringify({ models: [{ model: 'qwen3.5:9b', size_vram: 7 * 1024 ** 3 }] }), { status: 200 })
      : new Response('{}', { status: 200 })
  assert.equal(await ollama.preferLoadedModel(['ministral-3:3b', 'qwen3.5:9b'], 'ministral-3:3b'), 'qwen3.5:9b')
  assert.equal(await ollama.preferLoadedModel(['ministral-3:3b'], 'ministral-3:3b'), 'ministral-3:3b', 'un modèle étranger chargé ne compte pas')
  const loaded = await ollama.loadedOllamaModels()
  assert.equal(loaded[0].model, 'qwen3.5:9b')
  assert.equal(Math.round(loaded[0].vramGb), 7)
  respond = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await ollama.preferLoadedModel(['qwen3.5:9b'], 'ministral-3:3b'), 'ministral-3:3b', 'Ollama muet : le modèle prévu')
})

test('étape 346 : la correction (voix) et la mémoire passent bien par le modèle déjà chargé', () => {
  const voice = readFileSync(new URL('../electron/services/voicePipeline.ts', import.meta.url), 'utf8')
  const memory = readFileSync(new URL('../electron/services/memoryExtractor.ts', import.meta.url), 'utf8')
  // Étape 355 : les modèles de la VOIX (choisis par les duels « Vocal »), sinon ceux du Chat — toujours le Rapide en repli.
  assert.match(voice, /const voiceModels = profile\?\.voiceModels \?\? profile\?\.models\s+const model = await preferLoadedModel\(Object\.values\(voiceModels \?\? \{\}\), voiceModels\?\.flash/)
  assert.match(memory, /const model = await preferLoadedModel\(Object\.values\(profile\?\.models \?\? \{\}\), profile\?\.models\?\.medium/)
})

// Étape 387 (pod de Léo : processeur à 100 %, carte à 25 %) : pendant un duel sur une autre machine, un modèle qui
// tient sur la carte reçoit peu de fils de calcul — à CHAQUE demande (sinon Ollama le recharge, comme pour num_ctx).
test('fils de calcul : envoyés quand le travail en cours en demande pour ce modèle, sinon rien', async () => {
  respond = async (url) => {
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 })
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), { status: 200 })
  }
  try {
    fakeConfig.ollama.threadsFor = (model) => (model === 'petit:4b' ? 4 : undefined)
    calls.length = 0
    await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'petit:4b', 'low', undefined, 32768)
    await ollama.chatWithOllama([{ role: 'user', content: 'y' }], undefined, 'petit:4b', 'low', undefined, 32768)
    const chats = calls.filter((call) => call.url.endsWith('/api/chat'))
    assert.deepEqual(chats.map((call) => call.body.options.num_thread), [4, 4])
    calls.length = 0
    await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'gros:70b', 'low', undefined, 32768)
    assert.equal('num_thread' in calls.at(-1).body.options, false, 'modèle qui déborde : réglage d’Ollama inchangé')
  } finally {
    delete fakeConfig.ollama.threadsFor
  }
  calls.length = 0
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'petit:4b', 'low', undefined, 32768)
  assert.equal('num_thread' in calls.at(-1).body.options, false, 'hors duel distant : rien')
})

// Léo (duel Code : un modèle « réfléchit » 39 min, 671 122 caractères) : une réponse ne dépasse jamais sa fenêtre —
// sinon Ollama fait glisser la fenêtre d'un modèle qui tourne en rond, et il réfléchit sans fin.
test('une réponse ne peut jamais dépasser sa fenêtre (num_predict), imposée ou automatique', async () => {
  calls.length = 0
  respond = async () => new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), { status: 200 })
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'boucle:9b', 'low', undefined, 32768)
  const imposed = calls.filter((call) => call.url.endsWith('/api/chat')).at(-1).body.options
  assert.equal(imposed.num_predict, imposed.num_ctx)
  await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'boucle2:9b', 'low')
  const auto = calls.filter((call) => call.url.endsWith('/api/chat')).at(-1).body.options
  assert.equal(auto.num_predict, auto.num_ctx)
})
