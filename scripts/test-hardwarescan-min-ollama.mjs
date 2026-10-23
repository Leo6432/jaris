import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Étape 312 (Léo : « ajoute sur tous les modèles test comme d'habitude, 3.7b, 0.9b, 7b et 32b ») : K2 Horizon
 * n'est chargé qu'à partir d'Ollama 0.40.4. Verrouillé ici : avec une version plus ancienne (ou inconnue),
 * Jaris ne le choisit pour AUCUN rôle et ne le propose pas au test — il téléchargerait des Go pour un modèle qui
 * ne démarre pas. Dès 0.40.4 (pré-version comprise), il redevient un candidat comme les autres.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

const K2 = {
  tiny: 'hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M',
  small: 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M',
  mid: 'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M',
  large: 'hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M'
}
const ALL_K2 = Object.values(K2)

function setup({ scores, vramMib, ramGb = 32, ollamaVersion }) {
  // Même marque que les autres tests de ce module : sans elle, promisify(exec) résout vers un tableau et la VRAM
  // simulée est ignorée en silence.
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return scores
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, module: { exports }, require: withI18n((name) => modules[name] ?? nodeRequire(name)) })
  if (ollamaVersion !== undefined) exports.setOllamaVersionSource(() => ollamaVersion)
  return exports
}

const picked = (result) => [result.models.flash, result.models.medium, result.models.large, result.visionModel, result.codeModel]

test('les quatre K2 Horizon exigent Ollama 0.40.4 ; la pré-version rc1 suffit', () => {
  const { modelsNeedingNewerOllama } = setup({ scores: '', vramMib: 8192 })
  assert.deepEqual([...modelsNeedingNewerOllama('0.40.3')].sort(), [...ALL_K2].sort())
  assert.deepEqual([...modelsNeedingNewerOllama('0.34.2')].sort(), [...ALL_K2].sort())
  assert.equal(modelsNeedingNewerOllama('0.40.4-rc1').size, 0)
  assert.equal(modelsNeedingNewerOllama('0.40.4').size, 0)
  assert.equal(modelsNeedingNewerOllama('0.41.0').size, 0)
  // Version inconnue (Ollama pas encore interrogé) : prudence, rien de K2 Horizon.
  assert.deepEqual([...modelsNeedingNewerOllama(null)].sort(), [...ALL_K2].sort())
})

test('Ollama 0.40.3 : aucun rôle ne tombe sur K2 Horizon, quelle que soit la carte', async () => {
  for (const vramMib of [4096, 6144, 8192, 12288, 24576]) {
    const { pickBestModelsFromBenchmark } = setup({ scores: REAL_SCORES, vramMib, ollamaVersion: '0.40.3' })
    const roles = picked(await pickBestModelsFromBenchmark())
    assert.deepEqual(roles.filter((m) => ALL_K2.includes(m)), [], `${vramMib} Mio : ${roles.join(', ')}`)
  }
})

test('dès Ollama 0.40.4, K2 Horizon redevient un candidat comme les autres', async () => {
  // Seul score de code connu : K2 Horizon 3.7B (5/5) devant qwen2.5-coder:7b (3/5).
  const scores = ['## Code', '| Modèle | Fiabilité |', '|---|---|', `| ${K2.small} | 5/5 |`, '| qwen2.5-coder:7b | 3/5 |'].join('\n')
  const tooOld = setup({ scores, vramMib: 8192, ollamaVersion: '0.40.3' })
  assert.equal((await tooOld.pickBestModelsFromBenchmark()).codeModel, 'qwen2.5-coder:7b')
  assert.equal(await tooOld.pickBestCodeModel(), 'qwen2.5-coder:7b')
  const recent = setup({ scores, vramMib: 8192, ollamaVersion: '0.40.4-rc1' })
  assert.equal((await recent.pickBestModelsFromBenchmark()).codeModel, K2.small)
  assert.equal(await recent.pickBestCodeModel(), K2.small)
  // Version inconnue : prudence, comme une version trop ancienne.
  const unknown = setup({ scores, vramMib: 8192, ollamaVersion: null })
  assert.equal(await unknown.pickBestCodeModel(), 'qwen2.5-coder:7b')
})

test('le bouton de test ne propose K2 Horizon qu’une fois Ollama capable de le charger', () => {
  // Étape 315 : les scores de la 7B et de la 32B ont été recopiés depuis ; ce test porte sur la version d'Ollama, il
  // repart donc de l'état de l'étape 312 (seule la 3.7B mesurée). Étape 322 : sans la section « À remesurer », qui
  // fait de nouveau proposer la 3.7B (mesurée sur le PC de Claude).
  const scores = REAL_SCORES.split(/\r?\n## À remesurer/)[0]
    .split('\n')
    .filter((line) => !/K2-Horizon-(0\.9B|7B|32B)/.test(line))
    .join('\n')
  assert.ok(REAL_SCORES.includes('## À remesurer') && !scores.includes('## À remesurer'))
  const tooOld = setup({ scores, vramMib: 8192, ollamaVersion: '0.40.3' })
  // Recopiés dans ce realm : vm.runInNewContext a ses propres prototypes (deepEqual échouerait sinon).
  assert.deepEqual([...tooOld.getUnscoredModels()].filter((m) => ALL_K2.includes(m)), [])
  const recent = setup({ scores, vramMib: 8192, ollamaVersion: '0.40.4' })
  const offered = [...recent.getUnscoredModels()]
  // 3.7B a déjà ses trois scores (mesurés à l'étape 312) ; les trois autres tailles restent à mesurer.
  assert.deepEqual(ALL_K2.filter((m) => offered.includes(m)).sort(), [K2.tiny, K2.mid, K2.large].sort())
})

// Étape 346 : la version d'Ollama compte dans le choix des modèles — elle est relue AVANT « Retester la configuration »,
// et connue dès qu'Ollama répond, sans attendre la comparaison avec GitHub.
test('la version d’Ollama est relue avant de choisir, sans attendre GitHub', async () => {
  const { readFileSync: read } = await import('node:fs')
  const main = read(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setOllamaVersionSource\(\(\) => getLocalOllamaVersion\(\)\)/)
  const handler = main.slice(main.indexOf('IPC_CHANNELS.runQuickSetup, async'))
  assert.ok(handler.indexOf('await refreshLocalOllamaVersion()') < handler.indexOf('return runQuickSetup('))
  const deps = read(new URL('../electron/services/dependencyServices.ts', import.meta.url), 'utf8')
  const local = deps.slice(deps.indexOf('async function readLocalOllamaVersion'), deps.indexOf('export function getLocalOllamaVersion'))
  assert.match(local, /knownLocalVersion = version/, 'gardée dès la lecture locale, avant tout appel à GitHub')
})
