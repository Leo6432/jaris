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

function setup({ verifiedToolScoresMd = '', vramMib = 30 * 1024, ramGb = 32 } = {}) {
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
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null }
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

test('à 6/6 ET Intelligence Index EXACTEMENT égaux, repli sur MMLU-Pro puis la VRAM la plus grosse', async () => {
  // Étape 122 a fait passer la couverture Artificial Analysis de 15 à 34/39 candidats — il n'existe donc
  // plus de paire de candidats du palier Puissant SANS AUCUN score connu des deux côtés (l'ancien scénario
  // de ce test). mistral-small3.2:24b (7) et qwen3.5:2b (7) partagent maintenant le MÊME Intelligence Index
  // : ce cas-là (égalité stricte, pas absence) tombe toujours sur le repli suivant — qwen3.5:2b a un chiffre
  // MMLU-Pro connu (55.3) mais pas mistral-small3.2:24b, donc ce repli aussi ne s'applique pas aux DEUX à la
  // fois : le départage final reste purement par VRAM (mistral-small3.2:24b, 15 Go, bien plus gros).
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: [
      '## Conversation',
      '| Modèle | Fiabilité |',
      '| --- | --- |',
      '| mistral-small3.2:24b | 6/6 |',
      '| qwen3.5:2b | 6/6 |'
    ].join('\n')
  })
  const result = await pickBestModelsFromBenchmark()
  assert.equal(result.models.large, 'mistral-small3.2:24b')
})

test('expose les Intelligence Index lus directement chez Artificial Analysis sans en inventer (étape 125 : 36/39 modèles couverts)', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const byModel = new Map(overview.groups.flatMap((group) => group.entries.map((entry) => [entry.model, entry.artificialAnalysisIndex])))
  const expected = {
    'qwen3.5:0.8b': 6,
    'qwen3.5:2b': 7,
    'qwen3.5:4b': 13,
    'qwen3.5:9b': 14,
    'qwen3.5:27b': 23,
    'qwen3.5:35b': 19,
    'qwen3.6:27b': 21,
    'qwen3.6:35b': 18,
    'qwen3.6:35b-a3b': 18,
    'qwen3.8:27b': 34,
    'gpt-oss:20b': 9,
    'gemma4:e4b': 9,
    'gemma4:12b': 14,
    'gemma4:26b': 17,
    'gemma4:31b': 19,
    'ministral-3:3b': 5,
    'ministral-3:14b': 6,
    'granite4.1:3b': 6,
    'granite4.2:3b': 9,
    'ministral-3:8b': 5,
    'granite4.2:8b': 11,
    'granite4.1:8b': 7,
    'mistral-small3.2:24b': 7,
    'granite4.2:30b': 15,
    'command-r:35b': 5,
    'qwen3:1.7b': 5,
    'glm-4.7-flash:q4_K_M': 15,
    'qwen3-vl:8b': 7,
    'qwen3-vl:4b': 6,
    'devstral-2:123b': 9,
    'qwen3-coder-next': 9,
    'qwen3-coder:30b': 10,
    'north-mini-code-1.0': 10,
    'qwen2.5-coder:32b': 2,
    'devstral-small-2:24b': 8,
    'qwen2.5-coder:7b': 4
  }

  for (const [model, score] of Object.entries(expected)) assert.equal(byModel.get(model), score, model)
  // Modèle réellement absent d'Artificial Analysis (vérifié : aucune fiche à ce nom) — jamais de chiffre
  // inventé pour combler le vide.
  assert.equal(byModel.get('qwen2.5-coder:14b'), null, 'un modèle exact absent d’Artificial Analysis doit rester sans score')
})

test('expose aussi la vitesse (tokens/s) publiée par Artificial Analysis, absente quand non mesurée', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const byModel = new Map(overview.groups.flatMap((group) => group.entries.map((entry) => [entry.model, entry.artificialAnalysisSpeed])))
  assert.equal(byModel.get('ministral-3:3b'), 215)
  assert.equal(byModel.get('granite4.2:3b'), 220)
  assert.equal(byModel.get('devstral-2:123b'), 133)
  // qwen3.5:0.8b a un Intelligence Index connu (6) mais Artificial Analysis affiche "N/A" pour sa vitesse.
  assert.equal(byModel.get('qwen3.5:0.8b'), null, 'aucune vitesse ne doit être devinée quand Artificial Analysis ne la publie pas')
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

