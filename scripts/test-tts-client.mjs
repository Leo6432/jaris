import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Relecture croisée : une synthèse de la voix de Jaris (ttsClient.ts → python/tts_server.py) n'avait AUCUNE limite. Un
 * programme de voix figé laissait la phrase attendre pour toujours — et la file du téléphone (onglet Vocal) restait
 * occupée jusqu'à la fermeture de Jaris. Surveillé maintenant par INACTIVITÉ : le temps depuis son dernier signe de vie.
 */
const require = createRequire(import.meta.url)
const { TtsClient, TTS_IDLE_MS } = loadTsModule('electron/services/ttsClient.ts', {
  child_process: { spawn: () => assert.fail('le vrai programme de voix ne doit jamais être lancé ici') },
  events: require('node:events'),
  readline: require('node:readline'),
  path: require('node:path'),
  '../config': { config: { tts: { voice: 'M1', language: 'fr' } } },
  '../paths': { pythonScriptsDir: () => '/python' },
  './pythonRuntime': { resolvePythonBin: () => 'python' },
  '../../shared/failureDetail': loadTsModule('shared/failureDetail.ts')
})

/** Un faux tts_server.py : chaque phrase reçue est notée ; le test décide quand (et si) il répond. */
function fakeVoice({ silentStart = false } = {}) {
  const procs = []
  const spawn = () => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.received = []
    proc.stdin = { write: (line) => proc.received.push(JSON.parse(line)) }
    proc.killed = false
    proc.kill = () => {
      proc.killed = true
      setImmediate(() => proc.emit('exit', null))
    }
    proc.say = (payload) => proc.stdout.write(`${JSON.stringify(payload)}\n`)
    procs.push(proc)
    if (!silentStart) setImmediate(() => proc.say({ event: 'ready' }))
    return proc
  }
  return { procs, spawn }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('une voix figée : la phrase échoue avec un vrai message, et la voix repart à la phrase suivante', async () => {
  assert.equal(TTS_IDLE_MS, 120_000)
  const voice = fakeVoice()
  const client = new TtsClient({ idleMs: 80, spawn: voice.spawn })
  const started = Date.now()
  await assert.rejects(client.synthesize('Bonjour'), /^Error: La voix de Jaris ne répond plus/)
  assert.ok(Date.now() - started < 2000)
  assert.equal(voice.procs[0].killed, true, 'le programme figé est laissé en vie')

  const next = client.synthesize('Rebonjour')
  await sleep(20)
  assert.equal(voice.procs.length, 2, 'la voix n’a pas été relancée')
  voice.procs[1].say({ event: 'speech', path: 'phrase.wav' })
  assert.equal(await next, 'phrase.wav')
})

test('une synthèse longue mais vivante n’est jamais coupée ; seules les phrases sans réponse échouent', async () => {
  const voice = fakeVoice()
  const client = new TtsClient({ idleMs: 80, spawn: voice.spawn })
  const first = client.synthesize('Un long texte')
  const second = client.synthesize('La suite')
  await sleep(10)
  const proc = voice.procs[0]
  assert.deepEqual(proc.received.map((r) => r.text), ['Un long texte', 'La suite'])
  // 300 ms au total, un message toutes les 40 ms : bien au-delà de la limite d'inactivité, jamais coupé.
  for (let i = 0; i < 7; i++) {
    await sleep(40)
    proc.stderr.write('avance…\n')
  }
  proc.say({ event: 'speech', path: 'long.wav' })
  assert.equal(await first, 'long.wav')
  // La suite ne reçoit plus rien : elle échoue seule, sans attendre pour toujours.
  await assert.rejects(second, /ne répond plus/)
})

test('rien en attente : aucune surveillance, la voix inactive n’est jamais arrêtée', async () => {
  const voice = fakeVoice()
  const client = new TtsClient({ idleMs: 50, spawn: voice.spawn })
  await client.start()
  await sleep(150)
  assert.equal(voice.procs[0].killed, false)
  client.stop()
})

// Étape 505 (Léo, version Store : « si je change de voix, ça ne veut même pas » — « Lecture… » sans fin) : le démarrage
// de la voix n'avait aucune surveillance. Bloqué au chargement de Supertonic, il faisait attendre pour toujours.
test('étape 505 : une voix bloquée AU DÉMARRAGE échoue avec la vraie raison (ses dernières lignes), puis repart', async () => {
  const voice = fakeVoice({ silentStart: true })
  const client = new TtsClient({ idleMs: 80, spawn: voice.spawn })
  const pending = client.synthesize('Bonjour')
  await sleep(10)
  voice.procs[0].stderr.write('Downloading model.onnx:  10%\rDownloading model.onnx:  12%\r')
  voice.procs[0].stderr.write("OSError: [WinError 5] Accès refusé: 'C:\\Users\\leo\\.cache\\supertonic3'\n")
  const started = Date.now()
  await assert.rejects(pending, (err) => {
    assert.match(err.message, /^La voix de Jaris ne démarre pas : aucun signe de vie depuis 0 s\./)
    assert.match(err.message, /Dernier message du programme de voix : OSError: \[WinError 5\] Accès refusé/)
    return true
  })
  assert.ok(Date.now() - started < 2000)
  assert.equal(voice.procs[0].killed, true, 'le programme bloqué est arrêté')
  // La phrase suivante relance la voix.
  const next = client.synthesize('Rebonjour')
  await sleep(10)
  assert.equal(voice.procs.length, 2)
  voice.procs[1].say({ event: 'ready' })
  await sleep(10)
  voice.procs[1].say({ event: 'speech', path: 'phrase.wav' })
  assert.equal(await next, 'phrase.wav')
  client.stop()
})

test('étape 505 : un long téléchargement qui avance n’est jamais coupé au démarrage', async () => {
  const voice = fakeVoice({ silentStart: true })
  const client = new TtsClient({ idleMs: 80, spawn: voice.spawn })
  const pending = client.synthesize('Bonjour')
  for (let i = 0; i < 6; i++) {
    await sleep(40)
    voice.procs[0]?.stderr.write(`Downloading model.onnx: ${i * 15}%\r`)
  }
  voice.procs[0].say({ event: 'ready' })
  await sleep(10)
  voice.procs[0].say({ event: 'speech', path: 'ok.wav' })
  assert.equal(await pending, 'ok.wav')
  assert.equal(voice.procs.length, 1, 'jamais relancé pendant qu’il avance')
  client.stop()
})

test('étape 505 : la voix qui s’arrête au démarrage dit pourquoi (dernier message), plus seulement son code', async () => {
  const voice = fakeVoice({ silentStart: true })
  const client = new TtsClient({ idleMs: 5000, spawn: voice.spawn })
  const pending = client.synthesize('Bonjour')
  await sleep(10)
  voice.procs[0].stderr.write('ModuleNotFoundError: No module named onnxruntime\n')
  await sleep(5)
  voice.procs[0].emit('exit', 1)
  await assert.rejects(pending, /code 1\).*Dernier message du programme de voix : ModuleNotFoundError: No module named onnxruntime/)
  client.stop()
})
