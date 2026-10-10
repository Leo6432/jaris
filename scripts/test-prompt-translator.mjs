import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 292 (Léo : « je lui ai envoyé "chat" comme prompt, voici ce qu'il m'a fait » — un homme souriant à un bureau).
 * Le modèle de dessin lit l'anglais : « un chat » y devenait « a chat », une conversation. Les demandes tapées dans les
 * modes Image et Vidéo (et depuis le téléphone) sont traduites par le modèle rapide avant le dessin.
 *
 * Vérifié aussi pour de vrai, hors de ce test, avec qwen3:1.7b (un des modèles rapides de Jaris) : « un chat » → a cat,
 * « chat » → a cat, « un chat noir sur un canapé » → a black cat on a couch, « un coin de rue à Paris la nuit » → a street
 * corner in Paris at night, « a red car in the rain » recopié tel quel.
 */
const translator = loadTsModule('electron/services/promptTranslator.ts', {
  '../config': { config: { ollama: { model: 'modele-par-defaut' } } },
  './ollama': { chatWithOllama: async () => ({ content: '' }) },
  './profileStore': { getProfile: async () => null }
})
const { toEnglishPrompt, cleanTranslation, TRANSLATE_SYSTEM_PROMPT } = translator

function fakeModel(answer) {
  const calls = []
  return {
    calls,
    deps: {
      model: async () => 'qwen3:1.7b',
      chat: async (messages, model) => {
        calls.push({ messages, model })
        if (answer instanceof Error) throw answer
        return answer
      }
    }
  }
}

test('« un chat » part au modèle rapide avec la consigne, et revient en anglais', async () => {
  const m = fakeModel('a cat')
  assert.deepEqual(await toEnglishPrompt('un chat', m.deps), { text: 'a cat', translated: true })
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].model, 'qwen3:1.7b')
  assert.deepEqual(m.calls[0].messages.map((message) => message.role), ['system', 'user'])
  assert.equal(m.calls[0].messages[1].content, 'un chat')
})

test('la consigne nomme le faux ami « chat » et interdit d’inventer', () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /« chat » = cat/)
  assert.match(TRANSLATE_SYSTEM_PROMPT, /n'ajoute aucun détail/)
  assert.match(TRANSLATE_SYSTEM_PROMPT, /déjà en anglais, recopie-la/)
})

test('ce qu’un petit modèle ajoute malgré la consigne est retiré', () => {
  assert.equal(cleanTranslation('Translation: "a cat"', 'un chat'), 'a cat')
  assert.equal(cleanTranslation('<think>chat = cat</think>\n\n« a black cat »\nNote: literal translation.', 'un chat noir'), 'a black cat')
  assert.equal(cleanTranslation('   ', 'un chat'), null)
  // Un modèle qui se met à raconter : mieux vaut dessiner la demande telle quelle qu'une invention.
  assert.equal(cleanTranslation('a cat '.repeat(60), 'un chat'), null)
})

test('Ollama arrêté ou réponse vide : la demande part telle quelle, le dessin n’est jamais bloqué', async () => {
  assert.deepEqual(await toEnglishPrompt('un chat', fakeModel(new Error('Ollama injoignable')).deps), { text: 'un chat', translated: false })
  assert.deepEqual(await toEnglishPrompt('un chat', fakeModel('').deps), { text: 'un chat', translated: false })
})

test('branché sur les demandes TAPÉES (Image, Vidéo, téléphone), pas sur l’outil du Chat qui écrit déjà en anglais', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const studioImage = main.slice(main.indexOf('IPC_CHANNELS.generateStudioImage'), main.indexOf('IPC_CHANNELS.cancelStudioImage'))
  const studioVideo = main.slice(main.indexOf('IPC_CHANNELS.generateStudioVideo,'), main.indexOf('IPC_CHANNELS.cancelStudioVideo'))
  const phone = main.slice(main.indexOf('generateImage: async (prompt, onStatus, signal)'), main.indexOf('listImages:'))
  for (const [name, block] of [['mode Image', studioImage], ['mode Vidéo', studioVideo], ['téléphone', phone]]) {
    assert.match(block, /toEnglishPrompt/, `${name} : la demande n'est pas traduite`)
  }
  assert.equal((phone.match(/toEnglishPrompt/g) ?? []).length, 2, 'téléphone : image ET vidéo')
  const tools = readFileSync(new URL('../electron/services/tools.ts', import.meta.url), 'utf8')
  assert.match(tools, /generateImage\(String\(args\.prompt \?\? ''\), onLog, signal\)/)
})
