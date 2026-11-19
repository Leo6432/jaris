import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Reproduit la question de Léo ("pourquoi on regarde pas les vrais benchmarks pour départager les 6/6 ?") :
 * quand deux candidats du palier Puissant sont tous les deux à "6/6" (verified-tool-scores.md), l'ancien
 * comportement départageait par MMLU-Pro puis par VRAM. L'Intelligence Index d'Artificial Analysis est passé devant un
 * temps, puis a été retiré (étape 498), MMLU-Pro aussi (étape 499, Léo : « il faut qu'on garde seulement les éléments
 * visibles dans le tableau ») : seule la VRAM départage. Mêmes mocks no-op qu'ailleurs pour fs/child_process/systemResources.
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
    './dataLocation': { getDataRoot: () => '/fake/data' },
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
    require: withI18n((name) => modules[name] ?? nodeRequire(name))
  })
  return exports
}

test('à 6/6 égalité, plus aucune note publiée : le plus gros', async () => {
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:27b | 6/6 |', '| qwen3.8:27b | 6/6 |'].join(
      '\n'
    )
  })
  const result = await pickBestModelsFromBenchmark()
  // Étape 498 : l'Intelligence Index d'Artificial Analysis (qui donnait qwen3.8:27b) est retiré ; étape 499 : MMLU-Pro
  // (qui donnait qwen3.5:27b) aussi. Le plus gros chargé l'emporte : qwen3.8:27b (19,6 Go contre 19,3).
  assert.equal(result.models.large, 'qwen3.8:27b')
  assert.doesNotMatch(source, /MMLU_PRO/, 'plus de table MMLU-Pro')
})

test('à fiabilité ET force EXACTEMENT égales, en Code aussi : le plus gros', async () => {
  // granite4.2:3b et gpt-oss:20b, même 3/3 en code et aucun duel : seule la taille départage (étape 125).
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Code', '| Modèle | Fiabilité |', '| --- | --- |', '| granite4.2:3b | 3/3 |', '| gpt-oss:20b | 3/3 |'].join('\n')
  })
  const result = await pickBestModelsFromBenchmark()
  assert.equal(result.codeModel, 'gpt-oss:20b')
})

// Étape 498 (Léo : « supprime toutes les vitesses, tous les trucs d'Artificial Analysis, ça sert à rien ») : plus aucune
// note publiée par Artificial Analysis n'est gardée ni montrée — ni Intelligence Index, ni vitesse, ni Omniscience, ni
// Terminal-Bench. La vitesse affichée est celle mesurée sur le PC (aucune ici : `null`).
test('aucune note d’Artificial Analysis : ni dans le code, ni dans ce que l’écran reçoit', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  assert.ok(overview.entries.length > 30)
  for (const entry of overview.entries) {
    for (const key of ['artificialAnalysisIndex', 'artificialAnalysisSpeed', 'omniscience', 'terminalBench']) {
      assert.equal(key in entry, false, `${entry.model} : ${key}`)
    }
    assert.equal(entry.localSpeed, null, `${entry.model} : aucune vitesse sans mesure sur ce PC`)
  }
  assert.doesNotMatch(source, /ARTIFICIAL_ANALYSIS_/, 'tables d’Artificial Analysis retirées')
})

// Étape 136, Léo : "Rajoute les 2 model". Une autre IA avait retiré G9v3-3B et GLM-4.6V-Flash (et
// interdit tout import hf.co/ par un test) à cause d'un bug d'Ollama 0.34.2 sur les redirections Hugging Face.
// Le risque est désormais traité là où il se produit — runQuickSetup retombe sur le modèle suivant si le
// téléchargement échoue (test-benchmark-runner-cleanup.mjs) — donc les deux modèles restent candidats.
// Étape 462 (Léo : « retire-le ») : GLM-4.6V-Flash retiré pour une autre raison — il répète ses actions sans fin sous
// Ollama, et qwen3-vl:8b fait mieux en vision. G9v3-3B reste.
test('G9v3-3B reste dans la liste des modèles malgré le bug Ollama 0.34.2 ; GLM-4.6V-Flash retiré (étape 462)', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const entry = (model) => overview.entries.find((e) => e.model === model)
  assert.ok(entry('hf.co/bartowski/ai9stars_G9v3-3B-GGUF'), 'G9v3-3B doit rester candidat')
  assert.equal(entry('hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M'), undefined, 'GLM-4.6V-Flash retiré')
})

test('indique tous les paliers qui utilisent réellement chaque modèle du profil actif', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview({
    name: 'Léo',
    models: { flash: 'qwen3.5:0.8b', medium: 'qwen3.5:4b', large: 'qwen3.8:27b' },
    visionModel: 'qwen3.5:4b',
    codeModel: 'qwen2.5-coder:7b'
  })
  // Étape 160 : une seule liste, donc une seule ligne par modèle, qui porte tous ses rôles à la fois.
  const qwen4bEntries = overview.entries.filter((entry) => entry.model === 'qwen3.5:4b')
  assert.equal(qwen4bEntries.length, 1, 'chaque modèle apparaît une seule fois dans la liste unique')
  assert.deepEqual(Array.from(qwen4bEntries[0].usedIn), ['Moyen', 'Vision'])

  const unused = overview.entries.find((entry) => entry.model === 'qwen3.5:2b')
  assert.deepEqual(Array.from(unused.usedIn), [])
})

/**
 * Étape 127 : granite4.2:3b et qwen3.8:27b, proposés par ChatGPT puis vérifiés, restent au catalogue — et
 * qwen3.8:27b est bien reconnu comme lisant les images (support vérifié sur sa fiche Ollama).
 */
test('granite4.2:3b et qwen3.8:27b restent au catalogue, qwen3.8:27b reconnu comme lisant les images', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  assert.ok(overview.entries.some((e) => e.model === 'granite4.2:3b'))
  assert.equal(overview.entries.find((e) => e.model === 'qwen3.8:27b')?.readsImages, true)
})
