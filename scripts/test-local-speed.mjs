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
 * dans le choix de Faible et Moyen. Étape 498 (Léo : « supprime toutes les vitesses, tous les trucs d'Artificial
 * Analysis, on va les mesurer sur le PC ») : c'est désormais la SEULE vitesse — ni publiée, ni estimée à partir d'elle.
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

test('vitesse retenue : mesurée sur ce PC, sinon inconnue — jamais une vitesse venue d’ailleurs (étape 498)', () => {
  assert.deepEqual(speed.resolveSpeed('a', { a: 50 }), { speed: 50, kind: 'measured' })
  assert.deepEqual(speed.resolveSpeed('a:latest', { a: 50 }), { speed: 50, kind: 'measured' }, '« :latest » = sans tag')
  assert.deepEqual(speed.resolveSpeed('b', { a: 50 }), { speed: null, kind: null }, 'jamais lancé ici : inconnue, pas estimée')
  assert.deepEqual(speed.resolveSpeed('b', {}), { speed: null, kind: null })
  assert.equal(speed.localToPublishedRatio, undefined, 'plus de rapport avec une vitesse publiée')
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

test('étape 377 : une réponse d’un Ollama d’une autre machine (duel sur une carte louée) ne mesure rien pour CE PC', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/show')) return new Response('{}', { status: 200 })
    const line = { message: { role: 'assistant', content: 'ok' }, done: true, eval_count: 120, eval_duration: 3e9 }
    return new Response(JSON.stringify(line) + '\n', { status: 200 })
  }
  try {
    const ollama = loadTsModule('electron/services/ollama.ts', {
      '../config': { config: { ollama: { host: 'https://pod-11434.proxy.runpod.net', model: 'x', numCtx: 8192, remote: true } } },
      '../../shared/effort': { parseModelThinking: () => null },
      './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
      './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
    })
    const seen = []
    ollama.setSpeedRecorder((model, tokens, ms) => seen.push([model, tokens, ms]))
    await ollama.chatWithOllama([{ role: 'user', content: 'salut' }], undefined, 'qwen3.5:4b', 'low', undefined, () => {})
    assert.deepEqual(seen, [])
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

function scan(measured, vramMib = 8192) {
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
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
  if (measured) exports.setLocalSpeedResolver((model) => speed.resolveSpeed(model, measured))
  return exports
}

test('choix : sans mesure, Faible = le meilleur des plus légers ; une vitesse mesurée lente fait perdre Faible', async () => {
  // Étape 498 : plus de vitesse publiée. Sans aucune mesure (premier lancement), la légèreté est le seul repère de
  // vitesse : Faible ne prend plus le même gros modèle que Moyen sur une grande carte.
  const before = await scan(null, 24 * 1024).pickBestModelsFromBenchmark()
  const noMeasure = await scan({}, 24 * 1024).pickBestModelsFromBenchmark()
  assert.equal(JSON.stringify(noMeasure), JSON.stringify(before), 'aucune mesure = aucun résolveur')
  const overview = await scan(null, 24 * 1024).getModelOverview()
  const memory = new Map(overview.entries.map((e) => [e.model, e.vramGb]))
  assert.notEqual(before.models.flash, before.models.medium, 'Faible n’est pas le modèle de Moyen')
  assert.ok(memory.get(before.models.flash) <= 2 * Math.min(...overview.entries.filter((e) => e.toolCalling).map((e) => e.vramGb)), 'un « petit »')
  // Mesuré sur ce PC : tous les modèles à 60 tok/s, sauf le Faible actuel, 20 fois plus lent.
  const fast = before.models.flash
  const measured = Object.fromEntries(overview.entries.map((e) => [e.model, e.model === fast ? 3 : 60]))
  const slow = await scan(measured, 24 * 1024).pickBestModelsFromBenchmark()
  assert.notEqual(slow.models.flash, fast, 'trop lent sur ce PC : il ne passe plus le plancher de Faible')
  assert.equal(slow.models.large, before.models.large, 'Élevé ne regarde pas la vitesse')
})

test('« Tous les modèles » dit d’où vient chaque vitesse', async () => {
  const overview = await scan({ 'ministral-3:3b': 60 }).getModelOverview()
  const byModel = new Map(overview.entries.map((e) => [e.model, e]))
  assert.equal(byModel.get('ministral-3:3b').localSpeedKind, 'measured')
  assert.equal(byModel.get('ministral-3:3b').localSpeed, 60)
  assert.equal(byModel.get('granite4.2:8b').localSpeedKind, null, 'jamais lancé ici : pas de vitesse (étape 498)')
  assert.equal(byModel.get('granite4.2:8b').localSpeed, null)
})

test('étape 414 : la liste des modèles du Duel dit la vitesse mesurée sur CE PC, jamais sur une autre machine', async () => {
  const exports = scan({ 'granite4.2:8b': 81 })
  const list = await exports.getDuelModelList('conversation', null)
  const granite = list.find((o) => o.model === 'granite4.2:8b')
  assert.equal(granite.speed, 81, 'la vitesse mesurée sur ce PC')
  assert.equal(granite.speedKind, 'measured')
  assert.ok(list.filter((o) => o.model !== 'granite4.2:8b').every((o) => o.speed === null && o.speedKind === null), 'les autres : pas encore mesurés (étape 498 : plus d’estimation)')
  const away = await exports.getDuelModelList('conversation', null, { vramGb: 288, ramGb: 188, ollamaVersion: '0.40.10' })
  assert.ok(away.every((o) => o.speed === null && o.speedKind === null), 'autre machine : la vitesse de ce PC ne dit rien')
})
