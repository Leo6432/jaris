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
const { toEnglishPrompt, cleanTranslation, translateWithOllama, firstLineComplete, TRANSLATE_SYSTEM_PROMPT, TRANSLATE_IDLE_MS } = translator

function fakeModel(answer) {
  const calls = []
  return {
    calls,
    deps: {
      model: async () => 'qwen3:1.7b',
      chat: async (messages, model, signal) => {
        calls.push({ messages, model, signal })
        if (answer instanceof Error) throw answer
        return answer
      }
    }
  }
}

test('« un chat » part au modèle rapide avec la consigne, et revient en anglais', async () => {
  const m = fakeModel('a cat')
  assert.deepEqual(await toEnglishPrompt('un chat', undefined, m.deps), { text: 'a cat', translated: true })
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
  assert.deepEqual(await toEnglishPrompt('un chat', undefined, fakeModel(new Error('Ollama injoignable')).deps), { text: 'un chat', translated: false })
  assert.deepEqual(await toEnglishPrompt('un chat', undefined, fakeModel('').deps), { text: 'un chat', translated: false })
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

// Étape 293 (24 langues) : Léo — « par exemple image il doit pas traduire en français ». La demande arrive dans la
// langue choisie dans Jaris, et part TOUJOURS vers l'anglais : jamais vers la langue de l'interface.
test('une demande écrite dans n’importe quelle langue part vers l’anglais, jamais vers la langue de Jaris', async () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /n'importe quelle langue/)
  assert.match(TRANSLATE_SYSTEM_PROMPT, /jamais vers une autre langue/)
  for (const [request, english] of [['ein Hund im Schnee', 'a dog in the snow'], ['кот на диване', 'a cat on a sofa']]) {
    const m = fakeModel(english)
    assert.deepEqual(await toEnglishPrompt(request, undefined, m.deps), { text: english, translated: true })
    assert.equal(m.calls[0].messages[1].content, request)
    assert.equal(m.calls[0].messages[0].content, TRANSLATE_SYSTEM_PROMPT)
  }
  // La consigne ne dépend pas de la langue de l'interface : aucune règle « réponds en <langue> » n'y est ajoutée.
  const source = readFileSync(new URL('../electron/services/promptTranslator.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /replyLanguage|currentLanguage/)
})

/**
 * Relecture croisée : la traduction demandait une fenêtre FIXE de 2048 au modèle rapide (Ollama le rechargeait, puis de
 * nouveau à la question suivante), avec une limite de 60 s au TOTAL, et « Arrêter » ne l'arrêtait pas.
 */
function fakeOllama(script) {
  const calls = []
  const request = (messages, tools, model, think, signal, numCtx, onToken, onThinking) => {
    calls.push({ model, think, numCtx, signal })
    return script({ signal, onToken, onThinking })
  }
  return { calls, request }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const abortable = (signal) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
  })
const messages = [{ role: 'system', content: TRANSLATE_SYSTEM_PROMPT }, { role: 'user', content: 'un chat' }]

test('traduction : fenêtre automatique (la même que les autres demandes), sans réflexion', async () => {
  const ollama = fakeOllama(async ({ onToken }) => {
    onToken('a cat')
    return { role: 'assistant', content: 'a cat' }
  })
  assert.equal(await translateWithOllama(messages, 'qwen3:1.7b', undefined, ollama.request), 'a cat')
  assert.equal(ollama.calls[0].numCtx, undefined, 'fenêtre fixe : Ollama recharge le modèle rapide')
  assert.equal(ollama.calls[0].think, false)
  assert.equal(TRANSLATE_IDLE_MS, 60_000)
})

test('traduction : surveillée par inactivité — longue mais vivante, elle va au bout ; muette, elle est abandonnée', async () => {
  // 300 ms au total, un fragment toutes les 20 ms : jamais coupée par une limite d'inactivité de 80 ms.
  const lively = fakeOllama(async ({ signal, onToken }) => {
    for (let i = 0; i < 15; i++) {
      await sleep(20)
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      onToken(i === 0 ? 'a' : ' cat')
    }
    return { role: 'assistant', content: 'a cat cat' }
  })
  assert.equal(await translateWithOllama(messages, 'm', undefined, lively.request, 80), 'a cat cat')

  const silent = fakeOllama(({ signal }) => abortable(signal))
  const started = Date.now()
  await assert.rejects(translateWithOllama(messages, 'm', undefined, silent.request, 80), /aborted/)
  assert.ok(Date.now() - started < 2000)
  // toEnglishPrompt n'est jamais bloqué : la demande part telle quelle.
  assert.deepEqual(
    await toEnglishPrompt('un chat', undefined, { model: async () => 'm', chat: (msgs, model, signal) => translateWithOllama(msgs, model, signal, silent.request, 50) }),
    { text: 'un chat', translated: false }
  )
})

test('traduction : « Arrêter » l’arrête tout de suite ; une première ligne complète suffit', async () => {
  const controller = new AbortController()
  const hanging = fakeOllama(({ signal }) => abortable(signal))
  const pending = translateWithOllama(messages, 'm', controller.signal, hanging.request, 60_000)
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(hanging.calls[0].signal.aborted, true, 'la demande à Ollama continue après « Arrêter »')

  // Un petit modèle qui se met à raconter sans fin : la première ligne est gardée, la suite n'est pas attendue.
  const chatty = fakeOllama(async ({ signal, onToken }) => {
    onToken('a cat\nNote: ')
    for (;;) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      onToken('blabla ')
      await sleep(5)
    }
  })
  assert.equal(cleanTranslation(await translateWithOllama(messages, 'm', undefined, chatty.request, 60_000), 'un chat'), 'a cat')
  assert.equal(firstLineComplete('<think>chat = cat\n'), false, 'une réflexion écrite dans la réponse n’est pas une traduction')
  assert.equal(firstLineComplete('<think>x</think>\n\na cat\n'), true)
})

test('le signal d’arrêt du dessin arrive jusqu’à la traduction (image et vidéo)', async () => {
  const controller = new AbortController()
  const m = fakeModel('a cat')
  await toEnglishPrompt('un chat', controller.signal, m.deps)
  assert.equal(m.calls[0].signal, controller.signal)
  const image = readFileSync(new URL('../electron/services/imageGenerator.ts', import.meta.url), 'utf8')
  const video = readFileSync(new URL('../electron/services/videoGenerator.ts', import.meta.url), 'utf8')
  assert.match(image, /const result = await translate\(text, signal\)/)
  for (const source of [image, video]) assert.match(source, /drawingPrompt\(text, onLog, translate, signal\)/)
})
