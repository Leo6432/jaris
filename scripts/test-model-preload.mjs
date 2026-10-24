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

const ollama = loadTsModule('electron/services/ollama.ts', {
  '../config': { config: { ollama: { host: 'http://ollama.test', model: 'modele-defaut', numCtx: 8192 } } },
  '../../shared/effort': { parseModelThinking: () => null },
  './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
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

test('correction de la transcription : la fenêtre demandée est bien envoyée à Ollama', async () => {
  calls.length = 0
  respond = async () => new Response(JSON.stringify({ message: { role: 'assistant', content: '{"text":"ok"}' }, done: true }), { status: 200 })
  await ollama.structuredChat([{ role: 'user', content: 'x' }], 'qwen3.5:4b', { type: 'object' }, undefined, 8192)
  assert.equal(calls[0].body.options.num_ctx, 8192)
  // Sans valeur : l'ancien comportement (2048) pour les autres usages.
  calls.length = 0
  await ollama.structuredChat([{ role: 'user', content: 'x' }], 'qwen3.5:4b', { type: 'object' })
  assert.equal(calls[0].body.options.num_ctx, 2048)
})

test('toutes les demandes au modèle de conversation utilisent LA MÊME fenêtre (sinon Ollama le recharge)', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const same = 'profile?.contextLength ?? config.ollama.numCtx'
  assert.ok(read('electron/services/assistant.ts').includes(`const numCtx = ${same}`), 'la conversation')
  assert.ok(read('electron/services/voicePipeline.ts').includes(same), 'la correction de ce qui est entendu')
  assert.ok(read('electron/services/memoryExtractor.ts').includes(same), 'la mémoire automatique')
  assert.ok(read('electron/main.ts').includes(`preloadModel(model, ${same})`), 'le préchargement au démarrage')
})

// Étape 346 : le modèle de vision est souvent aussi celui de la conversation — une autre fenêtre le faisait recharger.
test('regarder l’écran et piloter utilisent la même fenêtre que la conversation, ramenée au modèle', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  for (const path of ['electron/services/vision.ts', 'electron/services/computerUse.ts']) {
    const source = read(path)
    assert.ok(!source.includes('num_ctx: config.ollama.numCtx'), `${path} : plus de fenêtre fixe`)
    // vision.ts passe par chatWithOllama (annulable, en streaming) : la fenêtre y est le dernier argument.
    assert.ok(source.includes('num_ctx: await sharedNumCtx(model)') || /chatWithOllama\([\s\S]{0,400}?await sharedNumCtx\(model\)\s*\)/.test(source), path)
    const helper = source.slice(source.indexOf('async function sharedNumCtx'), source.indexOf('async function sharedNumCtx') + 400)
    assert.ok(helper.includes('getProfile()') && helper.includes('contextLength ?? config.ollama.numCtx'), path)
    assert.ok(helper.includes('fitToModelContext(model, wanted)'), path)
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
  assert.match(voice, /const model = await preferLoadedModel\(\s*Object\.values\(profile\?\.models \?\? \{\}\),\s*profile\?\.models\?\.flash/)
  assert.match(memory, /const model = await preferLoadedModel\(Object\.values\(profile\?\.models \?\? \{\}\), profile\?\.models\?\.medium/)
})

// Étape 351 : où Ollama a vraiment rangé un modèle chargé (test Terminal-Bench : la fenêtre ne compte que si TOUT le
// modèle est sur la carte). Un modèle sans tag est listé sous « :latest » par Ollama.
test('placement d’un modèle chargé lu dans /api/ps, même sans tag', async () => {
  respond = async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: 'autre:7b', model: 'autre:7b', size: 9, size_vram: 9 },
          { name: 'hf.co/org/depot:latest', model: 'hf.co/org/depot:latest', size: 5000, size_vram: 4000, context_length: 65536 }
        ]
      }),
      { status: 200 }
    )
  assert.deepEqual(await ollama.modelPlacement('hf.co/org/depot'), { sizeBytes: 5000, vramBytes: 4000, contextLength: 65536 })
  assert.deepEqual(await ollama.modelPlacement('autre:7b'), { sizeBytes: 9, vramBytes: 9, contextLength: null })
  assert.equal(await ollama.modelPlacement('absent:1b'), null)
  respond = async () => new Response('', { status: 500 })
  assert.equal(await ollama.modelPlacement('autre:7b'), null)
})
