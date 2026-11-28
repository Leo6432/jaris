import assert from 'node:assert/strict'
import { SCORES_WITHOUT_REMEASURE } from './verified-scores-for-tests.mjs'
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

test('étape 514 : la vitesse d’une réponse du test (eval_count / eval_duration en nanosecondes) ; trop courte = rien', () => {
  assert.equal(speed.speedOfAnswer(10, 1e9), null)
  assert.equal(speed.speedOfAnswer(100, 0), null)
  assert.equal(speed.speedOfAnswer(undefined, 1e9), null)
  assert.equal(speed.speedOfAnswer(100, 2e9), 50)
})

test('étape 514 : les mêmes questions et réglages pour tous — pas de hasard, pas de réflexion cachée', () => {
  assert.equal(speed.SPEED_TEST_PROMPTS.length, 3)
  assert.deepEqual({ ...speed.SPEED_TEST_OPTIONS }, { temperature: 0, seed: 42, num_predict: 256, num_ctx: 16384 })
})

test('étape 514 : seul le fichier du test (version actuelle) est relu — jamais les anciennes mesures d’usage', () => {
  const ok = { version: speed.SPEED_TEST_VERSION, results: { 'm:latest': { speed: 40, testedAt: 't' }, bad: { speed: -1, testedAt: 't' }, nodate: { speed: 3 } } }
  assert.deepEqual(speed.parseSpeedTestFile(ok), { m: { speed: 40, testedAt: 't' } }, '« :latest » = sans tag ; valeurs invalides ignorées')
  assert.equal(speed.parseSpeedTestFile({ m: [40, 41] }), null, 'ancien format (étape 367) : ignoré')
  assert.equal(speed.parseSpeedTestFile({ version: 999, results: {} }), null, 'autre version des questions : pas comparable')
  assert.equal(speed.parseSpeedTestFile([1, 2]), null)
  assert.deepEqual(speed.speedsOf({ a: { speed: 12, testedAt: 't' } }), { a: 12 })
})

test('vitesse retenue : mesurée sur ce PC, sinon inconnue — jamais une vitesse venue d’ailleurs (étape 498)', () => {
  assert.deepEqual(speed.resolveSpeed('a', { a: 50 }), { speed: 50, kind: 'measured' })
  assert.deepEqual(speed.resolveSpeed('a:latest', { a: 50 }), { speed: 50, kind: 'measured' }, '« :latest » = sans tag')
  assert.deepEqual(speed.resolveSpeed('b', { a: 50 }), { speed: null, kind: null }, 'jamais lancé ici : inconnue, pas estimée')
  assert.deepEqual(speed.resolveSpeed('b', {}), { speed: null, kind: null })
  assert.equal(speed.localToPublishedRatio, undefined, 'plus de rapport avec une vitesse publiée')
})

test('étape 514 : le magasin garde les vitesses du test ; l’ancien fichier de mesures d’usage est effacé au démarrage', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jaris-speed-'))
  const file = path.join(root, 'model-speeds.json')
  fs.writeFileSync(file, JSON.stringify({ 'lfm3:1.7b': [182.2, 190] }))
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
  assert.deepEqual(store.getMeasuredSpeeds(), {}, 'anciennes mesures (questions différentes) : jamais relues')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: speed.SPEED_TEST_VERSION, results: {} }, 'et effacées')
  await store.saveSpeedResult('qwen3.5:4b', 61.5, '2026-11-23T10:00:00.000Z')
  assert.deepEqual(store.getMeasuredSpeeds(), { 'qwen3.5:4b': 61.5 })
  const after = load()
  await after.loadModelSpeeds()
  assert.deepEqual(after.getSpeedResults(), { 'qwen3.5:4b': { speed: 61.5, testedAt: '2026-11-23T10:00:00.000Z' } })
})

test('étape 514 : plus aucune vitesse enregistrée pendant l’usage (des questions différentes pour chaque modèle)', () => {
  const ollama = readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(ollama, /speedRecorder|setSpeedRecorder/)
  assert.doesNotMatch(main, /setSpeedRecorder|recordModelSpeed/)
})

// Choix des modèles, sur les VRAIS scores du dépôt et la machine de Léo (8 Go, 32 Go).
const nodeRequire = createRequire(import.meta.url)
const scanSource = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
// Étape 531 : sans les 54 modèles « à remesurer » (voir verified-scores-for-tests.mjs).
const REAL_SCORES = SCORES_WITHOUT_REMEASURE

function scan(measured, vramMib = 8192, published) {
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
  if (measured) exports.setLocalSpeedResolver((model) => speed.resolveSpeed(model, measured, published))
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

// Étape 517 (Léo : « personne ne va faire de test : quand il installe, il voit tous les scores, de vitesse, de tout ») :
// les vitesses mesurées par Léo (RTX 3070, 8 Go) sont publiées pour tout le monde.
const PUBLISHED = loadTsModule('shared/publishedSpeeds.ts')

test('étape 517 : sans test sur ce PC, la vitesse publiée ; un test ici passe toujours avant', () => {
  const published = { speeds: { a: 150 }, vramGb: 8 }
  assert.deepEqual(speed.resolveSpeed('a', {}, published), { speed: 150, kind: 'published', referenceVramGb: 8 })
  assert.deepEqual(speed.resolveSpeed('a', { a: 90 }, published), { speed: 90, kind: 'measured' })
  assert.deepEqual(speed.resolveSpeed('b', {}, published), { speed: null, kind: null })
  assert.equal(PUBLISHED.PUBLISHED_SPEED_REFERENCE.vramGb, 8)
  assert.equal(PUBLISHED.PUBLISHED_SPEEDS['lfm3:1.7b'], 150)
})

test('étape 517 : une vitesse publiée d’un modèle qui DÉBORDAIT de la carte de mesure ne fait pas perdre Moyen sur 24 Go', async () => {
  const published = { speeds: PUBLISHED.PUBLISHED_SPEEDS, vramGb: PUBLISHED.PUBLISHED_SPEED_REFERENCE.vramGb }
  const overview = await scan(null, 24 * 1024).getModelOverview()
  const need = new Map(overview.entries.map((e) => [e.model, e.vramGb]))
  // Les mêmes vitesses publiées, sans celles des modèles trop gros pour 8 Go (mesurées en débordant sur la RAM).
  const fitting = { speeds: Object.fromEntries(Object.entries(published.speeds).filter(([m]) => (need.get(m) ?? 99) <= 8)), vramGb: 8 }
  const withAll = await scan({}, 24 * 1024, published).pickBestModelsFromBenchmark()
  const withFitting = await scan({}, 24 * 1024, fitting).pickBestModelsFromBenchmark()
  assert.equal(JSON.stringify(withAll.models), JSON.stringify(withFitting.models), '3 tokens/s d’un 27B sur une carte de 8 Go ne dit rien d’une carte de 24 Go')
  // Mais la colonne de l’écran les montre toutes.
  const shown = new Map((await scan({}, 24 * 1024, published).getModelOverview()).entries.map((e) => [e.model, e]))
  assert.equal(shown.get('qwen3.5:27b').localSpeed, 3.3)
  assert.equal(shown.get('qwen3.5:27b').localSpeedKind, 'published')
})

test('étape 517 : sur une carte comme celle de la mesure, les vitesses publiées choisissent comme des vitesses mesurées ici', async () => {
  const published = { speeds: PUBLISHED.PUBLISHED_SPEEDS, vramGb: 8 }
  const viaPublished = await scan({}, 8192, published).pickBestModelsFromBenchmark()
  const viaMeasured = await scan({ ...PUBLISHED.PUBLISHED_SPEEDS }, 8192).pickBestModelsFromBenchmark()
  assert.equal(viaPublished.models.flash, viaMeasured.models.flash)
  assert.equal(viaPublished.models.medium, viaMeasured.models.medium)
})

// Étape 520 (audit) : sur un PC plus lent que la carte de mesure, tester UN modèle le comparait aux vitesses de l'autre
// carte : il perdait Faible au profit d'un modèle en réalité plus lent encore. Les vitesses publiées sont remises à
// l'échelle de CE PC (pcSpeedFactor) dès qu'un modèle y a été testé.
test('étape 520 : tester un seul modèle sur un PC 2,5× plus lent ne lui fait pas perdre Faible', async () => {
  const published = { speeds: PUBLISHED.PUBLISHED_SPEEDS, vramGb: 8 }
  const base = await scan({}, 8192, published).pickBestModelsFromBenchmark()
  const flash = base.models.flash
  const ratio = 0.4
  const one = await scan({ [flash]: published.speeds[flash] * ratio }, 8192, published).pickBestModelsFromBenchmark()
  const all = await scan(Object.fromEntries(Object.entries(published.speeds).map(([m, v]) => [m, v * ratio])), 8192, published).pickBestModelsFromBenchmark()
  assert.equal(all.models.flash, flash, 'tout mesuré au même rapport : Faible ne change pas')
  assert.equal(one.models.flash, flash, 'un seul mesuré : même choix que tout mesuré')
  assert.equal(speed.pcSpeedFactor({ [flash]: published.speeds[flash] * ratio }, published).toFixed(3), ratio.toFixed(3))
  assert.equal(speed.pcSpeedFactor({ inconnu: 50 }, published), null, 'aucun modèle en commun : pas de rapport')
  // L'écran montre toujours la vitesse publiée telle quelle (avec la carte de mesure) : seul le choix la remet à l'échelle.
  const other = Object.keys(published.speeds).find((m) => m !== flash)
  const resolved = speed.resolveSpeed(other, { [flash]: published.speeds[flash] * ratio }, published)
  assert.equal(resolved.speed, published.speeds[other])
  assert.equal(resolved.kind, 'published')
  assert.equal(resolved.pcFactor.toFixed(3), ratio.toFixed(3))
})
