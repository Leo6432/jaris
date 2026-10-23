import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 346 — bugs de la voix trouvés par la chasse aux bugs (« ouvre bloc note… Jaris ne répond pas ») :
 * « @ » à la place de mots courants, relance complète quand on reparle pendant la réflexion (actions refaites),
 * réveil par sa propre voix, « J'écoute » bloqué, et ce qui est dit à voix haute absent du Chat.
 */
class FakeVoiceClient extends EventEmitter {
  static last = null
  constructor() {
    super()
    this.paused = false
    this.status = 'ready'
    FakeVoiceClient.last = this
  }
  start() {
    return Promise.resolve()
  }
  stop() {}
  setWakePaused(paused) {
    this.paused = paused
  }
  getStatus() {
    return { state: this.status }
  }
  triggerWake() {
    this.triggers = (this.triggers ?? 0) + 1
  }
}

const noop = () => {}
const harness = { converse: async () => 'Réponse.', exchanges: [] }
const { VoicePipeline, normalizeSpokenSymbols, isPresenceCheck } = loadTsModule('electron/services/voicePipeline.ts', {
  events: { EventEmitter },
  crypto: { randomUUID: () => 'id' },
  './voiceClient': {
    VoiceClient: FakeVoiceClient,
    listeningUnavailableReason: (status) => (status.state === 'ready' ? null : `écoute ${status.state}`)
  },
  './tts': { synthesizeSpeech: async () => Buffer.from([1, 2, 3, 4]) },
  './conversationStore': { appendConversationEntry: async () => {}, getActiveConversationId: async () => 'conv' },
  './assistant': { converse: (...args) => harness.converse(...args), LOOKUP_TOOLS: new Set(['search_web', 'read_web_page', 'recall_memory', 'get_system_stats']) },
  './conversationSession': { VOICE_CONTEXT_MAX_AGE_MS: 1, clearSessionHistory: noop, getSessionHistory: async () => [], pushSessionExchange: noop },
  './memoryExtractor': { cancelMemoryExtraction: noop, extractMemoryFromExchange: noop },
  './profileStore': { getProfile: async () => ({ voiceCorrectionEnabled: false }) },
  './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null, tempC: null }) },
  './resourceMonitor': { checkGpuTempSafety: () => ({ action: 'ok' }) },
  './transcriptCorrector': { CORRECTION_SCHEMA: {}, correctTranscript: async (text) => ({ text, changed: false }) },
  './ollama': { structuredChat: async () => '', preferLoadedModel: async (_c, preferred) => preferred },
  '../config': { config: { ollama: { model: 'm', numCtx: 8192 } } },
  './requestJournal': { appendJournal: noop, formatElapsed: () => '' },
  '../../shared/voiceActivity': { activityFromLog: () => null, formatActivity: () => '', thinkingActivity: () => '' }
})

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

async function started() {
  const pipeline = new VoicePipeline()
  const emotions = []
  pipeline.on('emotion', (emotion) => emotions.push(emotion))
  pipeline.on('exchange', (exchange) => harness.exchanges.push(exchange))
  await pipeline.start()
  return { pipeline, voice: FakeVoiceClient.last, emotions }
}

test('« arobase » n’est remplacé que dans une adresse : les mots courants restent intacts', () => {
  for (const phrase of ['la cuisine arabe est bonne', 'un arbre tombe', "c'est probable", 'une grosse voiture robuste', 'de la prose', 'il faut arroser', 'comment on écrit arobase ?', 'le symbole arobas est rond']) {
    assert.equal(normalizeSpokenSymbols(phrase), phrase)
  }
  assert.equal(normalizeSpokenSymbols('jean point dupont arobase gmail point com'), 'jean point dupont @ gmail point com')
  assert.equal(normalizeSpokenSymbols('écris à paul rubaze exemple.fr'), 'écris à paul @ exemple.fr')
  assert.equal(normalizeSpokenSymbols('marie arobaz mondomaine point fr'), 'marie @ mondomaine point fr')
})

test('une vérification de présence pendant la réflexion ne relance rien', async () => {
  assert.ok(isPresenceCheck('Jaris'))
  assert.ok(isPresenceCheck("Tu m'entends ?"))
  assert.ok(isPresenceCheck('Allô Jaris ?'))
  assert.ok(!isPresenceCheck("En fait l'ethereum"))
  let release
  let calls = 0
  harness.converse = async (question, _name, _rem, _log, _history, signal) => {
    calls++
    await new Promise((done) => (release = done))
    assert.equal(signal.aborted, false, 'la réflexion n’a pas été annulée')
    return `Réponse à ${question}`
  }
  const { voice } = await started()
  voice.emit('transcript', 'Quel temps fait-il ?')
  await wait(10)
  voice.emit('transcript', "Tu m'entends ?")
  await wait(10)
  release()
  await wait(20)
  assert.equal(calls, 1)
})

test('après une action sur le PC, une nouvelle phrase devient une nouvelle demande au lieu de tout relancer', async () => {
  const asked = []
  let release
  harness.converse = async (question, _name, _rem, onLog, _history, signal) => {
    asked.push(question)
    if (asked.length === 1) {
      onLog('Outil appelé : set_reminder({"message":"linge","delay_minutes":10})')
      await new Promise((done) => (release = done))
      assert.equal(signal.aborted, false)
    }
    return 'Fait.'
  }
  const { voice } = await started()
  voice.emit('transcript', 'Rappelle-moi le linge dans 10 minutes')
  await wait(10)
  voice.emit('transcript', 'Et quelle heure est-il ?')
  await wait(10)
  release()
  await wait(30)
  assert.deepEqual(asked, ['Rappelle-moi le linge dans 10 minutes', 'Et quelle heure est-il ?'], 'le rappel n’est pas reposé une seconde fois')
})

test('sans action, une phrase dite juste après se fusionne toujours avec la question (comportement d’avant)', async () => {
  const asked = []
  harness.converse = async (question, _n, _r, _l, _h, signal) => {
    asked.push(question)
    if (asked.length === 1) await new Promise((done) => signal.addEventListener('abort', done))
    if (signal.aborted) throw new Error('annulé')
    return 'ok'
  }
  const { voice } = await started()
  voice.emit('transcript', 'Quel est le prix du bitcoin')
  await wait(10)
  voice.emit('transcript', "en fait l'ethereum")
  await wait(30)
  assert.deepEqual(asked, ['Quel est le prix du bitcoin', "Quel est le prix du bitcoin. en fait l'ethereum"])
})

test('Jaris ne s’écoute pas parler : l’écoute du nom est coupée pendant la réponse, puis reprise au repos', async () => {
  harness.converse = async () => 'Je suis Jaris.'
  harness.exchanges = []
  const { pipeline, voice } = await started()
  voice.emit('transcript', 'Comment tu t’appelles ?')
  await wait(30)
  assert.equal(voice.paused, true, 'pendant la lecture')
  pipeline.notifyAudioEnded()
  await wait(450)
  assert.equal(voice.paused, false, 'repris après la fin de la lecture')
  assert.deepEqual(harness.exchanges, [{ transcript: 'Comment tu t’appelles ?', reply: 'Je suis Jaris.' }], 'le Chat est prévenu')
  // Suspendue (Chat ouvert), l'écoute reste coupée même après la fin de la lecture.
  pipeline.setListeningSuspended(true)
  assert.equal(voice.paused, true)
})

test('« J’écoute » ne reste jamais bloqué : suspension, phrase ignorée, programme d’écoute arrêté', async () => {
  const { pipeline, voice, emotions } = await started()
  voice.emit('wake')
  assert.equal(emotions.at(-1), 'listening')
  pipeline.setListeningSuspended(true)
  await wait(5)
  assert.equal(emotions.at(-1), 'idle', 'suspendu en pleine écoute')

  pipeline.setListeningSuspended(false)
  voice.emit('wake')
  // La phrase arrive juste après la suspension, sans passer par setListeningSuspended (course entre les deux).
  pipeline.suspended = true
  voice.emit('transcript', 'bonjour')
  await wait(5)
  assert.equal(emotions.at(-1), 'idle', 'phrase reçue pendant la suspension')

  pipeline.setListeningSuspended(false)
  voice.emit('wake')
  voice.status = 'failed'
  voice.emit('status')
  await wait(5)
  assert.equal(emotions.at(-1), 'idle', 'programme d’écoute en échec')
})

test('le retour au repos vient toujours du processus principal : plus de minuteur local dans l’écran', async () => {
  const { readFileSync } = await import('node:fs')
  const store = readFileSync(new URL('../src/store/useJarisStore.ts', import.meta.url), 'utf8')
  assert.ok(!/setTimeout/.test(store), 'aucun minuteur qui remettrait « idle » sans prévenir le processus principal')
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /pipeline\.on\('exchange',[\s\S]{0,200}chatSession\.addSpokenExchange\(transcript, reply\)[\s\S]{0,80}chatHistoryChanged/)
})

test('« + » sans réponse du programme d’écoute (micro débranché) : retour au repos, jamais un widget déplié pour rien', async (t) => {
  const { pipeline, voice, emotions } = await started()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  pipeline.triggerWake()
  assert.equal(voice.triggers, 1)
  const before = emotions.length
  t.mock.timers.tick(3_900)
  assert.equal(emotions.length, before, 'pas avant le délai')
  t.mock.timers.tick(200)
  t.mock.timers.tick(0)
  assert.equal(emotions.length, before + 1, 'retour au repos annoncé : le widget se replie')
  assert.equal(emotions.at(-1), 'idle')

  // Le programme répond « wake » : le délai est annulé, l'écoute continue normalement.
  pipeline.triggerWake()
  voice.emit('wake')
  const listening = emotions.length
  t.mock.timers.tick(10_000)
  assert.equal(emotions[listening - 1], 'listening')
  assert.equal(emotions.length, listening, 'l’écoute n’est pas coupée par le délai de « + »')
  pipeline.stop()
})


test('programme d’écoute arrêté tout seul après avoir marché : « crashed » (relancé par main.ts), jamais un échec au démarrage', async () => {
  const { pipeline, voice } = await started()
  const crashes = []
  pipeline.on('crashed', () => crashes.push(1))
  voice.status = 'failed'
  voice.emit('status', { state: 'failed' })
  assert.equal(crashes.length, 0, 'jamais vu prêt : un échec au démarrage n’est pas relancé en boucle')
  voice.status = 'ready'
  voice.emit('status', { state: 'ready' })
  voice.status = 'failed'
  voice.emit('status', { state: 'failed' })
  assert.equal(crashes.length, 1)
  pipeline.stop()
  voice.emit('status', { state: 'failed' })
  assert.equal(crashes.length, 1, 'un arrêt voulu n’est pas un plantage')

  const main = (await import('node:fs')).readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const handler = main.slice(main.indexOf("pipeline.on('crashed'"), main.indexOf("pipeline.on('crashed'") + 600)
  assert.match(handler, /VOICE_RESTART_MIN_INTERVAL_MS/, 'au plus une relance par minute')
  assert.match(handler, /startVoicePipeline\(\)/)
})
