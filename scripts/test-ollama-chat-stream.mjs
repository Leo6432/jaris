import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 346 — « réponse très longue : au bout de 10 minutes, Jaris dit à tort qu'Ollama n'est pas lancé ». Sans flux,
 * Ollama ne répond qu'à la fin ; Node coupe une réponse muette au bout de 5 minutes, et le second essai « sans
 * réflexion » refaisait attendre 5 minutes. Toute erreur de connexion devenait « Ollama n'est pas lancé ».
 */
const calls = []
let respond = async () => new Response('{}', { status: 200 })
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
  return respond(String(url), init)
}
test.after(() => {
  globalThis.fetch = realFetch
})

const ollama = loadTsModule('electron/services/ollama.ts', {
  '../config': { config: { ollama: { host: 'http://ollama.test', model: 'modele-defaut', numCtx: 8192 } } },
  '../../shared/effort': { parseModelThinking: () => null },
  './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => null, getDownloadBudgetGb: async () => null },
  './huggingFaceImport': { importHuggingFaceModel: async () => undefined }
})

const ndjson = (lines, { trailingNewline = true } = {}) => lines.map((line) => JSON.stringify(line)).join('\n') + (trailingNewline ? '\n' : '')
const chats = () => calls.filter((call) => call.url.endsWith('/api/chat'))
const noShow = (url) => url.endsWith('/api/show') && new Response('{}', { status: 200 })

test('voix et mémoire (aucun relais) : demandé en flux, réponse entière et réflexion jointe comme avant', async () => {
  calls.length = 0
  respond = async (url) =>
    noShow(url) ||
    new Response(
      ndjson([
        { message: { role: 'assistant', content: '', thinking: 'Je réfléchis' } },
        { message: { role: 'assistant', content: 'Bon' } },
        { message: { role: 'assistant', content: 'jour.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 3 }
      ]),
      { status: 200 }
    )
  const message = await ollama.chatWithOllama([{ role: 'user', content: 'salut' }], undefined, 'qwen3.5:4b', 'low')
  assert.equal(chats()[0].body.stream, true, 'toujours en flux : la connexion n’est jamais muette')
  assert.equal(message.content, 'Bonjour.')
  assert.equal(message.thinking, 'Je réfléchis', 'la réflexion reste jointe (canal voix, étape 233)')
})

test('une dernière ligne sans retour à la ligne n’est jamais perdue', async () => {
  respond = async (url) => noShow(url) || new Response(ndjson([{ message: { role: 'assistant', content: 'ok' }, done: true }], { trailingNewline: false }), { status: 200 })
  assert.equal((await ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3.5:4b', 'low')).content, 'ok')
})

const fetchFailure = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

test('délai dépassé : « trop lent sur ce PC », jamais « pas lancé », et pas de second essai qui refait attendre', async () => {
  calls.length = 0
  respond = async (url) => {
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 })
    throw fetchFailure('UND_ERR_HEADERS_TIMEOUT')
  }
  await assert.rejects(ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3.5:4b', 'low'), (err) => {
    assert.equal(err.name, 'OllamaTooSlowError')
    assert.match(err.message, /trop longtemps/)
    assert.doesNotMatch(err.message, /pas lancé/)
    return true
  })
  assert.equal(chats().length, 1, 'aucun second essai « sans réflexion » après un délai')
})

test('rien n’écoute : « pas lancé » ; connexion coupée en route : le dit, sans prétendre qu’Ollama est arrêté', async () => {
  respond = async (url) => {
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 })
    throw fetchFailure('ECONNREFUSED')
  }
  await assert.rejects(ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'm', 'low'), /pas lancé/)

  respond = async (url) => {
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: 'assistant', content: 'Début' } })}\n`))
        controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }))
      }
    })
    return new Response(body, { status: 200 })
  }
  await assert.rejects(ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'm', 'low'), (err) => {
    assert.match(err.message, /coupée en pleine réponse/)
    assert.doesNotMatch(err.message, /pas lancé/)
    return true
  })
})

test('une annulation demandée repart telle quelle', async () => {
  const controller = new AbortController()
  respond = async (url, init) => {
    if (url.endsWith('/api/show')) return new Response('{}', { status: 200 })
    controller.abort()
    init.signal.throwIfAborted()
    return new Response('{}')
  }
  await assert.rejects(ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'm', 'low', controller.signal), { name: 'AbortError' })
})
