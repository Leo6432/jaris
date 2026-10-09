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
  const calls = { converse: 0, vision: [], exchanges: [] }
  const modules = {
    './assistant': {
      converse: async (prompt, ...rest) => {
        calls.converse += 1
        // Étape 173 : dernier argument = onImage, appelé quand generate_image a dessiné une image.
        // Étape 272 : une réponse longue, que le bouton « Arrêter » interrompt après un premier morceau.
        // rest[4] = signal, rest[7] = onToken (voir la signature de converse()).
        if (prompt.startsWith('longue')) {
          rest[7]?.('Bonjour, voici le début ')
          return new Promise((_resolve, reject) => {
            rest[4].addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
          })
        }
        // Certains outils RÉPONDENT au lieu d'échouer quand on les arrête (« Recherche annulée. », assistant.ts).
        if (prompt.startsWith('cherche')) {
          return new Promise((resolve) => rest[4].addEventListener('abort', () => resolve('Recherche annulée.')))
        }
        // Étape 273 : rest[11] = onWebActivity, appelé par l'outil search_web.
        if (prompt.startsWith('météo')) {
          rest[11]?.({ kind: 'search', query: 'météo Rennes', results: [{ title: 'Météo Rennes', url: 'https://meteofrance.com/rennes' }] })
          return 'Il fera 17 °C.'
        }
        if (prompt.startsWith('dessine')) {
          rest[9]({ path: '/donnees/generated-images/chat.png', fileName: 'chat.png' })
          return 'Voilà ton image.'
        }
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
      pushSessionExchange: (prompt, reply) => { calls.exchanges.push([prompt, reply]) }
    },
    './memoryExtractor': { extractMemoryFromExchange: async () => {} },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null, tempC: null }) },
    './profileStore': { getProfile: async () => null },
    './resourceMonitor': { checkGpuTempSafety: () => ({ action: 'ok', message: '' }) },
    './imageGenerator': {
      readGeneratedImageDataUrl: async (fileName) => (fileName === 'chat.png' ? 'data:image/png;base64,UE5H' : null)
    }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    // Étape 272 : le bouton « Arrêter » utilise AbortController, global de Node absent d'un contexte vm neuf.
    AbortController,
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

test('image dessinée (étape 173) : affichée sous la réponse, enregistrée par son NOM de fichier seulement', async () => {
  const { chatSession, appended } = setup([])
  const reply = await chatSession.send('dessine-moi un chat', () => {}, () => {})
  assert.equal(reply.content, 'Voilà ton image.')
  assert.equal(reply.image, 'data:image/png;base64,UE5H')
  assert.equal(appended[0].image, 'chat.png', 'le nom du fichier, jamais les octets de l’image')
})

test('image dessinée : réaffichée après un redémarrage, et absente sans erreur si le fichier a été effacé', async () => {
  const { chatSession } = setup([
    { id: '1', timestamp: 't1', transcript: 'dessine-moi un chat', reply: 'Voilà ton image.', image: 'chat.png' },
    { id: '2', timestamp: 't2', transcript: 'dessine-moi un chien', reply: 'Voilà ton image.', image: 'efface.png' }
  ])
  const messages = await chatSession.getVisibleMessages()
  assert.equal(messages[1].image, 'data:image/png;base64,UE5H')
  assert.equal(messages[3].image, undefined)
  assert.equal(messages[0].image, undefined, 'jamais sur le message de l’utilisateur')
})

// Bornés à 5 s : un arrêt qui ne marche plus ferait sinon attendre la réponse indéfiniment.
test('« Arrêter » (étape 272) : la réponse s’interrompt, le début déjà écrit est gardé, sans erreur', { timeout: 5000 }, async () => {
  const { chatSession, appended, calls } = setup([])
  const cues = []
  const tokens = []
  const pending = chatSession.send('longue histoire', () => {}, () => {}, (cue) => cues.push(cue), (t) => tokens.push(t))
  await new Promise((r) => setTimeout(r, 20))
  chatSession.cancel()
  const reply = await pending
  assert.equal(JSON.stringify(reply), JSON.stringify({ role: 'assistant', content: 'Bonjour, voici le début', stopped: true }))
  assert.equal(tokens.join(''), 'Bonjour, voici le début ', 'le texte en direct n’arrive plus à l’écran')
  assert.ok(!cues.includes('error'), 'son d’erreur pour un arrêt voulu')
  // Le début rejoint l'historique comme un échange normal : le modèle le voit au tour suivant.
  assert.equal(JSON.stringify(calls.exchanges), JSON.stringify([['longue histoire', 'Bonjour, voici le début']]))
  assert.equal(appended.length, 1)
  assert.equal(appended[0].reply, 'Bonjour, voici le début')
})

test('« Arrêter » avant tout texte : « Réponse arrêtée. », et rien d’enregistré', { timeout: 5000 }, async () => {
  const { chatSession, appended, calls } = setup([])
  const pending = chatSession.send('cherche le prix du pain', () => {}, () => {})
  await new Promise((r) => setTimeout(r, 20))
  chatSession.cancel()
  const reply = await pending
  // L'outil a « répondu » (Recherche annulée.) : c'est quand même un arrêt, pas une réponse à afficher.
  assert.equal(JSON.stringify(reply), JSON.stringify({ role: 'assistant', content: 'Réponse arrêtée.', stopped: true }))
  assert.equal(calls.exchanges.length, 0)
  assert.equal(appended.length, 0)
  // Le message suivant repart normalement (plus rien d'arrêté en mémoire).
  const next = await chatSession.send('bonjour', () => {}, () => {})
  assert.equal(next.content, 'réponse test')
})

test('recherches web (étape 273) : jointes à la réponse, relayées en direct, enregistrées et réaffichées', async () => {
  const { chatSession, appended } = setup([])
  const live = []
  const reply = await chatSession.send('météo demain', () => {}, () => {}, undefined, undefined, undefined, undefined, 'chat', (a) => live.push(a))
  const expected = [{ kind: 'search', query: 'météo Rennes', results: [{ title: 'Météo Rennes', url: 'https://meteofrance.com/rennes' }] }]
  assert.equal(JSON.stringify(live), JSON.stringify(expected), 'pas relayé en direct')
  assert.equal(JSON.stringify(reply.web), JSON.stringify(expected), 'pas joint à la réponse')
  assert.equal(JSON.stringify(appended[0].web), JSON.stringify(expected), 'pas enregistré')

  // Après un redémarrage, le bloc revient avec la réponse.
  const restarted = setup([{ id: '1', timestamp: 't', transcript: 'météo demain', reply: 'Il fera 17 °C.', web: expected }])
  const messages = await restarted.chatSession.getVisibleMessages()
  assert.equal(JSON.stringify(messages[1].web), JSON.stringify(expected))
  // Une réponse sans recherche n'a pas de bloc (pas de « web: [] » qui afficherait un bloc vide).
  const plain = await chatSession.send('bonjour', () => {}, () => {})
  assert.equal('web' in plain, false)
})
