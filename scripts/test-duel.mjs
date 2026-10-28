import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 355 — le Duel (Léo : « deux modèles anonymes, on vote, à la place d'Artificial Analysis »). Le module PUR
 * shared/duel.ts : lecture des votes, classement, choix des modèles d'une session, ordre des duels, et lecture des
 * actions faites sur le PC dans le journal.
 */
const duel = loadTsModule('shared/duel.ts')

let nextId = 0
const vote = (modelA, modelB, outcome, category = 'conversation') => ({
  id: `v${nextId++}`,
  category,
  at: nextId,
  sessionId: 's1',
  modelA,
  modelB,
  outcome,
  prompt: 'Ouvre le Bloc-notes'
})
const PRIORS = { strong: 30, weak: 10, mid: 20 }
const prior = (model) => PRIORS[model] ?? null

test('lecture des votes : un vote abîmé est écarté, jamais tout le fichier', () => {
  const good = vote('a', 'b', 'a')
  assert.deepEqual(duel.parseDuelVotes([good, { ...good, id: '' }, { ...good, outcome: 'nul' }, { ...good, modelB: 'a' }, null, 'texte']), [good])
  assert.equal(duel.parseDuelVotes({ votes: [] }), null, 'pas une liste : le fichier entier est illisible')
  assert.equal(duel.parseDuelVote({ ...good, category: 'image' }), null, 'pas de duel d’images')
  // Champs facultatifs absents (fichier d'une autre version) : le vote reste lisible.
  const { sessionId: _s, prompt: _p, ...minimal } = good
  assert.deepEqual(duel.parseDuelVote(minimal), { ...good, sessionId: '', prompt: '' })
})

test('classement : jamais un seul vote, mais des victoires constantes finissent par décider (le tableau de shared/duel.ts)', () => {
  // Le tableau écrit dans shared/duel.ts (PRIOR_SIGMA_KNOWN = 0,5) : vérifié ici, pas seulement affirmé.
  const flipsAfter = (ratio) => {
    for (let n = 1; n <= 20; n++) {
      const votes = Array.from({ length: n }, () => vote('weak', 'strong', 'a'))
      const standings = duel.rankDuels(votes, (model) => (model === 'strong' ? 10 * ratio : 10))
      if (standings.get('weak').strength > standings.get('strong').strength) return n
    }
    return null
  }
  assert.deepEqual([1.5, 2, 3].map(flipsAfter), [2, 3, 5])
  // Un seul vote ne renverse rien, mais fait déjà monter le gagnant.
  const one = duel.rankDuels([vote('weak', 'strong', 'a')], prior)
  assert.ok(one.get('weak').strength > PRIORS.weak && one.get('weak').strength < one.get('strong').strength)
  // Avec beaucoup de votes, ce sont les votes qui décident, plus Artificial Analysis.
  const many = duel.rankDuels(Array.from({ length: 30 }, () => vote('weak', 'strong', 'a')), prior)
  assert.ok(many.get('weak').strength > 3 * many.get('strong').strength)
})

test('classement : le même ensemble de votes donne le même résultat dans n’importe quel ordre (pas un Elo)', () => {
  const votes = [vote('weak', 'strong', 'a'), vote('mid', 'strong', 'b'), vote('weak', 'mid', 'tie'), vote('strong', 'weak', 'bothBad'), vote('mid', 'weak', 'a')]
  const forward = duel.rankDuels(votes, prior)
  const backward = duel.rankDuels([...votes].reverse(), prior)
  for (const model of ['weak', 'mid', 'strong']) {
    assert.ok(Math.abs(forward.get(model).strength - backward.get(model).strength) < 1e-6, `${model} dépend de l’ordre des votes`)
  }
})

test('classement : victoires, défaites et égalités comptées ; « les deux sont nuls » compte comme une égalité', () => {
  const standings = duel.rankDuels([vote('weak', 'strong', 'a'), vote('strong', 'weak', 'a'), vote('weak', 'strong', 'tie'), vote('weak', 'strong', 'bothBad')], prior)
  assert.deepEqual(
    { ...standings.get('weak'), strength: undefined },
    { model: 'weak', strength: undefined, wins: 1, losses: 1, ties: 2, duels: 4 }
  )
  assert.equal(duel.scoreOfA('bothBad'), 0.5)
  // Sans aucun vote : rien n'est classé (les modèles gardent leur note d'Artificial Analysis).
  assert.equal(duel.rankDuels([], prior).size, 0)
})

test('classement : un modèle sans note publiée part de la moyenne des modèles votés, et ses votes lui en donnent une', () => {
  const standings = duel.rankDuels([vote('inconnu', 'weak', 'a'), vote('inconnu', 'strong', 'a')], prior)
  const inconnu = standings.get('inconnu').strength
  assert.ok(Number.isFinite(inconnu) && inconnu > 0)
  assert.ok(inconnu > standings.get('weak').strength, 'il a gagné ses deux duels')
  // Aucun modèle voté n'a de note : un départ neutre, et le gagnant passe quand même devant.
  const blind = duel.rankDuels([vote('x', 'y', 'a')], () => null)
  assert.ok(blind.get('x').strength > blind.get('y').strength)
})

test('session : les modèles déjà utilisés par Jaris d’abord, puis les moins essayés ; toujours les mêmes pour les mêmes données', () => {
  const candidates = [
    { model: 'utilise-faible', vramGb: 3, note: 5, duels: 9, inUse: true },
    { model: 'utilise-fort', vramGb: 6, note: 9, duels: 9, inUse: true },
    { model: 'neuf-moyen', vramGb: 4, note: 6, duels: 0, inUse: false },
    { model: 'neuf-fort', vramGb: 5, note: 8, duels: 0, inUse: false },
    { model: 'deja-vu', vramGb: 2, note: 12, duels: 4, inUse: false },
    { model: 'sans-note', vramGb: 2, note: null, duels: 0, inUse: false }
  ]
  assert.deepEqual(duel.selectDuelModels(candidates, 4), ['utilise-fort', 'utilise-faible', 'neuf-fort', 'neuf-moyen'])
  assert.deepEqual(duel.selectDuelModels([...candidates].reverse(), 4), ['utilise-fort', 'utilise-faible', 'neuf-fort', 'neuf-moyen'])
  assert.deepEqual(duel.selectDuelModels(candidates, 6).slice(4), ['sans-note', 'deja-vu'], 'sans note : après les notés, à duels égaux')
  assert.equal(duel.selectDuelModels(candidates, 10).length, 6, 'jamais plus que les candidats')
})

test('session : des challengers des deux côtés — qui tiennent sur la carte (Faible, Moyen) et qui débordent (Élevé)', () => {
  // La machine de Léo (8 Go) : sans les groupes, une session de 5 ne prenait que des modèles de 27 milliards de
  // paramètres (mieux notés), aucun challenger pour Faible et Moyen.
  const candidates = [
    { model: 'utilise-gros', vramGb: 17.7, note: 13.9, duels: 0, inUse: true, group: 'ram' },
    { model: 'utilise-petit', vramGb: 5.6, note: 5.7, duels: 0, inUse: true, group: 'card' },
    { model: 'gros-1', vramGb: 17.8, note: 8.6, duels: 0, inUse: false, group: 'ram' },
    { model: 'gros-2', vramGb: 17.5, note: 6.4, duels: 0, inUse: false, group: 'ram' },
    { model: 'gros-3', vramGb: 22.6, note: 5.4, duels: 0, inUse: false, group: 'ram' },
    { model: 'petit-1', vramGb: 6.6, note: 3.2, duels: 0, inUse: false, group: 'card' },
    { model: 'petit-2', vramGb: 3.2, note: 3.1, duels: 0, inUse: false, group: 'card' }
  ]
  assert.deepEqual(duel.selectDuelModels(candidates, 4), ['utilise-gros', 'utilise-petit', 'gros-1', 'petit-1'])
  assert.deepEqual(duel.selectDuelModels(candidates, 6), ['utilise-gros', 'utilise-petit', 'gros-1', 'petit-1', 'gros-2', 'petit-2'])
  // Un groupe épuisé : l'autre continue seul.
  assert.deepEqual(duel.selectDuelModels(candidates.filter((c) => c.model !== 'petit-2'), 7).slice(-2), ['gros-2', 'gros-3'])
})

test('ordre des duels : toutes les paires passent avant qu’une revienne, jamais deux fois de suite, A/B au hasard', () => {
  const models = ['m1', 'm2', 'm3', 'm4']
  const played = new Map()
  let last = null
  const seen = []
  let seed = 7
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  const sideA = new Map()
  for (let round = 0; round < 12; round++) {
    const pair = duel.nextDuelPair(models, played, last, random)
    const key = duel.pairKey(pair[0], pair[1])
    if (last) assert.notEqual(key, duel.pairKey(last[0], last[1]), 'la même paire deux fois de suite')
    played.set(key, (played.get(key) ?? 0) + 1)
    sideA.set(pair[0], (sideA.get(pair[0]) ?? 0) + 1)
    seen.push(key)
    last = pair
  }
  // 4 modèles = 6 paires : les 6 premières sont toutes différentes, puis chacune revient une fois.
  assert.equal(new Set(seen.slice(0, 6)).size, 6)
  assert.ok([...played.values()].every((n) => n === 2))
  assert.ok(sideA.size >= 3, 'un modèle n’est pas toujours « A »')
  assert.equal(duel.nextDuelPair(['seul'], new Map(), null), null)
  // Deux modèles : la seule paire revient forcément, sans boucle infinie.
  assert.equal(duel.pairKey(...duel.nextDuelPair(['x', 'y'], new Map([[duel.pairKey('x', 'y'), 3]]), ['x', 'y'])), duel.pairKey('x', 'y'))
})

test('actions sur le PC : lues dans la ligne du journal, avec ce qu’il faut vérifier', () => {
  // Le format exact écrit par assistant.ts (« Outil appelé : nom(arguments JSON) »).
  const line = (tool, args) => `Outil appelé : ${tool}(${JSON.stringify(args)})`
  assert.deepEqual(duel.duelActionFromLog(line('open_app', { app_name: 'Bloc-notes' })), { tool: 'open_app', detail: 'Bloc-notes' })
  assert.deepEqual(duel.duelActionFromLog(line('set_reminder', { delay_minutes: 10, message: 'Sortir le linge' })), { tool: 'set_reminder', detail: 'Sortir le linge' })
  assert.deepEqual(duel.duelActionFromLog(line('get_system_stats', {})), { tool: 'get_system_stats', detail: null })
  const long = duel.duelActionFromLog(line('type_text', { text: 'x'.repeat(300) }))
  assert.equal(long.detail.length, 80)
  assert.ok(long.detail.endsWith('…'))
  assert.deepEqual(duel.duelActionFromLog('Outil appelé : open_app({pas du json)'), { tool: 'open_app', detail: null })
  assert.equal(duel.duelActionFromLog("Résultat de l'outil : L'application a été lancée."), null)
  assert.equal(duel.duelActionFromLog('Modèle choisi : granite4.2:8b'), null)
})

test('la ligne du journal lue par le Duel est bien celle qu’écrit assistant.ts', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../electron/services/assistant.ts', import.meta.url), 'utf8')
  assert.match(source, /onLog\?\.\(`Outil appelé : \$\{call\.function\.name\}\(\$\{JSON\.stringify\(call\.function\.arguments\)\}\)`\)/)
})
