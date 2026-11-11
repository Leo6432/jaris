import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 469 : Qwen3.5-0.8B corrigé (Weight-Space Programming), importé de Hugging Face, arrive SANS les réglages du
 * qwen3.5:0.8b officiel (presence_penalty 1.5, temperature 1, top_k 20, top_p 0.95, lus dans le registre d'Ollama) :
 * Ollama lui appliquerait les siens, et il ne serait plus comparable à l'original. Jaris les applique à chaque
 * installation ou vérification (pullModelIfMissing), le script de test avant chaque épreuve (copie vérifiée ici).
 */
const MODEL = 'hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0'
const OFFICIAL = { presence_penalty: 1.5, temperature: 1, top_k: 20, top_p: 0.95 }

const calls = []
let installed = []
let createStatus = 200
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ url: String(url), body })
  if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: installed.map((name) => ({ name })) }), { status: 200 })
  if (String(url).endsWith('/api/pull')) {
    installed.push(body.name)
    return new Response(`${JSON.stringify({ status: 'success' })}\n`, { status: 200 })
  }
  if (String(url).endsWith('/api/create')) {
    if (createStatus !== 200) return new Response(JSON.stringify({ error: 'disque plein' }), { status: createStatus })
    return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
  }
  throw new Error(`appel inattendu : ${url}`)
}
test.after(() => {
  globalThis.fetch = realFetch
})

const defaults = loadTsModule('electron/services/modelDefaults.ts')
const ollama = loadTsModule('electron/services/ollama.ts', {
  '../config': { config: { ollama: { host: 'http://ollama.test', model: 'm', numCtx: 8192 } } },
  '../../shared/effort': { parseModelThinking: () => null },
  './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
  './modelDefaults': defaults,
  './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
})
const creates = () => calls.filter((c) => c.url.endsWith('/api/create')).map((c) => ({ url: c.url, ...c.body }))
const expected = { url: 'http://ollama.test/api/create', model: MODEL, from: MODEL, parameters: OFFICIAL, stream: false }

test('les réglages du qwen3.5:0.8b officiel, à l’identique', () => {
  assert.deepEqual({ ...defaults.MODEL_DEFAULT_PARAMETERS[MODEL] }, OFFICIAL)
})

test('téléchargé par Jaris : ses réglages d’origine appliqués juste après, sous le même nom', async () => {
  calls.length = 0
  installed = []
  assert.equal(await ollama.pullModelIfMissing(MODEL), true)
  assert.deepEqual(creates(), [expected])
  const order = calls.map((c) => c.url.split('/').pop())
  assert.ok(order.indexOf('pull') < order.indexOf('create'), order.join(', '))
})

test('déjà installé : réglages remis à chaque vérification (un premier essai manqué se rattrape)', async () => {
  calls.length = 0
  installed = [MODEL]
  assert.equal(await ollama.pullModelIfMissing(MODEL), false)
  assert.deepEqual(creates(), [expected])
})

test('un autre modèle : rien n’est touché', async () => {
  calls.length = 0
  installed = []
  await ollama.pullModelIfMissing('qwen3.5:0.8b')
  installed = ['qwen3.5:0.8b']
  await ollama.pullModelIfMissing('qwen3.5:0.8b')
  assert.deepEqual(creates(), [])
})

test('Ollama refuse les réglages : le vrai message remonte, mais le modèle reste utilisable', async () => {
  createStatus = 500
  try {
    await assert.rejects(defaults.applyModelDefaults('http://ollama.test', MODEL), /réglages non appliqués \(500 : disque plein\)/)
    installed = [MODEL]
    const warn = console.warn
    const warned = []
    console.warn = (message) => warned.push(String(message))
    try {
      assert.equal(await ollama.pullModelIfMissing(MODEL), false)
    } finally {
      console.warn = warn
    }
    assert.match(warned.join('\n'), /disque plein/)
  } finally {
    createStatus = 200
  }
})

test('le script de test applique exactement les mêmes réglages (copie de benchmark-models.mjs)', () => {
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  const literal = script.match(/const MODEL_DEFAULT_PARAMETERS = (\{[\s\S]*?\r?\n\})/)?.[1]
  assert.ok(literal, 'MODEL_DEFAULT_PARAMETERS introuvable dans benchmark-models.mjs')
  const copy = Function(`return ${literal}`)()
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), JSON.parse(JSON.stringify(defaults.MODEL_DEFAULT_PARAMETERS)))
})
