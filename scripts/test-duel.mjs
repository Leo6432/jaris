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
test('classement façon Arena (étape 358) : tout part de 0, un vote suffit à départager, la marge dit combien c’est sûr', () => {
  // Un seul vote : le gagnant passe devant, mais la marge est large et les rangs restent ouverts (1 à 2).
  const one = duel.rankDuels([vote('a', 'b', 'a')])
  assert.ok(one.get('a').score > 0 && one.get('b').score < 0)
  assert.ok(Math.abs(one.get('a').score + one.get('b').score) < 1e-6, 'centré sur 0')
  assert.deepEqual([one.get('a').rankBest, one.get('a').rankWorst], [1, 2])
  // Beaucoup de votes constants : la marge se réduit, le rang devient sûr.
  const many = duel.rankDuels(Array.from({ length: 30 }, () => vote('a', 'b', 'a')))
  assert.ok(many.get('a').margin < one.get('a').margin)
  assert.deepEqual([many.get('a').rankBest, many.get('a').rankWorst], [1, 1])
  assert.deepEqual([many.get('b').rankBest, many.get('b').rankWorst], [2, 2])
  // La force sert de multiplicateur à la note : × 10 tous les 400 points (la prudence est dans le changement de modèle).
  const s = many.get('a')
  assert.ok(Math.abs(s.strength - Math.pow(10, s.score / 400)) < 1e-9)
  // Égalité parfaite : 0 point chacun.
  const tied = duel.rankDuels([vote('a', 'b', 'a'), vote('a', 'b', 'b')])
  assert.ok(Math.abs(tied.get('a').score) < 1e-9 && Math.abs(tied.get('a').strength - 1) < 1e-9)
})

test('classement : battre un modèle fort rapporte plus que battre un faible (Bradley-Terry, pas un simple compte)', () => {
  const base = [...Array.from({ length: 6 }, () => vote('fort', 'faible', 'a'))]
  const beatsStrong = duel.rankDuels([...base, vote('x', 'fort', 'a')])
  const beatsWeak = duel.rankDuels([...base, vote('x', 'faible', 'a')])
  assert.ok(beatsStrong.get('x').score > beatsWeak.get('x').score)
})

test('probabilité d’être meilleur (étape 360) : comparaison directe des deux modèles, jamais sur un seul vote', () => {
  const after = (n, losses = 0) => {
    const votes = [...Array.from({ length: n }, () => vote('a', 'b', 'a')), ...Array.from({ length: losses }, () => vote('a', 'b', 'b'))]
    const r = duel.rankDuels(votes)
    return duel.probabilityBetter({ ...r.get('a'), model: 'a' }, { ...r.get('b'), model: 'b' })
  }
  assert.ok(after(1) > 0.5 && after(1) < 0.95, `un vote : ${after(1)}`)
  let first = null
  for (let n = 1; n <= 30 && first === null; n++) if (after(n) > 0.95) first = n
  assert.ok(first !== null && first >= 4 && first <= 12, `plus de 95 % après ${first} victoires de suite`)
  assert.ok(after(6, 6) > 0.4 && after(6, 6) < 0.6, 'à égalité : environ une chance sur deux')
  assert.equal(duel.probabilityBetter(undefined, undefined), null)
  assert.ok(Math.abs(duel.normalCdf(1.6448536) - 0.95) < 1e-6)
  // Contrôle par simulation : quand la probabilité dit 95 %, le challenger est vraiment meilleur ~95 % du temps.
  let seed = 11
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  let confident = 0
  let right = 0
  for (let k = 0; k < 400; k++) {
    const gap = (rnd() - 0.5) * 200
    const p = 1 / (1 + Math.pow(10, -gap / 400))
    const votes = Array.from({ length: 12 }, () => vote('c', 'i', rnd() < p ? 'a' : 'b'))
    const r = duel.rankDuels(votes)
    const prob = duel.probabilityBetter({ ...r.get('c'), model: 'c' }, { ...r.get('i'), model: 'i' })
    if (prob > 0.95) {
      confident++
      if (gap > 0) right++
    }
  }
  assert.ok(confident > 0 && right / confident >= 0.9, `${right}/${confident} justes`)
})

test('marge à 95 % : comparée à un bootstrap sur des votes simulés (étape 359)', () => {
  // Cinq modèles de forces connues, votes tirés au hasard (graine fixe) ; 200 rééchantillonnages des votes.
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const TRUE = { a: 200, b: 100, c: 0, d: -100, e: -200 }
  const models = Object.keys(TRUE)
  const simulate = (n) =>
    Array.from({ length: n }, () => {
      const i = Math.floor(rnd() * 5)
      let j = Math.floor(rnd() * 4)
      if (j >= i) j++
      const p = 1 / (1 + Math.pow(10, (TRUE[models[j]] - TRUE[models[i]]) / 400))
      return vote(models[i], models[j], rnd() < 0.1 ? 'tie' : rnd() < p ? 'a' : 'b')
    })
  const compare = (n) => {
    const votes = simulate(n)
    const laplace = duel.rankDuels(votes)
    const samples = Object.fromEntries(models.map((m) => [m, []]))
    for (let b = 0; b < 200; b++) {
      const resampled = Array.from({ length: votes.length }, () => votes[Math.floor(rnd() * votes.length)])
      const r = duel.rankDuels(resampled)
      for (const m of models) if (r.has(m)) samples[m].push(r.get(m).score)
    }
    return models.map((m) => {
      const sorted = samples[m].sort((x, y) => x - y)
      const boot = (sorted[Math.floor(0.975 * sorted.length)] - sorted[Math.floor(0.025 * sorted.length)]) / 2
      return laplace.get(m).margin / boot
    })
  }
  // Avec assez de votes, les deux méthodes s'accordent (mesuré : ±15 % dès 100 votes).
  for (const ratio of compare(300)) assert.ok(ratio > 0.75 && ratio < 1.4, `300 votes : rapport ${ratio}`)
  // Avec peu de votes, la marge de Jaris n'est jamais plus étroite que le bootstrap : elle reste prudente.
  const few = compare(10)
  assert.ok(few.reduce((sum, r) => sum + r, 0) / few.length >= 1, `10 votes : rapports ${few}`)
})

test('classement : le même ensemble de votes donne le même résultat dans n’importe quel ordre (pas un Elo)', () => {
  const votes = [vote('weak', 'strong', 'a'), vote('mid', 'strong', 'b'), vote('weak', 'mid', 'tie'), vote('strong', 'weak', 'bothBad'), vote('mid', 'weak', 'a')]
  const forward = duel.rankDuels(votes)
  const backward = duel.rankDuels([...votes].reverse())
  for (const model of ['weak', 'mid', 'strong']) {
    assert.ok(Math.abs(forward.get(model).score - backward.get(model).score) < 1e-6, `${model} dépend de l’ordre des votes`)
    assert.ok(Math.abs(forward.get(model).margin - backward.get(model).margin) < 1e-6)
  }
})

test('classement : victoires, défaites et égalités comptées ; « les deux sont nuls » compte comme une égalité', () => {
  const standings = duel.rankDuels([vote('weak', 'strong', 'a'), vote('strong', 'weak', 'a'), vote('weak', 'strong', 'tie'), vote('weak', 'strong', 'bothBad')])
  const w = standings.get('weak')
  assert.deepEqual({ wins: w.wins, losses: w.losses, ties: w.ties, duels: w.duels }, { wins: 1, losses: 1, ties: 2, duels: 4 })
  assert.ok(Math.abs(w.score) < 1e-9, '1 victoire, 1 défaite, 2 égalités : à égalité')
  assert.equal(duel.scoreOfA('bothBad'), 0.5)
  // Sans aucun vote : rien n'est classé (tous les modèles sont à 0 point).
  assert.equal(duel.rankDuels([]).size, 0)
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
