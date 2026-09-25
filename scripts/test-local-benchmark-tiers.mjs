import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Reproduit le bug repéré directement sur une capture d'écran de Léo (page "Tous les modèles", après avoir
 * utilisé le bouton "Lancer l'analyse" restauré à l'étape 131) : ministral-3:8b (candidat à la fois Médium/
 * conversation ET Vision, voir MEDIUM_CANDIDATES/VISION_CANDIDATES dans hardwareScan.ts) affichait le MÊME
 * score "2/3" dans les deux paliers — son vrai score de conversation (sur 6, testé dans le même run) avait
 * été silencieusement écrasé par son score vision (sur 3, testé juste après dans le même script).
 *
 * `parseLocalBenchmark()` renvoyait jusqu'ici une seule Map plate par nom de modèle (contrairement à
 * `parseVerifiedToolScores()`, déjà corrigée pour exactement ce problème — voir son commentaire, "bug déjà
 * rencontré une fois... qui applique la même correction côté app", une correction qui n'avait en réalité
 * jamais été étendue à ce fichier jumeau). Corrigé en trois maps séparées par palier (conversation/vision/
 * code), exactement comme parseVerifiedToolScores. Mêmes mocks no-op qu'ailleurs pour fs/child_process/
 * systemResources (pas de vraie machine dans ce test) : seul `fs.readFileSync` pour "benchmark-results.md"
 * est simulé avec un contenu réel, section par section.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Contenu réel plausible d'un benchmark-results.md généré par le NOUVEAU persistResults() (scripts/
// benchmark-models.mjs) : ministral-3:8b testé pour de vrai sous DEUX rôles dans le même run.
const BENCHMARK_RESULTS_MD = [
  '# Résultats du benchmark Jaris — test',
  '',
  'Version du test de conversation : 3',
  '',
  '## Conversation',
  '',
  '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
  '|---|---|---|---|',
  '| ministral-3:8b | 600 ms | 40.0 tok/s | 5/6 |',
  '',
  '## Vision',
  '',
  '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
  '|---|---|---|---|',
  '| ministral-3:8b | 800 ms | 30.0 tok/s | 2/3 |',
  '',
  '## Code',
  '',
  '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
  '|---|---|---|---|'
].join('\n')

function setup({ benchmarkResultsMd = '', vramMib = 30 * 1024, ramGb = 32 } = {}) {
  // Voir le même commentaire dans test-hardwarescan-tiebreak.mjs : execAsync = promisify(exec) a besoin de la
  // marque [util.promisify.custom] pour résoudre vers {stdout, stderr} plutôt qu'un tableau positionnel.
  const exec = (_cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    callback(null, `Fake GPU, ${vramMib}\n`, '')
  }
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })

  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('benchmark-results.md')) {
          if (!benchmarkResultsMd) {
            const err = new Error('ENOENT')
            err.code = 'ENOENT'
            throw err
          }
          return benchmarkResultsMd
        }
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => ramGb },
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

test('parseLocalBenchmark sépare bien conversation/vision/code, pas une seule map par nom de modèle', () => {
  const { parseLocalBenchmark } = setup({ benchmarkResultsMd: BENCHMARK_RESULTS_MD })
  const local = parseLocalBenchmark()
  assert.equal(local.conversation.get('ministral-3:8b')?.toolCalling, '5/6', 'score de conversation attendu (5/6)')
  assert.equal(local.vision.get('ministral-3:8b')?.toolCalling, '2/3', 'score de vision attendu (2/3)')
  assert.equal(local.code.has('ministral-3:8b'), false, "ministral-3:8b n'a jamais été testé en Code")
})

test('"Tous les modèles" affiche le VRAI score de conversation de ministral-3:8b, pas son score vision qui aurait dû l\'écraser', async () => {
  const { getModelOverview } = setup({ benchmarkResultsMd: BENCHMARK_RESULTS_MD })
  const overview = await getModelOverview()
  // Étape 160 : une seule ligne par modèle. Elle affiche le score de CONVERSATION (le cas général) ; le score
  // vision (2/3) reste lu à part et ne doit jamais le remplacer.
  const entries = overview.entries.filter((e) => e.model === 'ministral-3:8b')
  assert.equal(entries.length, 1, 'ministral-3:8b doit apparaître une seule fois')
  assert.equal(entries[0].toolCalling, '5/6', `score de conversation corrompu : ${entries[0].toolCalling}`)
  assert.equal(entries[0].readsImages, true)
})

test('un benchmark-results.md de l\'ANCIEN format (sans sections) se lit comme "rien de connu", jamais un score corrompu', () => {
  const oldFlatFormat = [
    '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
    '|---|---|---|---|',
    '| ministral-3:8b | 800 ms | 30.0 tok/s | 2/3 |'
  ].join('\n')
  const { parseLocalBenchmark } = setup({ benchmarkResultsMd: oldFlatFormat })
  const local = parseLocalBenchmark()
  assert.equal(local.conversation.has('ministral-3:8b'), false, "l'ancien format ne doit jamais être mal réparti dans une section")
  assert.equal(local.vision.has('ministral-3:8b'), false, "l'ancien format ne doit jamais être mal réparti dans une section")
})

test('le format transitoire v0.15.29 à cinq colonnes conserve les scores utiles sans qualité locale', () => {
  // Ligne de version ajoutée à l'étape 163 : sans elle, les scores de conversation sont ignorés (voir le test
  // suivant) — ce test ne vérifie que la lecture du format à cinq colonnes.
  const transitional = [
    'Version du test de conversation : 3',
    '## Conversation',
    '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité | Qualité locale |',
    '|---|---|---|---|---|',
    '| qwen3.5:4b | 500 ms | 50 tok/s | 6/6 | 4/6 |',
    '',
    '## Vision',
    '',
    '## Code'
  ].join('\n')
  const { parseLocalBenchmark } = setup({ benchmarkResultsMd: transitional })
  const local = parseLocalBenchmark()
  assert.equal(local.conversation.get('qwen3.5:4b')?.toolCalling, '6/6')
  assert.deepEqual(
    Object.keys(local.conversation.get('qwen3.5:4b')).sort(),
    ['speedTokPerSec', 'toolCalling'].sort()
  )
})

/**
 * Étape 163 : la première analyse de Léo (sans fenêtre de contexte imposée) a donné des scores de conversation
 * FAUX (consignes coupées : qwen à 5/17, granite4.2 à 0/17). Sans la version du test en tête du fichier, Jaris
 * ignore ces scores de conversation (les scores vérifiés s'appliquent) — mais garde ceux de vision et de code,
 * qui avaient déjà la bonne fenêtre.
 */
test('des scores de conversation sans version du test (première analyse, consignes coupées) sont ignorés', () => {
  const firstRun = BENCHMARK_RESULTS_MD.replace('Version du test de conversation : 3', '')
  const { parseLocalBenchmark } = setup({ benchmarkResultsMd: firstRun })
  const local = parseLocalBenchmark()
  assert.equal(local.conversation.size, 0, 'scores de conversation d’une version inconnue : ignorés')
  assert.equal(local.vision.get('ministral-3:8b')?.toolCalling, '2/3', 'les scores de vision restent valables')
})
