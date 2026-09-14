import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Reproduit en usage réel (Léo, "si on relance jarvis, on a plus rien dans le chat") : chatSession.ts
 * repartait toujours d'un fil vide au démarrage, même si conversation-history.json contenait déjà des
 * échanges (voix ET chat, voir étape 47). Vérifie que getVisibleMessages()/send() amorcent bien ce fil
 * depuis l'historique partagé, une seule fois, exactement comme conversationSession.ts le fait déjà pour
 * le contexte envoyé au modèle — mêmes mocks no-op qu'ailleurs pour les dépendances non testées ici.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/chatSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup(pastEntries) {
  const appended = []
  const calls = { converse: 0, vision: [] }
  const modules = {
    './assistant': {
      converse: async () => {
        calls.converse += 1
        return 'réponse test'
      }
    },
    // Étape 91 : une image jointe part au modèle de VISION, jamais au modèle de conversation (qui ne sait
    // pas lire une image, et ne tient de toute façon pas en VRAM en même temps que lui).
    '../config': { config: { ollama: { visionModel: 'vision-par-defaut' } } },
    './vision': {
      IMAGE_CHAT_SYSTEM_PROMPT: 'prompt-image-chat',
      describeImage: async (imageBase64, question, model, systemPrompt) => {
        calls.vision.push({ imageBase64, question, model, systemPrompt })
        return "C'est une photo de chat."
      }
    },
    './conversationStore': {
      getConversationHistory: async () => pastEntries,
      appendConversationEntry: async (entry) => { appended.push(entry) }
    },
    './conversationSession': {
      clearSessionHistory: () => {},
      getSessionHistory: async () => [],
      pushSessionExchange: () => {}
    },
    './memoryExtractor': { extractMemoryFromExchange: async () => {} },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null, tempC: null }) },
    './profileStore': { getProfile: async () => null },
    './resourceMonitor': { checkGpuTempSafety: () => ({ action: 'ok', message: '' }) }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name)
  })
  return { chatSession: exports.chatSession, appended, calls }
}

// Comparé via JSON.stringify plutôt que assert.deepEqual : les objets renvoyés par le module transpilé
// viennent d'un autre "royaume" JS (vm.runInNewContext, un Array/Object distinct de celui de ce fichier),
// ce qui fait échouer deepStrictEqual (utilisé par assert/strict) malgré un contenu visuellement identique.
test('getVisibleMessages() amorce le fil depuis conversation-history.json au premier appel', async () => {
  const { chatSession } = setup([
    { id: '1', timestamp: 't1', transcript: 'dit à voix haute plus tôt', reply: 'réponse vocale' }
  ])
  const messages = await chatSession.getVisibleMessages()
  assert.equal(
    JSON.stringify(messages),
    JSON.stringify([
      { role: 'user', content: 'dit à voix haute plus tôt' },
      { role: 'assistant', content: 'réponse vocale' }
    ])
  )
})

test("un nouveau message envoyé s'ajoute à la suite de l'historique restauré, pas à la place", async () => {
  const { chatSession, appended } = setup([{ id: '1', timestamp: 't1', transcript: 'ancien', reply: 'vieille réponse' }])
  await chatSession.send(
    'nouvelle question',
    () => {},
    () => {}
  )
  const messages = await chatSession.getVisibleMessages()
  assert.equal(
    JSON.stringify(messages),
    JSON.stringify([
      { role: 'user', content: 'ancien' },
      { role: 'assistant', content: 'vieille réponse' },
      { role: 'user', content: 'nouvelle question' },
      { role: 'assistant', content: 'réponse test' }
    ])
  )
  assert.equal(appended.length, 1)
})

test('un historique vide (premier lancement) donne un fil vide, pas une erreur', async () => {
  const { chatSession } = setup([])
  const messages = await chatSession.getVisibleMessages()
  assert.equal(messages.length, 0)
})

test("clear() vide le fil et n'est pas réamorcé automatiquement", async () => {
  const { chatSession } = setup([{ id: '1', timestamp: 't1', transcript: 'ancien', reply: 'vieille réponse' }])
  await chatSession.getVisibleMessages()
  chatSession.clear()
  const messages = await chatSession.getVisibleMessages()
  assert.equal(messages.length, 0)
})

/**
 * Étape 91 — image jointe. Le point à ne jamais casser : le modèle de CONVERSATION ne doit pas être appelé
 * du tout quand une image accompagne le message. Il ne sait pas lire une image, et charger les deux modèles
 * (conversation + vision) l'un après l'autre ferait un rechargement complet en VRAM pour rien — même
 * raisonnement que le court-circuit look_at_screen (assistant.ts).
 */
test('une image jointe part au modèle de vision, jamais au modèle de conversation', async () => {
  const { chatSession, calls, appended } = setup([])
  const reply = await chatSession.send(
    'Il y a quoi sur cette photo ?',
    () => {},
    () => {},
    undefined,
    undefined,
    'BASE64IMAGE'
  )

  assert.equal(calls.converse, 0, 'converse() ne doit pas être appelé quand une image est jointe')
  assert.equal(calls.vision.length, 1)
  assert.equal(calls.vision[0].imageBase64, 'BASE64IMAGE')
  assert.equal(calls.vision[0].question, 'Il y a quoi sur cette photo ?')
  assert.equal(calls.vision[0].systemPrompt, 'prompt-image-chat')
  assert.equal(reply.content, "C'est une photo de chat.")

  // L'échange rejoint l'historique sous forme de TEXTE : une question de suivi garde le contexte, sans que
  // conversation-history.json ne grossisse jamais de l'image elle-même.
  assert.equal(appended.length, 1)
  assert.equal(appended[0].transcript, 'Il y a quoi sur cette photo ?')
  assert.equal(appended[0].reply, "C'est une photo de chat.")
  assert.equal(JSON.stringify(appended[0]).includes('BASE64IMAGE'), false)
})

test('sans image, le modèle de conversation reste le chemin normal', async () => {
  const { chatSession, calls } = setup([])
  await chatSession.send('Bonjour', () => {}, () => {})
  assert.equal(calls.converse, 1)
  assert.equal(calls.vision.length, 0)
})

test('une image sans texte est acceptée : la question devient une demande de description', async () => {
  const { chatSession, calls } = setup([])
  await chatSession.send('', () => {}, () => {}, undefined, undefined, 'BASE64IMAGE')
  assert.equal(calls.vision[0].question, 'Décris cette image.')
})
