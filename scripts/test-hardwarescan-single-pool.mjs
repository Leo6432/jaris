import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Étape 160, Léo : « que tous les modèles soient au même endroit, pas des modèles code, pas des modèles
 * rapide : Jaris choisit le plus rapide dans tous les modèles, le meilleur pour le code — ça peut être des
 * modèles puissants ». Déclencheur : le modèle Code (qwen3.6:35b-a3b, Intelligence 18) était moins fort que le
 * Puissant (qwen3.8:27b, 34), parce que chaque rôle ne cherchait que dans sa propre liste.
 *
 * Tests sur les VRAIS scores du dépôt (scripts/verified-tool-scores.md), pas sur des scores inventés : ce qui
 * est vérifié ici, c'est ce que Jaris choisira réellement pour une machine donnée.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function setup({ vramMib, ramGb = 32, scores = REAL_SCORES } = {}) {
  // Marque [util.promisify.custom] indispensable (voir test-hardwarescan-tiebreak.mjs) : sans elle, detectGpu()
  // ignorerait silencieusement la VRAM simulée.
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return scores
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, module: { exports }, require: (name) => modules[name] ?? nodeRequire(name) })
  return exports
}

async function picksFor(vramGb, ramGb) {
  const r = await setup({ vramMib: vramGb * 1024, ramGb }).pickBestModelsFromBenchmark()
  return { ...r.models, vision: r.visionModel, code: r.codeModel }
}

test('machine de Léo (8 Go de VRAM) : Code prend le plus intelligent de TOUS les modèles, comme Puissant', async () => {
  const picks = await picksFor(8, 32)
  assert.equal(picks.large, 'qwen3.8:27b')
  // Avant l'étape 160 : qwen3.6:35b-a3b (Intelligence 18), le seul choix possible dans la liste « code ».
  assert.equal(picks.code, 'qwen3.8:27b', `Code attendu : le plus intelligent de tous (qwen3.8:27b, 34), obtenu ${picks.code}`)
})

test('Rapide : le plus rapide (vitesse publiée) de TOUS les modèles fiables qui tiennent sur la carte', async () => {
  const picks = await picksFor(8, 32)
  // ministral-3:3b : 221 tokens/s publiés, le plus rapide des modèles à 6/6 qui tiennent sur 7 Go.
  assert.equal(picks.flash, 'ministral-3:3b')
})

test('Rapide et Médium ne débordent JAMAIS sur la RAM, même avec beaucoup de RAM', async () => {
  const scan = setup({ vramMib: 8 * 1024, ramGb: 128 })
  const r = await scan.pickBestModelsFromBenchmark()
  const overview = await scan.getModelOverview()
  const vramOf = (m) => overview.entries.find((e) => e.model === m).vramGb
  assert.ok(vramOf(r.models.flash) <= 7, `Rapide ${r.models.flash} ne tient pas sur la carte`)
  assert.ok(vramOf(r.models.medium) <= 7, `Médium ${r.models.medium} ne tient pas sur la carte`)
  assert.equal(r.models.medium, 'qwen3.5:9b', 'Médium = le plus intelligent qui tient ENTIÈREMENT sur la carte')
})

test('Médium peut être un « gros » modèle quand la carte le permet (plus de liste réservée)', async () => {
  const picks = await picksFor(24, 64)
  assert.equal(picks.medium, 'qwen3.8:27b', `24 Go : le plus intelligent qui tient sur la carte, obtenu ${picks.medium}`)
})

test('Vision ne choisit QUE parmi les modèles qui lisent une image', async () => {
  const scan = setup({ vramMib: 24 * 1024, ramGb: 64 })
  const r = await scan.pickBestModelsFromBenchmark()
  const overview = await scan.getModelOverview()
  assert.equal(overview.entries.find((e) => e.model === r.visionModel)?.readsImages, true, `${r.visionModel} ne lit pas les images`)
})

test('un 3/3 au test de code vaut un 6/6 au test de conversation (comparés en proportion, pas en nombre brut)', async () => {
  // qwen3.6:35b-a3b a 3/3 au test de code ; en nombre brut, n'importe quel 6/6 l'aurait battu. Seul
  // qwen3.6:35b-a3b est donné ici avec un Intelligence Index plus haut qu'un modèle de conversation à 6/6 :
  // à fiabilité égale (100 % des deux côtés), l'intelligence doit trancher.
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.5:27b | 6/6 |', '## Code', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.6:35b-a3b | 3/3 |'].join('\n')
  const r = await setup({ vramMib: 24 * 1024, ramGb: 64, scores }).pickBestModelsFromBenchmark()
  // qwen3.5:27b : Intelligence 23 ; qwen3.6:35b-a3b : 18. Même fiabilité (100 %) → le plus intelligent.
  assert.equal(r.codeModel, 'qwen3.5:27b')
  const onlyCode = ['## Code', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.6:35b-a3b | 3/3 |', '| qwen2.5-coder:7b | 2/3 |'].join('\n')
  const r2 = await setup({ vramMib: 24 * 1024, ramGb: 64, scores: onlyCode }).pickBestModelsFromBenchmark()
  assert.equal(r2.codeModel, 'qwen3.6:35b-a3b', 'un 3/3 doit battre un 2/3')
})

test('repli en direct : le modèle choisi est gardé tant qu\'il tient dans la VRAM libre', () => {
  const { pickSafeModel } = setup({ vramMib: 8 * 1024 })
  const installed = ['ministral-3:3b', 'qwen3.5:9b', 'qwen3.5:4b']
  // Rapide (3 Go) tient dans 7 Go libres : jamais remplacé par un plus gros modèle installé (plus lent).
  assert.equal(pickSafeModel(7, installed, 'ministral-3:3b'), 'ministral-3:3b')
  // Médium (6,6 Go) ne tient plus dans 5 Go libres : le plus gros modèle de conversation installé qui tient.
  assert.equal(pickSafeModel(5, installed, 'qwen3.5:9b'), 'qwen3.5:4b')
})

test('« Tous les modèles » : chaque modèle une seule fois, avec son étiquette affichée', async () => {
  const overview = await setup({ vramMib: 8 * 1024 }).getModelOverview()
  const models = overview.entries.map((e) => e.model)
  assert.equal(new Set(models).size, models.length)
  assert.ok(overview.entries.every((e) => ['Rapide', 'Moyen', 'Puissant'].includes(e.category)))
  assert.equal(overview.groups, undefined, 'plus de groupes par palier')
})
