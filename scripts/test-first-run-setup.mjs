import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
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

test('le code 448 déclenche un essai ciblé puis la fenêtre du même installeur, sans second téléchargement', async () => {
  const source = readFileSync(new URL('../electron/services/dependencyServices.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  const launches = []
  let downloads = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true })
  try {
    vm.runInThisContext(`(function(exports, module, require) { ${compiled} })`)(exports, { exports }, (id) => {
      if (id === 'child_process') return {
        exec: (_command, callback) => callback(null, { stdout: '', stderr: '' }),
        execSync: () => '',
        spawn: (file, args, options) => {
          const child = new EventEmitter()
          if (file === 'powershell.exe') {
            queueMicrotask(() => child.emit('close', 0))
            return child
          }
          launches.push({ file, args, options })
          queueMicrotask(() => child.emit('close', launches.length < 3 ? 4 : 0))
          return child
        }
      }
      if (id === 'fs') return { existsSync: () => false, mkdirSync: () => {} }
      if (id === 'fs/promises') return { readFile: async () => 'CreateFile failed; code 448.', rm: async () => {} }
      if (id === 'path') return nodePath
      if (id === 'util') return { promisify: () => async () => ({ stdout: '' }) }
      if (id === './storageRoot') return { downloadsDir: () => 'D:\\Jaris-data\\downloads', getStorageRoot: () => 'D:\\Jaris-data' }
      if (id === './dockerLocation') return { dockerInstallFlags: () => [] }
      if (id === '../config') return { config: { ollama: { host: 'http://127.0.0.1:11434' } } }
      if (id === './appLauncher') return { didAppLaunch: () => true, openApp: async () => '' }
      if (id === './download') return { downloadToFile: async () => { downloads++ } }
      if (id === '../paths') return { resourcesRoot: () => '' }
      if (id === '../../shared/formatBytes') return { formatBytes: () => '' }
      throw new Error(`Module inattendu : ${id}`)
    })
    const messages = []
    assert.equal(await exports.installOllamaSilently((message) => messages.push(message)), true)
    assert.equal(downloads, 1)
    assert.equal(launches.length, 3)
    assert.ok(launches[0].args.includes('/VERYSILENT'))
    assert.ok(!launches[0].args.includes('/NOREDIRECTIONGUARD'))
    assert.ok(launches[1].args.includes('/VERYSILENT'))
    assert.ok(launches[1].args.includes('/NOREDIRECTIONGUARD'))
    assert.ok(!launches[2].args.includes('/VERYSILENT'))
    assert.ok(launches[2].args.includes('/NOREDIRECTIONGUARD'))
    assert.ok(launches.every((launch) => launch.args.some((arg) => arg.includes('/DIR=D:\\Jaris-data\\ollama-app'))))
    assert.ok(launches.every((launch) => launch.options.env.TEMP === 'D:\\Jaris-data\\downloads\\ollama-temp'))
    assert.ok(launches.every((launch) => launch.options.env.TMP === 'D:\\Jaris-data\\downloads\\ollama-temp'))
    assert.ok(messages.some((message) => /fenêtre|s'ouvre/.test(message)))
  } finally {
    globalThis.fetch = originalFetch
  }
})
