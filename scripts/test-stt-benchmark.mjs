import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 156, test de vitesse de la transcription (Options → Voix) : Jaris lance python/stt_benchmark.py, relaie
 * son avancement, rend son tableau — et la voix de Jaris, coupée pendant le test pour libérer la carte, doit
 * TOUJOURS repartir, même si le test échoue.
 */
const nodeRequire = createRequire(import.meta.url)
const root = new URL('..', import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('electron/services/sttBenchmark.ts', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

/** Charge sttBenchmark.ts avec un faux Python qui écrit `lines` puis se termine avec `code`. */
function load({ lines = [], code = 0, stderr = '' } = {}) {
  const spawned = []
  const spawn = (file, args) => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => {}
    spawned.push({ file, args })
    setImmediate(() => {
      if (stderr) proc.stderr.write(stderr)
      for (const line of lines) proc.stdout.write(`${line}\n`)
      proc.stdout.end()
      proc.stderr.end()
      setImmediate(() => proc.emit('close', code))
    })
    return proc
  }
  const exports = {}
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(exports, (name) => {
    if (name === 'child_process') return { spawn }
    if (name === '../paths') return { pythonScriptsDir: () => 'D:\\Jaris\\resources\\python' }
    if (name === './pythonRuntime') return { resolvePythonBin: () => 'python.exe' }
    return nodeRequire(name)
  }, { exports })
  return { ...exports, spawned }
}

test('les lignes du script sont reconnues, le reste est ignoré', () => {
  const { parseSttBenchmarkLine } = load()
  assert.deepEqual(parseSttBenchmarkLine('{"event":"progress","message":"Test : Parakeet v3 en RAM…"}'), { kind: 'progress', message: 'Test : Parakeet v3 en RAM…' })
  assert.deepEqual(parseSttBenchmarkLine('{"event":"result","gpu":null,"rows":[]}'), { kind: 'result', gpu: null, rows: [] })
  assert.equal(parseSttBenchmarkLine('Loading weights: 50%'), null)
  assert.equal(parseSttBenchmarkLine('{"event":"row"}'), null) // ligne interne aux processus enfants
})

test("l'avancement est relayé et le tableau rendu", async () => {
  const row = { id: 'parakeet-ram', label: 'Parakeet v3 en RAM', where: 'ram', available: true, secondsPer5s: 0.53, ramGb: 2.5, vramGb: 0, errorsPct: 0 }
  const { runSttBenchmark, spawned } = load({
    lines: [
      JSON.stringify({ event: 'progress', message: 'Préparation des phrases de test (voix de Jaris)…' }),
      'Loading weights: 100%',
      JSON.stringify({ event: 'result', gpu: 'NVIDIA GeForce RTX 3070', rows: [row] })
    ]
  })
  const progress = []
  const result = await runSttBenchmark((message) => progress.push(message))
  assert.deepEqual(progress, ['Préparation des phrases de test (voix de Jaris)…'])
  assert.equal(result.ok, true)
  assert.equal(result.gpu, 'NVIDIA GeForce RTX 3070')
  assert.deepEqual(result.rows, [row])
  assert.match(spawned[0].args.join(' '), /stt_benchmark\.py$/)
})

test('un script qui s’arrête sans tableau donne un message lisible, jamais un tableau vide présenté comme un résultat', async () => {
  const { runSttBenchmark } = load({ lines: [], code: 1, stderr: 'Traceback…\nModuleNotFoundError: No module named onnx_asr\n' })
  const result = await runSttBenchmark(() => {})
  assert.equal(result.ok, false)
  assert.match(result.message, /arrêté avant la fin \(code 1\).*onnx_asr/)
})

test('la voix de Jaris est coupée pendant le test puis relancée, même si le test échoue', () => {
  const main = readFileSync(new URL('electron/main.ts', root), 'utf8').replace(/\r\n/g, '\n')
  const handler = main.match(/ipcMain\.handle\(IPC_CHANNELS\.runSttBenchmark,[\s\S]*?\n  \}\)\n/)
  assert.ok(handler, 'gestionnaire runSttBenchmark introuvable')
  const body = handler[0]
  const order = ['pipeline?.stop()', 'ttsClient.stop()', 'unloadAllModels()', 'runSttBenchmark(']
  let last = -1
  for (const step of order) {
    const at = body.indexOf(step)
    assert.ok(at > last, `${step} doit venir après l'étape précédente`)
    last = at
  }
  assert.match(body, /finally \{[\s\S]*startVoicePipeline\(\)/, 'la voix doit repartir dans un finally')
})

test('onnx-asr est figé, et le script du test est bien embarqué dans l’installeur', () => {
  const requirements = readFileSync(new URL('python/requirements.txt', root), 'utf8')
  assert.match(requirements, /^onnx-asr==0\.12\.0\r?$/m)
  const builder = readFileSync(new URL('electron-builder.yml', root), 'utf8')
  assert.match(builder, /- '\*\*\/\*\.py'/, 'les scripts Python du dossier python/ sont copiés dans l’installeur')
})

const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0)

test('le taux d’erreurs compte les mots, sans pénaliser la ponctuation ni la casse', { skip: python ? false : 'Python indisponible' }, () => {
  const script = fileURLToPath(new URL('python/', root))
  const out = execFileSync(python, ['-c', [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(script)})`,
    'from stt_benchmark import word_errors',
    'print(json.dumps([',
    '  word_errors("Jaris, quel temps fera-t-il demain à Lyon ?", "jaris quel temps fera t il demain à lyon"),',
    '  word_errors("Ouvre le bloc-notes et écris bonjour.", "Ouvre le bloc-note et écrit bonjour."),',
    '  word_errors("Cherche une recette.", ""),',
    ']))'
  ].join('\n')], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(out), [[0, 9], [2, 7], [3, 3]])
})
