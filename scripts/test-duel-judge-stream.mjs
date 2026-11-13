import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 477 (Léo : « pouvoir choisir le modèle et l'effort ») : aux efforts « très élevé » et « maximum », la réflexion
 * de Claude peut dépasser 16 000 jetons ; une demande aussi longue doit partir EN FLUX, sinon le kit Anthropic risque
 * l'expiration. Ce test garde le VRAI client de duelJudge.ts (pas de faux client) et le fait parler à un faux serveur
 * Anthropic local (ANTHROPIC_BASE_URL, lu par le kit) : il vérifie ce qui part vraiment sur le réseau, et que la réponse
 * diffusée est bien réassemblée.
 */
const require = createRequire(import.meta.url)
const Anthropic = require('@anthropic-ai/sdk')

function sse(events) {
  return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('')
}

test('l’avis du Duel Vision part en flux, avec le modèle et l’effort choisis, et la réponse diffusée est relue', async () => {
  const received = []
  const verdict = JSON.stringify({ winner: 'tie', reason: 'Les deux décrivent bien le chat.' })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        sse([
          ['message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          // La réponse arrive en deux morceaux : elle doit être recollée avant d'être lue.
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: verdict.slice(0, 20) } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: verdict.slice(20) } }],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } }],
          ['message_stop', {}]
        ])
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const before = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
  try {
    const judge = loadTsModule('electron/services/duelJudge.ts', { '@anthropic-ai/sdk': Anthropic, '../../shared/duel': loadTsModule('shared/duel.ts') })
    const advice = await judge.adviseVisionDuel('sk-ant-test', { image: '/9j/AAAA', a: 'Un chat.', b: 'Un chat roux.', model: 'claude-opus-5-5', effort: 'max' })
    assert.deepEqual(advice, { outcome: 'tie', reason: 'Les deux décrivent bien le chat.' })
    assert.equal(received.length, 1)
    const { url, headers, body } = received[0]
    assert.equal(url, '/v1/messages')
    // La clé de Léo part avec la demande (le kit 1.3 la met dans Authorization, les plus anciens dans x-api-key).
    assert.ok(headers.authorization === 'Bearer sk-ant-test' || headers['x-api-key'] === 'sk-ant-test')
    assert.equal(body.stream, true, 'en flux : une longue réflexion ne fait pas expirer la demande')
    assert.equal(body.model, 'claude-opus-5-5')
    assert.equal(body.output_config.effort, 'max')
    assert.equal(body.max_tokens, 64000)
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = before
    server.close()
  }
})
