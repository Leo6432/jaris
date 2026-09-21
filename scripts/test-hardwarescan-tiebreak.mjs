import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Reproduit la question de Léo ("pourquoi on regarde pas les vrais benchmarks pour départager les 6/6 ?") :
 * quand deux candidats du palier Puissant sont tous les deux à "6/6" (verified-tool-scores.md), l'ancien
 * comportement départageait par MMLU-Pro puis par VRAM. Vérifie que pickBestFrom utilise maintenant
 * l'Intelligence Index officiel quand les deux modèles exacts sont couverts, puis seulement MMLU-Pro et la
 * VRAM comme replis. Mêmes mocks no-op qu'ailleurs pour fs/child_process/systemResources.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup({ verifiedToolScoresMd = '', vramMib = 30 * 1024, ramGb = 32, externalOverrides = {} } = {}) {
  // hardwareScan.ts appelle exec() via util.promisify (execAsync = promisify(exec)), qui résout normalement
  // vers {stdout, stderr} grâce à la marque [util.promisify.custom] posée par le VRAI child_process.exec de
  // Node — un mock sans cette marque fait résoudre promisify vers un tableau [stdout, stderr] à la place,
  // donc `const { stdout } = await execAsync(...)` recevrait `undefined` et detectGpu() retomberait
  // silencieusement sur {name: null, vramGb: null} (rattrapé par son propre try/catch) sans jamais lire la
  // VRAM simulée ci-dessous. Reposer la même marque ici reproduit fidèlement ce que Node fait pour de vrai.
  const exec = (_cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    callback(null, `Fake GPU, ${vramMib}\n`, '')
  }
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })

  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return verifiedToolScoresMd
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => ramGb },
    // Curseur de longueur de contexte : hardwareScan.ts importe désormais ces deux fonctions d'ollama.ts,
    // jamais appelées par les tests de ce fichier (aucune assertion ici ne porte dessus) — sans ce stub,
    // le require shim ne trouve pas './ollama' et fait échouer tout le module à charger.
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null },
    './externalScoresStore': { getExternalScoreOverrides: async () => externalOverrides }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name)
  })
  return exports
}

test('à 6/6 égalité, départage d’abord par l’Intelligence Index officiel', async () => {
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:27b | 6/6 |', '| qwen3.8:27b | 6/6 |'].join(
      '\n'
    )
  })
  const result = await pickBestModelsFromBenchmark()
  // Artificial Analysis note qwen3.8:27b à 34 contre 23 pour qwen3.5:27b. Ce signal demandé par Léo passe
  // maintenant avant leurs anciens chiffres MMLU-Pro, qui donnaient l'ordre inverse.
  assert.equal(result.models.large, 'qwen3.8:27b')
})

test('à 6/6 égalité SANS MMLU-Pro connu pour les deux, repli sur la VRAM la plus grosse (comportement inchangé)', async () => {
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.6:35b | 6/6 |', '| qwen3.6:27b | 6/6 |'].join(
      '\n'
    )
  })
  const result = await pickBestModelsFromBenchmark()
  // Ni qwen3.6:35b ni qwen3.6:27b n'ont d'entrée dans INTELLIGENCE_MMLU_PRO à ce jour : le départage doit
  // rester purement par VRAM (35b, 24 Go, plus gros que 27b, 18 Go) — comportement d'avant ce correctif.
  assert.equal(result.models.large, 'qwen3.6:35b')
})

test('expose les 15 Intelligence Index lus directement chez Artificial Analysis sans en inventer', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const byModel = new Map(overview.groups.flatMap((group) => group.entries.map((entry) => [entry.model, entry.artificialAnalysisIndex])))
  const expected = {
    'qwen3.5:0.8b': 6,
    'qwen3.5:2b': 7,
    'qwen3.5:4b': 13,
    'qwen3.5:9b': 14,
    'qwen3.5:27b': 23,
    'qwen3.6:27b': 21,
    'qwen3.6:35b-a3b': 18,
    'qwen3.8:27b': 34,
    'gpt-oss:20b': 9,
    'gemma4:e4b': 9,
    'gemma4:12b': 14,
    'gemma4:26b': 17,
    'gemma4:31b': 19,
    'ministral-3:3b': 5,
    'ministral-3:14b': 6
  }

  for (const [model, score] of Object.entries(expected)) assert.equal(byModel.get(model), score, model)
  assert.equal(byModel.get('qwen3.5:35b'), null, 'un modèle exact absent d’Artificial Analysis doit rester sans score')
})

test('indique tous les paliers qui utilisent réellement chaque modèle du profil actif', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview({
    name: 'Léo',
    models: { flash: 'qwen3.5:0.8b', medium: 'qwen3.5:4b', large: 'qwen3.8:27b' },
    visionModel: 'qwen3.5:4b',
    codeModel: 'qwen2.5-coder:7b'
  })
  const qwen4bEntries = overview.groups.flatMap((group) => group.entries).filter((entry) => entry.model === 'qwen3.5:4b')
  assert.ok(qwen4bEntries.length >= 2, 'le modèle partagé doit apparaître dans plusieurs groupes candidats')
  for (const entry of qwen4bEntries) assert.deepEqual(Array.from(entry.usedIn), ['Médium', 'Vision'])

  const unused = overview.groups.flatMap((group) => group.entries).find((entry) => entry.model === 'qwen3.5:2b')
  assert.deepEqual(Array.from(unused.usedIn), [])
})

/**
 * Léo : "je ne sais pas pourquoi tu a pas mis ces scores mais sur le site il ya des models que tu a mis non
 * publier, mais au pire je le fait manuelement, fait moi un petit system pour que je note moi meme le score" —
 * une correction manuelle (externalScoresStore.ts) doit primer sur ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX
 * (hardwareScan.ts), pour CE modèle seulement, aussi bien dans l'AFFICHAGE que dans le vrai départage utilisé
 * pour choisir un modèle (pickBestFrom) — pas juste dans le tableau "Tous les modèles".
 */
test('une correction manuelle remplace l’Intelligence Index figé, dans l’affichage ET dans le départage réel', async () => {
  // qwen3.5:27b a 23 dans la table figée (voir le test ci-dessus) ; qwen3.8:27b a 34, donc gagne déjà "à
  // égalité 6/6" sans override. On corrige ICI qwen3.5:27b à 99 (Léo a vu un chiffre différent sur le site) :
  // le départage doit désormais s'inverser, la table figée ne devant plus jamais l'emporter pour ce modèle.
  const { getModelOverview, pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:27b | 6/6 |', '| qwen3.8:27b | 6/6 |'].join(
      '\n'
    ),
    externalOverrides: { 'qwen3.5:27b': { intelligence: 99 } }
  })

  const overview = await getModelOverview()
  const entry = overview.groups.flatMap((g) => g.entries).find((e) => e.model === 'qwen3.5:27b')
  assert.equal(entry.artificialAnalysisIndex, 99, 'la correction manuelle doit remplacer la table figée (23) dans l’affichage')

  const result = await pickBestModelsFromBenchmark()
  assert.equal(result.models.large, 'qwen3.5:27b', 'le départage réel doit aussi suivre la correction manuelle, pas la table figée')
})

test('une correction manuelle de vitesse n’efface pas une correction d’intelligence déjà là, et réciproquement', async () => {
  // externalScoresStore.ts fusionne les deux champs indépendamment (voir setExternalScoreOverride) : ce test
  // vérifie seulement que hardwareScan.ts LIT bien les deux depuis un même override, sans qu'aucun des deux
  // ne masque l'autre côté lecture — l'indépendance de l'ÉCRITURE elle-même est testée dans
  // test-external-scores.mjs (externalScoresStore.ts chargé directement, pas via hardwareScan.ts).
  const { getModelOverview } = setup({
    externalOverrides: { 'ministral-3:3b': { intelligence: 42, speed: 77 } }
  })
  const overview = await getModelOverview()
  const entry = overview.groups.flatMap((g) => g.entries).find((e) => e.model === 'ministral-3:3b')
  assert.equal(entry.artificialAnalysisIndex, 42)
  assert.equal(entry.artificialAnalysisSpeed, 77)
})

test('artificialAnalysisSpeed reste null sans correction manuelle : aucune table figée pour ce champ', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const entry = overview.groups.flatMap((g) => g.entries).find((e) => e.model === 'ministral-3:3b')
  assert.equal(entry.artificialAnalysisSpeed, null, 'aucune vitesse ne doit jamais être devinée')
})
