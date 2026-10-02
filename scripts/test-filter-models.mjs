import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/** src/lib/filterModels.ts, étape 226 : la recherche de « Tous les modèles ». */
function load(path, requireFn) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(module.exports, module, requireFn)
  return module.exports
}
const formatModelName = load('../src/lib/formatModelName.ts', () => ({}))
const { filterModels } = load('../src/lib/filterModels.ts', () => formatModelName)

const entries = ['qwen3.5:9b', 'qwen3.5:0.8b', 'gemma4:12b', 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF'].map(
  (model) => ({ model })
)
const names = (query) => filterModels(entries, query).map((e) => e.model)

test('recherche vide : tout reste affiché', () => {
  assert.equal(filterModels(entries, '').length, entries.length)
  assert.equal(filterModels(entries, '   ').length, entries.length)
})

test('majuscules, accents et ponctuation ignorés', () => {
  assert.deepEqual(names('QWEN'), ['qwen3.5:9b', 'qwen3.5:0.8b'])
  assert.deepEqual(names('qwen 3.5 9b'), ['qwen3.5:9b'])
  assert.deepEqual(names('qwen35'), ['qwen3.5:9b', 'qwen3.5:0.8b'])
  assert.deepEqual(names('gemmâ'), ['gemma4:12b'])
})

test('nom affiché comme tag complet : « minicpm 2b », « openbmb » et « g9v3 » trouvent le bon modèle', () => {
  assert.deepEqual(names('minicpm 2b'), ['hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M'])
  assert.deepEqual(names('openbmb'), ['hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M'])
  assert.deepEqual(names('g9v3'), ['hf.co/bartowski/ai9stars_G9v3-3B-GGUF'])
})

test('chaque mot doit correspondre, dans n’importe quel ordre', () => {
  assert.deepEqual(names('9b qwen'), ['qwen3.5:9b'])
  assert.deepEqual(names('qwen gemma'), [])
})
