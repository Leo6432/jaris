import assert from 'node:assert/strict'
import test from 'node:test'
import * as scenarios from './benchmark-scenarios.mjs'
import * as cases from './benchmark-cases.mjs'
import * as duelTasks from './duel-agent-tasks.mjs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 504 (Léo : « on enlève la conversation et on fait un duel agentique », puis « oui, Discussion plus
 * Agentique ») : la tâche du duel Agentique est jouée sur le VRAI PC simulé du test des modèles
 * (benchmark-scenarios.mjs), avec un faux Ollama qui répond comme un modèle. Rien d'autre n'est simulé.
 */
let script = []
const sent = []
const duelAgent = loadTsModule('electron/services/duelAgent.ts', {
  '../../scripts/benchmark-scenarios.mjs': scenarios,
  '../../scripts/benchmark-cases.mjs': cases,
  '../../scripts/duel-agent-tasks.mjs': duelTasks,
  './ollama': {
    chatWithOllama: async (messages, tools, model, think) => {
      sent.push({ model, think, tools: tools?.map((t) => t.function.name) ?? null, last: messages.at(-1) })
      const step = script.shift()
      if (step instanceof Error) throw step
      if (!step) return { role: 'assistant', content: 'Voilà.' }
      return step.calls
        ? { role: 'assistant', content: '', tool_calls: step.calls.map(([name, args]) => ({ function: { name, arguments: args } })) }
        : { role: 'assistant', content: step.text }
    }
  }
})

const TASK = { id: 'spotify-volume', turns: ['Lance Spotify et monte le son.'], variant: 0 }
const run = async (steps, signal = new AbortController().signal) => {
  script = [...steps]
  sent.length = 0
  const log = []
  const outcome = await duelAgent.runAgentTask(TASK, 'petit:4b', false, signal, (step) => log.push(step))
  return { outcome, log }
}

test('une tâche réussie : chaque outil est montré avec son résultat simulé, puis la réponse ; le test dit « réussie »', async () => {
  const { outcome, log } = await run([
    { calls: [['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'volume_up' }]] },
    { text: 'C’est fait, Spotify est lancé et le son monte.' }
  ])
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.replies, ['C’est fait, Spotify est lancé et le son monte.'])
  const tools = log.filter((s) => s.kind === 'tool')
  assert.deepEqual(tools.map((s) => s.name), ['open_app', 'media_control'])
  assert.ok(tools.every((s) => typeof s.result === 'string' && s.result.length > 0), 'le résultat simulé est montré')
  assert.equal(log.at(-1).kind, 'reply')
  // Le modèle du duel reçoit les outils du test (ceux de Jaris), avec le niveau de réflexion du duel.
  assert.equal(sent[0].model, 'petit:4b')
  assert.equal(sent[0].think, false)
  // Tous les outils du test, même « éteindre le PC » : ici rien n'est réel (le simulateur note l'action).
  assert.ok(sent[0].tools.includes('open_app') && sent[0].tools.includes('shutdown_pc'))
  assert.equal(sent[0].last.role, 'user')
  // La demande du test (sa date est fixe : elle ne change jamais d'une demande à l'autre).
  assert.match(sent[0].last.content, /Lance Spotify et monte le son\.$/)
})

test('une tâche ratée (le son n’est jamais monté) : le test dit « ratée », la réponse reste montrée', async () => {
  const { outcome } = await run([{ calls: [['open_app', { app_name: 'Spotify' }]] }, { text: 'Spotify est lancé et le son est monté.' }, { text: 'Spotify est lancé.' }])
  assert.equal(outcome.ok, false)
  assert.ok(outcome.replies[0].length > 0)
})

test('Ollama en panne dès la première demande : la vraie erreur remonte (jamais « tâche ratée » en silence)', async () => {
  await assert.rejects(run([new Error('model requires more system memory (9.1 GiB) than is available')]), /more system memory/)
})

test('un modèle qui appelle des outils sans jamais répondre : tâche ratée, pas une erreur, ses actions restent', async () => {
  const loop = Array.from({ length: 40 }, () => ({ calls: [['open_app', { app_name: 'Spotify' }]] }))
  const { outcome, log } = await run(loop)
  assert.equal(outcome.ok, false)
  assert.ok(log.filter((s) => s.kind === 'tool').length >= 2)
})

test('le choix de la tâche : jamais les « merci », blagues ou heures ; d’abord celles pas encore jouées', () => {
  const ids = scenarios.SCENARIOS.map((s) => s.id)
  for (const id of ['merci', 'blague', 'heure']) assert.equal(duelAgent.agentTaskExists(id), false, id)
  assert.equal(duelAgent.agentTaskExists('spotify-volume'), true)
  assert.equal(duelAgent.agentTaskExists('inventee'), false)
  // Étape 506 : celles du test des modèles (sauf les trois écartées) ET les tâches propres au duel.
  const all = duelAgent.agentTaskChoices().map((c) => c.id)
  assert.deepEqual(all, [...ids.filter((id) => !['merci', 'blague', 'heure'].includes(id)), ...duelTasks.DUEL_AGENT_TASKS.map((t) => t.id)])
  assert.ok(all.length >= 60, `assez de tâches (${all.length})`)
  assert.ok(all.every((id) => duelAgent.agentTaskExists(id)))
  // Choisie par Léo : son identifiant ; inconnue = rien.
  assert.deepEqual(duelAgent.agentTaskById('duel-pause', () => 0), { id: 'duel-pause', turns: ['Mets la musique en pause.'], variant: 0 })
  assert.equal(duelAgent.agentTaskById('inventee'), null)
  // Tout est joué sauf une : c'est elle qui sort, quel que soit le hasard.
  const played = new Set(all.slice(1))
  for (const r of [0, 0.5, 0.999]) assert.equal(duelAgent.pickAgentTask(played, () => r).id, all[0])
  // Tout est joué : n'importe laquelle, jamais une des écartées.
  const any = duelAgent.pickAgentTask(new Set(all), () => 0.3)
  assert.ok(duelAgent.agentTaskExists(any.id))
  // Une tâche en deux messages (correction au deuxième) garde ses deux messages.
  const twoTurns = scenarios.SCENARIOS.find((s) => s.turns.length > 1 && duelAgent.agentTaskExists(s.id))
  const picked = duelAgent.pickAgentTask(new Set(all.filter((id) => id !== twoTurns.id)), () => 0)
  assert.deepEqual(picked.turns, twoTurns.turns)
})
