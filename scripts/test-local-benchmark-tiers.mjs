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
  const medium = overview.groups.find((g) => g.tier === 'Médium')
  const vision = overview.groups.find((g) => g.tier === 'Vision')
  const mediumEntry = medium.entries.find((e) => e.model === 'ministral-3:8b')
  const visionEntry = vision.entries.find((e) => e.model === 'ministral-3:8b')
  assert.ok(mediumEntry, 'ministral-3:8b introuvable dans le palier Médium')
  assert.ok(visionEntry, 'ministral-3:8b introuvable dans le palier Vision')
  assert.equal(mediumEntry.toolCalling, '5/6', `score Médium (conversation) corrompu : ${mediumEntry.toolCalling}`)
  assert.equal(visionEntry.toolCalling, '2/3', `score Vision corrompu : ${visionEntry.toolCalling}`)
  assert.notEqual(mediumEntry.toolCalling, visionEntry.toolCalling, 'les deux scores ne doivent JAMAIS être identiques par collision')
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
