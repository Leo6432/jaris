import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 328 : relancer le moteur vocal depuis Options (micro, mot d'activation) laissait deux défauts.
 * 1. Le nouveau moteur écoutait de nouveau le mot « Jaris » alors qu'on était dans Options, Chat ou Code.
 * 2. Deux relances rapprochées créaient deux moteurs : le premier n'était jamais arrêté, deux micros restaient ouverts.
 */

class FakeVoiceClient extends EventEmitter {
  static instances = []
  constructor() {
    super()
    this.started = 0
    this.stopped = 0
    this.paused = null
    FakeVoiceClient.instances.push(this)
  }
  start() {
    this.started++
    return Promise.resolve()
  }
  stop() {
    this.stopped++
  }
  setWakePaused(paused) {
    this.paused = paused
  }
  getStatus() {
    return { state: 'ready' }
  }
}

const noop = () => {}
const { VoicePipeline } = loadTsModule('electron/services/voicePipeline.ts', {
  events: { EventEmitter },
  crypto: { randomUUID: () => 'id' },
  './voiceClient': { VoiceClient: FakeVoiceClient, listeningUnavailableReason: () => null },
  './tts': { synthesizeSpeech: async () => null },
  './conversationStore': { appendConversationEntry: async () => {}, getActiveConversationId: async () => 'conv' },
  './assistant': { converse: async () => '' },
  './conversationSession': {
    VOICE_CONTEXT_MAX_AGE_MS: 1,
    clearSessionHistory: noop,
    getSessionHistory: async () => [],
    pushSessionExchange: noop
  },
  './memoryExtractor': { cancelMemoryExtraction: noop, extractMemoryFromExchange: noop },
  './profileStore': { getProfile: async () => null },
  './hardwareScan': { getLiveGpuStatus: async () => null },
  './resourceMonitor': { checkGpuTempSafety: () => null },
  './transcriptCorrector': { CORRECTION_SCHEMA: {}, correctTranscript: async (text) => text },
  './ollama': { structuredChat: async () => '' },
  '../config': { config: {} },
  './requestJournal': { appendJournal: noop, formatElapsed: () => '' },
  '../../shared/voiceActivity': { activityFromLog: () => null, formatActivity: () => '', thinkingActivity: () => '' }
})

test('un moteur arrêté avant son démarrage ne lance jamais son programme d’écoute', async () => {
  FakeVoiceClient.instances.length = 0
  const pipeline = new VoicePipeline()
  pipeline.stop()
  await pipeline.start()
  assert.equal(FakeVoiceClient.instances[0].started, 0, 'aucun micro ouvert par un moteur déjà remplacé')
})

test('un moteur jamais arrêté démarre normalement', async () => {
  FakeVoiceClient.instances.length = 0
  const pipeline = new VoicePipeline()
  await pipeline.start()
  assert.equal(FakeVoiceClient.instances[0].started, 1)
})

test('main.ts arrête le moteur remplacé et repose la pause d’écoute avant de démarrer le nouveau', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const start = main.indexOf('async function startVoicePipeline(')
  const body = main.slice(start, main.indexOf('\napp.whenReady()', start))
  const stopAt = body.indexOf('pipeline?.stop()')
  const createAt = body.indexOf('new VoicePipeline()')
  const pauseAt = body.indexOf('applyListeningForActiveMode()')
  const launchAt = body.indexOf('.start(profile?.audioInputDeviceIndex')
  assert.ok(stopAt >= 0 && stopAt < createAt, 'le moteur précédent est arrêté au moment où il est remplacé')
  assert.ok(createAt < pauseAt && pauseAt < launchAt, 'la pause d’écoute est posée avant le démarrage')
  assert.match(body, /if \(pipeline !== current\) return/, 'un moteur remplacé ne décide plus de l’état affiché')
})
