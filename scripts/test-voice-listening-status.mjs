import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 188 (l'ami de Léo : « il parle, il entend rien ») : le test micro envoyé à une écoute qui charge encore
 * ou qui s'est arrêtée ne recevait aucune réponse. VoiceClient suit maintenant où en est le programme d'écoute,
 * pour que l'écran dise pourquoi le test ne tourne pas au lieu de rester muet.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/voiceClient.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

let lastProc = null
function fakeSpawn() {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.stdin = { written: [], write(line) { this.written.push(line) } }
  proc.kill = () => {}
  lastProc = proc
  return proc
}

const modules = {
  child_process: { spawn: fakeSpawn },
  events: { EventEmitter },
  readline: await import('node:readline'),
  path: await import('node:path'),
  '../config': { config: { voice: { inputDevice: '' } } },
  '../paths': { pythonScriptsDir: () => '/python' },
  './pythonRuntime': { resolvePythonBin: () => 'python' }
}
const module = { exports: {} }
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(module.exports, module, (name) => {
  if (!(name in modules)) throw new Error(`module inattendu : ${name}`)
  return modules[name]
})
const { VoiceClient, listeningUnavailableReason } = module.exports

const emitLine = (payload) => lastProc.stdout.write(`${JSON.stringify(payload)}\n`)
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('en chargement, puis prête : la raison disparaît seulement quand le sidecar a dit « ready »', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  assert.match(listeningUnavailableReason(client.getStatus()), /télécharge la transcription/)
  emitLine({ event: 'ready' })
  await ready
  assert.equal(listeningUnavailableReason(client.getStatus()), null)
})

test('un échec de démarrage relaie le VRAI message, jamais un message générique', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'fatal', message: "impossible d'ouvrir le micro : Device unavailable" })
  await assert.rejects(ready)
  assert.equal(listeningUnavailableReason(client.getStatus()), "L'écoute n'a pas pu démarrer : impossible d'ouvrir le micro : Device unavailable")
})

test('une écoute qui s’arrête toute seule après avoir été prête n’est plus considérée prête', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  lastProc.emit('exit', 3)
  await tick()
  assert.match(listeningUnavailableReason(client.getStatus()), /arrêtée toute seule \(code 3\)/)
})

test('un arrêt voulu (changement de micro) ne se transforme pas en échec', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  const proc = lastProc
  client.stop()
  proc.emit('exit', null)
  assert.deepEqual({ ...client.getStatus() }, { state: 'off' })
})

test('la fin du test micro transmet aussi le « silence total »', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  const done = new Promise((resolve) => client.once('micTestDone', resolve))
  emitLine({ event: 'mic_test_done', detected: false, silentStream: true })
  assert.deepEqual({ ...(await done) }, { detected: false, silentStream: true })
})
