import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 367 (Léo : « un score vitesse avec les tokens par seconde, comme avant avec Artificial Analysis mais avec nos
 * mesures ») : la vitesse de chaque modèle mesurée sur CE PC à la fin de chaque réponse remplace la vitesse publiée
 * dans le choix de Faible et Moyen.
 */
const speed = loadTsModule('shared/localSpeed.ts')

test('une réponse trop courte ou sans durée ne mesure rien', () => {
  assert.equal(speed.sampleSpeed(10, 1000), null)
  assert.equal(speed.sampleSpeed(100, 0), null)
  assert.equal(speed.sampleSpeed(undefined, 1000), null)
  assert.equal(speed.sampleSpeed(100, 2000), 50)
})

test('les 10 dernières mesures, la médiane : une mesure faussée ne compte pas', () => {
  let samples = {}
  for (let i = 0; i < 12; i++) samples = speed.addSpeedSample(samples, 'm:latest', 40)
  samples = speed.addSpeedSample(samples, 'm', 2) // un autre modèle occupait la carte
  assert.equal(samples.m.length, 10, 'jamais plus de 10 mesures, et « :latest » = sans tag')
  assert.equal(speed.measuredSpeeds(samples).m, 40)
  assert.deepEqual(speed.parseSpeedSamples({ m: [40, 'x', -3, 41], vide: [] }), { m: [40, 41] })
  assert.equal(speed.parseSpeedSamples([1, 2]), null)
})

test('vitesse retenue : mesurée, sinon publiée ramenée à ce PC, sinon publiée ; jamais deux échelles mélangées', () => {
  const published = { a: 200, b: 100, c: 50 }
  // Aucune mesure sur ce PC : la vitesse publiée, comme avant.
  assert.deepEqual(speed.resolveSpeed('b', {}, published), { speed: 100, kind: 'published' })
  // « a » mesuré 4 fois moins vite qu'annoncé : « b », jamais lancé, est estimé à 25 (et pas 100).
  assert.deepEqual(speed.resolveSpeed('a', { a: 50 }, published), { speed: 50, kind: 'measured' })
  assert.deepEqual(speed.resolveSpeed('b', { a: 50 }, published), { speed: 25, kind: 'estimated' })
  // Des mesures, mais aucun modèle commun pour calculer le rapport : inconnue.
  assert.deepEqual(speed.resolveSpeed('b', { inconnu: 30 }, published), { speed: null, kind: null })
  assert.deepEqual(speed.resolveSpeed('sans-mesure', {}, published), { speed: null, kind: null })
})

test('le magasin garde les mesures sur le disque et les relit après un redémarrage', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jaris-speed-'))
  const nodeModules = { fs, 'fs/promises': fsp, path }
  const load = () => {
    const atomic = loadTsModule('electron/services/atomicFile.ts', nodeModules)
    return loadTsModule('electron/services/speedStore.ts', {
      ...nodeModules,
      './atomicFile': atomic,
      './dataLocation': { getDataRoot: () => root },
      '../../shared/localSpeed': speed
    })
  }
  const store = load()
  await store.loadModelSpeeds()
  await store.recordModelSpeed('qwen3.5:4b', 300, 10_000)
  await store.recordModelSpeed('qwen3.5:4b', 5, 100) // trop courte
  assert.deepEqual(store.getMeasuredSpeeds(), { 'qwen3.5:4b': 30 })
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'model-speeds.json'), 'utf8')), { 'qwen3.5:4b': [30] })
  const after = load()
  await after.loadModelSpeeds()
  assert.deepEqual(after.getMeasuredSpeeds(), { 'qwen3.5:4b': 30 })
})

test('chaque réponse d’Ollama donne sa vitesse (modèle, tokens écrits, durée)', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/show')) return new Response('{}', { status: 200 })
    const line = { message: { role: 'assistant', content: 'ok' }, done: true, eval_count: 120, eval_duration: 3e9 }
    return new Response(JSON.stringify(line) + '\n', { status: 200 })
  }
  try {
    const ollama = loadTsModule('electron/services/ollama.ts', {
      '../config': { config: { ollama: { host: 'http://ollama.test', model: 'x', numCtx: 8192 } } },
      '../../shared/effort': { parseModelThinking: () => null },
      './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
      './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
    })
    const seen = []
    ollama.setSpeedRecorder((model, tokens, ms) => seen.push([model, tokens, ms]))
    await ollama.chatWithOllama([{ role: 'user', content: 'salut' }], undefined, 'qwen3.5:4b', 'low')
    await ollama.chatWithOllama([{ role: 'user', content: 'salut' }], undefined, 'qwen3.5:4b', 'low', undefined, () => {})
    assert.deepEqual(seen, [['qwen3.5:4b', 120, 3000], ['qwen3.5:4b', 120, 3000]], 'sans relais et en relais')
    ollama.setSpeedRecorder(() => {
      throw new Error('disque plein')
    })
    assert.equal((await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3.5:4b', 'low')).content, 'ok', 'une mesure perdue ne fait jamais échouer une réponse')
  } finally {
    globalThis.fetch = realFetch
  }
})

// Choix des modèles, sur les VRAIS scores du dépôt et la machine de Léo (8 Go, 32 Go).
const nodeRequire = createRequire(import.meta.url)
const scanSource = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function scan(measured) {
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, 'Fake GPU, 8192\n', '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: 'Fake GPU, 8192\n', stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (p) => {
        if (String(p).includes('verified-tool-scores.md')) return REAL_SCORES
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => 32 },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(scanSource, { exports, module: { exports }, require: withI18n((name) => modules[name] ?? nodeRequire(name)) })
  exports.setOllamaVersionSource(() => '0.40.10')
  if (measured) exports.setLocalSpeedResolver((model, published) => speed.resolveSpeed(model, measured, published))
  return exports
}

test('choix : sans mesure, identique à avant ; une vitesse mesurée lente fait perdre Faible', async () => {
  const before = await scan(null).pickBestModelsFromBenchmark()
  const noMeasure = await scan({}).pickBestModelsFromBenchmark()
  assert.equal(JSON.stringify(noMeasure), JSON.stringify(before), 'aucune mesure : la vitesse publiée, rien ne change')
  const fast = before.models.flash
  // Mesuré sur ce PC : le modèle Faible actuel est 20 fois plus lent qu'un autre petit modèle mesuré.
  const slow = await scan({ [fast]: 3, 'ministral-3:3b': 60 }).pickBestModelsFromBenchmark()
  assert.notEqual(slow.models.flash, fast, 'trop lent sur ce PC : il ne passe plus le plancher de Faible')
  assert.equal(slow.models.large, before.models.large, 'Élevé ne regarde pas la vitesse')
})

test('« Tous les modèles » dit d’où vient chaque vitesse', async () => {
  const overview = await scan({ 'ministral-3:3b': 60 }).getModelOverview()
  const byModel = new Map(overview.entries.map((e) => [e.model, e]))
  assert.equal(byModel.get('ministral-3:3b').localSpeedKind, 'measured')
  assert.equal(byModel.get('ministral-3:3b').localSpeed, 60)
  assert.equal(byModel.get('granite4.2:8b').localSpeedKind, 'estimated')
})
