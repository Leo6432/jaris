import { I18N_MODULES } from './i18n-test-module.mjs'
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
function fakeSpawn(_bin, args) {
  const proc = new EventEmitter()
  proc.args = args
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
  // Étape 214 : identifiants des transcriptions de messages vocaux du téléphone.
  crypto: await import('node:crypto'),
  path: await import('node:path'),
  '../config': { config: { voice: { inputDevice: '' } } },
  '../paths': { pythonScriptsDir: () => '/python' },
  './pythonRuntime': { resolvePythonBin: () => 'python' }
}
const module = { exports: {} }
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(module.exports, module, (name) => {
  if (name in I18N_MODULES) return I18N_MODULES[name]
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

// Étape 214 : un message vocal du téléphone est transcrit par le MÊME programme d'écoute (déjà chargé) — la
// commande part sur stdin avec un identifiant, et seule la réponse portant cet identifiant la termine.
test('message vocal du téléphone : commande envoyée, réponse rattachée à SON identifiant', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  const result = client.transcribeFile('C:\\Users\\Léo\\Temp\\vocal.wav')
  const line = lastProc.stdin.written.at(-1)
  assert.match(line, /^transcribe-file \{.*\}\n$/)
  const { id, path } = JSON.parse(line.slice('transcribe-file '.length))
  assert.equal(path, 'C:\\Users\\Léo\\Temp\\vocal.wav')
  emitLine({ event: 'file_transcript', id: 'autre-id', text: 'pas pour moi' })
  emitLine({ event: 'file_transcript', id, text: 'allume la lumière' })
  assert.equal(await result, 'allume la lumière')

  const failing = client.transcribeFile('x.wav')
  const failingId = JSON.parse(lastProc.stdin.written.at(-1).slice('transcribe-file '.length)).id
  emitLine({ event: 'file_transcript', id: failingId, error: 'format audio inattendu' })
  await assert.rejects(failing, /format audio inattendu/)
})

test('message vocal pendant que l’écoute charge encore : la vraie raison, pas une attente sans fin', async () => {
  const client = new VoiceClient()
  void client.start().catch(() => {})
  await assert.rejects(client.transcribeFile('x.wav'), /télécharge la transcription/)
})

// Étape 325 : « Parler à Jaris » dit pourquoi l'écoute ne démarre pas, et cette raison doit s'effacer d'elle-même
// quand l'écoute devient prête — chaque changement d'état est donc annoncé, y compris un arrêt après coup.
test('chaque changement d’état de l’écoute est annoncé (chargement, prête, arrêt imprévu, arrêt voulu)', async () => {
  const client = new VoiceClient()
  const seen = []
  client.on('status', (status) => seen.push(listeningUnavailableReason(status) === null ? 'prête' : status.state))
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  lastProc.emit('exit', 3)
  await tick()
  const second = client.start()
  emitLine({ event: 'ready' })
  await second
  client.stop()
  assert.deepEqual(seen, ['loading', 'prête', 'failed', 'loading', 'prête', 'off'])
})

// Étape 346 : micro débranché ou coupé — le programme d'écoute reste en vie (téléphone) et dit pourquoi il n'entend rien.
test('aucun micro : la raison s’affiche, les messages du téléphone passent, et le micro revenu efface la raison', async () => {
  const client = new VoiceClient()
  const statuses = []
  client.on('status', (status) => statuses.push(status.state))
  const ready = client.start()
  emitLine({ event: 'ready' })
  emitLine({ event: 'mic_status', available: false, message: 'Error querying device -1' })
  await ready
  await tick()
  const reason = listeningUnavailableReason(client.getStatus())
  assert.match(reason, /Aucun micro ne répond/)
  assert.match(reason, /Error querying device -1/, 'le vrai détail est gardé')
  const transcript = client.transcribeFile('/tmp/message.wav')
  await tick()
  const sent = lastProc.stdin.written.find((line) => line.startsWith('transcribe-file '))
  assert.ok(sent, 'le message du téléphone est envoyé malgré l’absence de micro')
  emitLine({ event: 'file_transcript', id: JSON.parse(sent.slice('transcribe-file '.length)).id, text: 'bonjour' })
  assert.equal(await transcript, 'bonjour')
  emitLine({ event: 'mic_status', available: true })
  await tick()
  assert.equal(listeningUnavailableReason(client.getStatus()), null)
  assert.deepEqual(statuses, ['loading', 'ready', 'noMic', 'ready'])
})

test('« aucun micro ne renvoie de son » (touche + sans micro) est traduit', () => {
  const { translateSidecarMessage } = module.exports
  assert.match(translateSidecarMessage('aucun micro ne renvoie de son'), /Aucun micro ne répond/)
})

test('le micro est passé par son NOM au programme d’écoute', async () => {
  const client = new VoiceClient()
  const ready = client.start(4, true, 'Micro USB (Blue Yeti)')
  emitLine({ event: 'ready' })
  await ready
  const args = lastProc.args
  assert.equal(args[args.indexOf('--input-device-name') + 1], 'Micro USB (Blue Yeti)')
  const plain = new VoiceClient()
  const plainReady = plain.start(4, true, null)
  emitLine({ event: 'ready' })
  await plainReady
  assert.ok(!lastProc.args.includes('--input-device-name'), 'sans nom (ancien profil), seul le numéro part')
})

test('un mic_status d’un programme déjà remplacé ou arrêté ne change rien', async () => {
  const client = new VoiceClient()
  const ready = client.start()
  emitLine({ event: 'ready' })
  await ready
  const old = lastProc
  client.stop()
  old.stdout.write(`${JSON.stringify({ event: 'mic_status', available: false, message: 'x' })}\n`)
  await tick()
  assert.equal(client.getStatus().state, 'off')
})

