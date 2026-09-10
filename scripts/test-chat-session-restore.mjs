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
  const modules = {
    './assistant': { converse: async () => 'réponse test' },
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
  return { chatSession: exports.chatSession, appended }
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
