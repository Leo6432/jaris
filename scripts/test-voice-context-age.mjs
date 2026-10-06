import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 253 : à la voix, Jaris ne montre plus au modèle que les échanges récents. Journal de Léo : la recette de
 * tiramisu (18 h) revenait dans la réponse à « clique sur la vidéo » (21 h 34).
 */
function load(stored) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/conversationSession.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const modules = { './conversationStore': { getConversationHistory: async (limit) => stored.slice(-limit) } }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, (name) => modules[name] ?? {}, module)
  return module.exports
}
const at = (h, m) => new Date(2026, 9, 6, h, m).getTime()
const entry = (h, m, transcript, reply) => ({ id: `${h}${m}`, timestamp: new Date(at(h, m)).toISOString(), transcript, reply })

test('voix : un échange d’il y a 3 h (rechargé du disque) n’est plus montré au modèle ; le Chat garde tout', async () => {
  const session = load([entry(18, 0, 'Cherche une recette de tiramisu', 'Voici une recette…')])
  const now = at(21, 34)
  assert.deepEqual(await session.getSessionHistory({ maxAgeMs: session.VOICE_CONTEXT_MAX_AGE_MS, now }), [])
  const chat = await session.getSessionHistory()
  assert.equal(chat.length, 2, 'le Chat montre son fil : rien n’est retiré')
  assert.equal(chat[0].content, 'Cherche une recette de tiramisu')
})

test('voix : une suite rapprochée garde son contexte (« et demain ? » doit comprendre « météo »)', async () => {
  const session = load([entry(18, 0, 'Recette de tiramisu', 'Voici…')])
  await session.getSessionHistory() // comme chaque tour : l'historique est lu avant d'ajouter l'échange
  session.pushSessionExchange('Quel temps fait-il ?', 'Beau.', at(21, 30))
  const history = await session.getSessionHistory({ maxAgeMs: session.VOICE_CONTEXT_MAX_AGE_MS, now: at(21, 34) })
  assert.deepEqual(history.map((m) => m.content), ['Quel temps fait-il ?', 'Beau.'])
  assert.equal(session.VOICE_CONTEXT_MAX_AGE_MS, 10 * 60 * 1000)
})

test('toujours 6 échanges au plus, comme avant', async () => {
  const session = load([])
  await session.getSessionHistory()
  for (let i = 0; i < 9; i++) session.pushSessionExchange(`q${i}`, `r${i}`, at(21, i))
  const history = await session.getSessionHistory()
  assert.equal(history.length, 12)
  assert.equal(history[0].content, 'q3')
})

test('le pipeline vocal demande bien les seuls échanges récents', () => {
  const source = readFileSync(new URL('../electron/services/voicePipeline.ts', import.meta.url), 'utf8')
  assert.match(source, /getSessionHistory\(\{ maxAgeMs: VOICE_CONTEXT_MAX_AGE_MS \}\)/)
})
