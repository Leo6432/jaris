import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 399 (Léo : « ma clé API Claude ; il pose la question, attend les deux réponses, vote A ou B ») : ce que Jaris
 * demande à Claude et ce qu'il fait de ses réponses — avec le VRAI kit Anthropic (ses vraies classes d'erreur) et un faux
 * appel réseau. Le vote reste mis de côté : ce module ne compte rien, il propose.
 */
const require = createRequire(import.meta.url)
const Anthropic = require('@anthropic-ai/sdk')
const judge = loadTsModule('electron/services/duelJudge.ts', {
  '@anthropic-ai/sdk': Anthropic,
  '../../shared/duel': loadTsModule('shared/duel.ts')
})
const claudeKey = loadTsModule('electron/services/claudeKey.ts', {
  electron: { safeStorage: {} },
  'fs/promises': {},
  path: { join: (...p) => p.join('/') },
  './dataLocation': { getDataRoot: () => '/donnees' }
})

/** Un faux client : garde chaque demande, rend `reply` (un objet Message) ou lève. */
function fake(reply) {
  const sent = []
  judge.setJudgeClientFactory((apiKey) => async (body, options) => {
    sent.push({ apiKey, body, signal: options?.signal })
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply(body) : reply
  })
  return sent
}
const message = (text, stop_reason = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason })
const side = (text, extra = {}) => ({ actions: [], toolLog: [], error: null, text, ...extra })

test('la question : Sonnet 5.5, sortie JSON imposée, outils de CE PC, sans répéter les demandes déjà posées', async () => {
  const sent = fake(message(JSON.stringify({ prompt: '  Quel temps fera-t-il demain à Lyon ?  ' })))
  const prompt = await judge.writeDuelQuestion(
    'sk-ant-cle',
    [{ name: 'search_web', description: 'Cherche sur internet' }],
    ['Ouvre le Bloc-notes', 'Rappelle-moi de boire']
  )
  assert.equal(prompt, 'Quel temps fera-t-il demain à Lyon ?')
  const { apiKey, body } = sent[0]
  assert.equal(apiKey, 'sk-ant-cle')
  assert.equal(body.model, 'claude-sonnet-5-5')
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.deepEqual(body.output_config.format.schema.required, ['prompt'])
  assert.equal(body.output_config.format.schema.additionalProperties, false)
  const system = body.system.map((block) => block.text).join('\n')
  assert.match(system, /search_web: Cherche sur internet/)
  assert.match(system, /in French/, 'la langue de Jaris')
  assert.match(system, /shut down/, 'jamais d’extinction du PC')
  // La notice qui explique Jaris est en tête, mise en cache (identique d'un duel à l'autre).
  assert.match(body.system[0].text, /# What Jaris is/)
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
  assert.match(body.messages[0].content, /- Ouvre le Bloc-notes\n- Rappelle-moi de boire/)
  // Aucun réglage refusé par Sonnet 5.5 (température, réflexion désactivée, budget de réflexion).
  assert.equal(body.temperature, undefined)
  assert.equal(body.thinking, undefined)
})

test('le vote : A/B anonymes, résultats des outils inclus, verdict et raison relus', async () => {
  const sent = fake(message(JSON.stringify({ winner: 'b', reason: 'B a vraiment programmé le rappel.' })))
  const verdict = await judge.judgeDuel('sk-ant-cle', {
    prompt: 'Rappelle-moi de sortir le chien dans 20 minutes',
    a: side('C’est noté !'),
    b: side('Rappel programmé.', {
      toolLog: ['Outil appelé : set_reminder({"delay_minutes":20})', "Résultat de l'outil : Rappel programmé dans 20 minutes."]
    }),
    tools: [{ name: 'set_reminder', description: 'Programme un rappel' }]
  })
  assert.deepEqual(verdict, { outcome: 'b', reason: 'B a vraiment programmé le rappel.' })
  // La même notice que pour la question : ce qu'est Jaris, ce que prouve chaque outil, les outils de ce PC.
  const system = sent[0].body.system.map((block) => block.text).join('\n')
  assert.match(system, /# What Jaris is/)
  assert.match(system, /open_app: "… a été lancé" means Windows received the launch request/)
  assert.match(system, /- set_reminder: Programme un rappel/)
  assert.equal(sent[0].body.messages[0].content.length, 1, 'sans captures : le texte seul')
  const content = sent[0].body.messages[0].content[0].text
  assert.match(content, /Request: Rappelle-moi de sortir le chien/)
  assert.match(content, /=== Assistant A ===\nTool calls: none\nFinal reply:\nC’est noté !/)
  assert.match(content, /Résultat de l'outil : Rappel programmé dans 20 minutes\./)
  assert.deepEqual(sent[0].body.output_config.format.schema.properties.winner.enum, ['a', 'b', 'tie', 'bothBad'])
  // Une réponse illisible ou hors des choix n'est jamais prise pour un vote.
  fake(message(JSON.stringify({ winner: 'c', reason: 'x' })))
  await assert.rejects(() => judge.judgeDuel('k', { prompt: 'p', a: side('a'), b: side('b'), tools: [] }), (err) => err.name === 'JudgeStopError')
  fake(message('pas du json'))
  await assert.rejects(() => judge.judgeDuel('k', { prompt: 'p', a: side('a'), b: side('b'), tools: [] }), (err) => err.name === 'JudgeStopError')
})

test('le vote avec l’écran : chaque capture est une vraie image, annoncée par son moment, une capture ratée est sautée', async () => {
  const sent = fake(message(JSON.stringify({ winner: 'a', reason: 'Le Bloc-notes est ouvert sur la capture après A.' })))
  await judge.judgeDuel('k', {
    prompt: 'Ouvre le Bloc-notes',
    a: side('C’est ouvert.'),
    b: side('C’est ouvert.'),
    tools: [],
    screens: { before: 'AAAA', afterA: null, afterB: 'CCCC' }
  })
  const content = sent[0].body.messages[0].content
  assert.deepEqual(
    content.slice(1).map((block) => (block.type === 'text' ? block.text : `${block.source.media_type}:${block.source.data}`)),
    ['Screenshot before A started:', 'image/jpeg:AAAA', 'Screenshot after B finished:', 'image/jpeg:CCCC']
  )
})

test('un refus de Claude passe CE duel ; une clé refusée, plus de crédit ou pas de réseau arrêtent avec un message clair', async () => {
  fake(message('', 'refusal'))
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err.name === 'JudgeRefusalError')
  const headers = new Headers()
  fake(new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', headers))
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err.name === 'JudgeStopError' && /clé API Claude est refusée/.test(err.message))
  fake(new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', headers))
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err.name === 'JudgeStopError' && /limite tes demandes/.test(err.message))
  fake(new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'Your credit balance is too low', headers))
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err.name === 'JudgeStopError' && /credit balance/.test(err.message))
  fake(new Anthropic.APIConnectionError({ message: 'Connection error.' }))
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err.name === 'JudgeStopError' && /joindre Anthropic/.test(err.message))
  // Une annulation (« Arrêter ») remonte telle quelle, jamais comme une panne.
  fake(new Anthropic.APIUserAbortError())
  await assert.rejects(() => judge.writeDuelQuestion('k', [], []), (err) => err instanceof Anthropic.APIUserAbortError)
})

test('la clé : seule une vraie clé Anthropic est acceptée, nettoyée de ses espaces', () => {
  assert.equal(claudeKey.cleanClaudeKey('  sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789  '), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
  assert.equal(claudeKey.cleanClaudeKey('sk-proj-abcdefghijklmnopqrstuvwxyz'), null)
  assert.equal(claudeKey.cleanClaudeKey('sk-ant-court'), null)
  assert.equal(claudeKey.cleanClaudeKey('sk-ant-abcdefghijklmnopqrstuvwxyz"; rm -rf /'), null)
  assert.equal(claudeKey.cleanClaudeKey(42), null)
})
