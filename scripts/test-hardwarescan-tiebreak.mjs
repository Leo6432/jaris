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
 * comportement départageait UNIQUEMENT par VRAM (le plus gros gagne) — qwen3.8:27b (18 Go) aurait donc battu
 * qwen3.5:27b (17 Go) même si son score MMLU-Pro réel (84.3, voir INTELLIGENCE_MMLU_PRO) est plus bas que
 * celui de qwen3.5:27b (86.1). Vérifie que pickBestFrom (dans computeModelPicks) utilise maintenant ce vrai
 * chiffre en premier, la VRAM ne restant un repli que si aucun des deux candidats à égalité n'a de score
 * MMLU-Pro connu. Mêmes mocks no-op qu'ailleurs pour fs/child_process/systemResources (pas de vraie machine
 * ni de vrai fichier disque dans ce test).
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
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => ramGb }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name)
  })
  return exports
}

test('à 6/6 égalité, départage par MMLU-Pro (réel) plutôt que par la VRAM la plus grosse', async () => {
  const { pickBestModelsFromBenchmark } = setup({
    verifiedToolScoresMd: ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:27b | 6/6 |', '| qwen3.8:27b | 6/6 |'].join(
      '\n'
    )
  })
  const result = await pickBestModelsFromBenchmark()
  // qwen3.8:27b (18 Go) est PLUS GROS que qwen3.5:27b (17 Go) : l'ancien départage par VRAM seule l'aurait
  // choisi. Son MMLU-Pro réel (84.3) est pourtant plus bas que celui de qwen3.5:27b (86.1, voir
  // INTELLIGENCE_MMLU_PRO) — le nouveau départage doit donc préférer qwen3.5:27b malgré sa VRAM plus petite.
  assert.equal(result.models.large, 'qwen3.5:27b')
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
