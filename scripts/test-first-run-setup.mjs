import { I18N_MODULES } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('un échec d’Ollama conserve sa vraie raison dans le message final du premier lancement', async () => {
  const source = readFileSync(new URL('../electron/services/firstRunSetup.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  const reason = 'L’installeur Ollama s’est arrêté avec le code 5. Journal : D:\\Jaris\\downloads\\JarisOllamaSetup.log'
  vm.runInThisContext(`(function(exports, module, require) { ${compiled} })`)(exports, { exports }, (id) => {
    if (id in I18N_MODULES) return I18N_MODULES[id]
    if (id === './dependencyServices') return {
      isOllamaInstalled: async () => false,
      installOllamaSilently: async (onProgress) => { onProgress(reason); return false }
    }
    if (id === './pythonRuntime') return { isPythonRuntimeReady: async () => true }
    throw new Error(`Module inattendu : ${id}`)
  })

  const progress = []
  await exports.runFirstRunSetup((event) => progress.push(event))
  const failure = progress.find((event) => event.step === 'ollama' && event.failed)
  assert.ok(failure)
  assert.match(failure.message, /code 5/)
  assert.match(failure.message, /JarisOllamaSetup\.log/)
  assert.doesNotMatch(failure.message, /installer depuis ollama\.com/)
})
