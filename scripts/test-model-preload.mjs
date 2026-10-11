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
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://ollama.test/api/generate')
  assert.deepEqual(calls[0].body, { model: 'qwen3.5:4b', prompt: '', options: { num_ctx: 16384 } })
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
