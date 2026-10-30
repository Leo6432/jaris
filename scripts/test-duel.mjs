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

test('étape 361 : probabilité de remplacement avec l’a priori prudent (150 points), cas limites', () => {
  const votes = (w, l, t = 0) => [
    ...Array.from({ length: w }, () => vote('c', 'i', 'a')),
    ...Array.from({ length: l }, () => vote('c', 'i', 'b')),
    ...Array.from({ length: t }, () => vote('c', 'i', 'tie'))
  ]
  const p = (w, l, t) => duel.switchProbability(votes(w, l, t), 'c', 'i')
  assert.ok(p(5, 0) < 0.95 && p(5, 0) > 0.93, `5-0 : ${p(5, 0)}`)
  assert.ok(p(6, 0) > 0.95, `6-0 : ${p(6, 0)}`)
  assert.ok(p(7, 2) < 0.95, `7-2 : ${p(7, 2)}`)
  assert.ok(p(8, 0) > 0.98, `8-0 : ${p(8, 0)}`)
  assert.ok(p(5, 0, 3) < 0.95, `5-0 + 3 égalités : ${p(5, 0, 3)}`)
  assert.ok(Math.abs(p(3, 3) - 0.5) < 1e-9)
  assert.equal(duel.switchProbability([], 'c', 'i'), null)
  assert.equal(duel.switchProbability(votes(5, 0), 'c', 'absent'), null)
  // Le classement affiché ne change pas : même résultat qu'avant, a priori ARENA_SIGMA.
  const v = votes(7, 2, 1)
  const shown = duel.rankDuels(v)
  const explicit = duel.rankDuels(v, duel.ARENA_SIGMA)
  for (const m of ['c', 'i']) assert.equal(shown.get(m).score, explicit.get(m).score)
  // Et l'ancienne probabilité (v0.40.2) aurait déjà dit plus de 95 % à 5-0 : c'est le défaut corrigé.
  const old = duel.rankDuels(votes(5, 0))
  assert.ok(duel.probabilityBetter(old.get('c'), old.get('i')) > 0.95)
})

test('étape 361 : Laplace ne dépasse jamais le calcul exact, à moins d’un point (cas testés : 2 modèles, 0 à 12 votes, égalités)', () => {
  // Calcul exact : a priori N(0, 2·SWITCH_SIGMA²) sur l'écart, vraisemblance Bradley-Terry (égalité = demi-victoire).
  const sd = duel.SWITCH_SIGMA * Math.SQRT2
  const exact = (w, l, t) => {
    let num = 0
    let den = 0
    for (let k = -4000; k <= 4000; k++) {
      const d = (k / 4000) * 8 * sd
      const p = 1 / (1 + Math.exp(-d))
      const logw = -(d * d) / (2 * sd * sd) + (w + t / 2) * Math.log(p) + (l + t / 2) * Math.log(1 - p)
      const weight = Math.exp(logw)
      den += weight
      if (d > 0) num += weight
      else if (d === 0) num += weight / 2
    }
    return num / den
  }
  for (let w = 0; w <= 12; w++) {
    for (let l = 0; w + l <= 12; l++) {
      for (const t of [0, 3]) {
        if (w + l + t === 0) continue
        const votes = [
          ...Array.from({ length: w }, () => vote('c', 'i', 'a')),
          ...Array.from({ length: l }, () => vote('c', 'i', 'b')),
          ...Array.from({ length: t }, () => vote('c', 'i', 'tie'))
        ]
        const lap = duel.switchProbability(votes, 'c', 'i')
        const ex = exact(w, l, t)
        const gap = w >= l ? ex - lap : lap - ex
        assert.ok(gap > -1e-3 && gap < 0.01, `${w}-${l}+${t} : Laplace ${lap}, exact ${ex}`)
      }
    }
  }
})

test('étape 361 : simulation des 3 conditions ensemble (graine fixe, sessions indépendantes, 4 modèles)', async () => {
  const sim = await import('./duel-switch-sim.mjs')
  const run = (sigmaElo, votesPerSession, prob) => sim.simulate({ sigmaElo, votesPerSession, sessions: 1500, prob })
  // Écarts nets entre modèles : presque aucun changement à tort, intervalle de Wilson compris.
  for (const sigma of [100, 300]) {
    const r = run(sigma, 40, sim.switchProb)
    assert.ok(r.switches > 50, `σ=${sigma} : trop peu de changements (${r.switches})`)
    assert.ok(r.wrongCi[1] < 0.05, `σ=${sigma} : ${r.wrong}/${r.switches} à tort`)
  }
  // Modèles presque équivalents : le risque n'est pas nul, mais la perte moyenne est plus faible qu'en v0.40.2.
  for (const [sigma, n] of [[25, 12], [50, 12], [50, 40]]) {
    const neu = run(sigma, n, sim.switchProb)
    const old = run(sigma, n, sim.oldProb)
    assert.ok(neu.meanLoss <= old.meanLoss, `σ=${sigma}, ${n} votes : perte ${neu.meanLoss} contre ${old.meanLoss}`)
    assert.ok(neu.harmful <= old.harmful, `σ=${sigma}, ${n} votes : nuisibles ${neu.harmful} contre ${old.harmful}`)
  }
  // Reproductible : même graine, mêmes chiffres.
  const a = run(50, 12, sim.switchProb)
  const b = run(50, 12, sim.switchProb)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.ok(Math.abs(sim.wilson(5, 100)[0] - 0.0215) < 1e-3 && Math.abs(sim.wilson(5, 100)[1] - 0.1118) < 1e-3)
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

/**
 * Étape 366 (capture de Léo, PC sans carte graphique) : seulement les outils que CE PC peut faire tourner — le dessin si
 * le PC dessine, regarder l'écran et le pilotage si le modèle de vision est installé, jamais l'extinction. On ne retire
 * que ce qui est sûr : Ollama muet, les outils de vision restent.
 */
test('étape 366 : outils proposés en duel selon ce que ce PC peut faire tourner', () => {
  const names = ['open_app', 'search_web', 'generate_image', 'look_at_screen', 'computer_use_task', 'shutdown_pc']
  const offered = (machine) => [...duel.duelOfferedTools(names, machine)].sort()
  assert.deepEqual(offered({ canDraw: false, installed: ['qwen3-vl:8b', 'granite4.2:8b'], visionModels: ['qwen3-vl:8b'] }), [
    'computer_use_task',
    'look_at_screen',
    'open_app',
    'search_web'
  ])
  assert.deepEqual(offered({ canDraw: true, installed: ['granite4.2:8b'], visionModels: ['qwen3-vl:8b'] }), ['generate_image', 'open_app', 'search_web'])
  // Ollama muet : on ne sait pas, rien n'est retiré (sauf l'extinction, toujours).
  assert.deepEqual(offered({ canDraw: true, installed: null, visionModels: ['qwen3-vl:8b'] }), [
    'computer_use_task',
    'generate_image',
    'look_at_screen',
    'open_app',
    'search_web'
  ])
  // Un modèle sans tag est listé « :latest » par Ollama : c'est le même.
  assert.ok(duel.duelOfferedTools(names, { canDraw: false, installed: ['hf.co/org/Vision-GGUF:latest'], visionModels: ['hf.co/org/Vision-GGUF'] }).has('look_at_screen'))
  assert.ok(!duel.duelOfferedTools(names, { canDraw: false, installed: ['qwen3-vl:4b'], visionModels: ['qwen3-vl:8b'] }).has('look_at_screen'))
})

test('étape 366 (relecture) : un AUTRE modèle qui lit les images, installé, garde regarder l’écran', () => {
  const names = ['look_at_screen', 'computer_use_task', 'open_app']
  const tools = duel.duelOfferedTools(names, { canDraw: false, installed: ['qwen3.5:4b'], visionModels: ['qwen3.8:27b', 'qwen3.5:4b'] })
  assert.ok(tools.has('look_at_screen') && tools.has('computer_use_task'))
})


test('étape 379 : deux modèles en même temps seulement en Code, et seulement s’ils tiennent ensemble sur la carte', () => {
  // H100 (80 Go) : deux modèles de 22 et 18 Go tiennent, avec leur mémoire de travail.
  assert.equal(duel.canRunDuelTogether('code', [22, 18], 80), true)
  // RTX 5090 (32 Go) : non, l'un déborderait sur la RAM.
  assert.equal(duel.canRunDuelTogether('code', [22, 18], 32), false)
  assert.equal(duel.canRunDuelTogether('code', [5, 6], 32), true)
  // Conversation et Vocal : jamais, ils agissent sur le PC.
  assert.equal(duel.canRunDuelTogether('conversation', [2, 3], 288), false)
  assert.equal(duel.canRunDuelTogether('voice', [2, 3], 288), false)
  // Carte inconnue ou taille inconnue : prudence.
  assert.equal(duel.canRunDuelTogether('code', [2, 3], null), false)
  assert.equal(duel.canRunDuelTogether('code', [Number.NaN, 3], 288), false)
})

test('étape 381 : file de duels Code — combien de générations à la fois', () => {
  const slot = (key, model, sizeGb) => ({ key, model, sizeGb })
  const waiting = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => slot(k, `m${i}`, 5))
  // Grosse carte : 4 au plus, même s'il reste de la place.
  assert.deepEqual(duel.batchSlotsToStart([], waiting, 288), ['a', 'b', 'c', 'd'])
  // 32 Go (31 utilisables) : 8,5 Go par modèle de 5 Go → 3.
  assert.deepEqual(duel.batchSlotsToStart([], waiting, 32), ['a', 'b', 'c'])
  // Petite carte : toujours un, jamais zéro, quand rien ne tourne.
  assert.deepEqual(duel.batchSlotsToStart([], waiting, 8), ['a'])
  assert.deepEqual(duel.batchSlotsToStart([{ model: 'x', sizeGb: 5 }], waiting, 8), [])
  // Carte inconnue : un à la fois.
  assert.deepEqual(duel.batchSlotsToStart([], waiting, null), ['a'])
  // Un modèle déjà chargé ne compte pas deux fois.
  assert.deepEqual(duel.batchSlotsToStart([{ model: 'm0', sizeGb: 20 }], [slot('a', 'm0', 20), slot('b', 'm0', 20)], 32), ['a', 'b'])
  // Dans l'ordre de la file : un gros modèle qui ne tient pas bloque ceux qui suivent (il ne patiente jamais sans fin).
  assert.deepEqual(duel.batchSlotsToStart([], [slot('a', 'p', 3), slot('b', 'g', 30), slot('c', 'q', 3)], 32), ['a'])
})

test('étape 385 : série — autant de modèles que la carte en tient, jusqu’à 4 duels par modèle', () => {
  const slot = (key, model, sizeGb) => ({ key, model, sizeGb })
  // 6 modèles de 5 Go, 4 côtés chacun, sur un H200 : tous ensemble, 4 par modèle (24 générations à la fois).
  const waiting = []
  for (let m = 0; m < 6; m++) for (let k = 0; k < 6; k++) waiting.push(slot(`m${m}-${k}`, `m${m}`, 5))
  const started = duel.batchSlotsToStart([], waiting, 140, 'series')
  const perModel = new Map()
  for (const key of started) perModel.set(key.split('-')[0], (perModel.get(key.split('-')[0]) ?? 0) + 1)
  assert.equal(perModel.size, 6, 'les 6 modèles tournent')
  for (const count of perModel.values()) assert.equal(count, duel.DUEL_SERIES_SLOTS_PER_MODEL)
  // Un modèle déjà à 4 duels n'en reçoit pas un 5e ; les autres de la file passent quand même.
  const busy = Array.from({ length: 4 }, () => ({ model: 'm0', sizeGb: 5 }))
  assert.deepEqual(duel.batchSlotsToStart(busy, [slot('x', 'm0', 5), slot('y', 'm1', 5)], 140, 'series'), ['y'])
  // Au plus DUEL_SERIES_MAX_MODELS modèles, même sur une carte immense.
  const many = Array.from({ length: 20 }, (_, i) => slot(`k${i}`, `n${i}`, 1))
  assert.equal(duel.batchSlotsToStart([], many, 10_000, 'series').length, duel.DUEL_SERIES_MAX_MODELS)
  // Petite carte : rien ne change (un seul modèle tient).
  assert.equal(new Set(duel.batchSlotsToStart([], waiting, 8, 'series').map((k) => k.split('-')[0])).size, 1)
  // Taille inconnue d'un modèle déjà chargé : jamais un duel de plus « gratuit ».
  assert.deepEqual(duel.batchSlotsToStart([{ model: 'z', sizeGb: Number.NaN }], [slot('a', 'z', Number.NaN)], 140, 'series'), [])
  // Hors série, le comportement de l'étape 381 ne bouge pas.
  assert.deepEqual(duel.batchSlotsToStart([], waiting, 140), ['m0-0', 'm0-1', 'm0-2', 'm0-3'])
})

test('étape 385 : télécharger un modèle de plus seulement s’il tient avec ceux déjà là', () => {
  // 5 Go à 4 duels = 5 × 1,3 + 2 + 3 = 11,5 Go.
  assert.equal(duel.seriesRoomForModel([5, 5], 5, 140), true)
  assert.equal(duel.seriesRoomForModel([5, 5], 5, 30), false)
  assert.equal(duel.seriesRoomForModel([], 6, 8), false, 'carte de 8 Go : jamais un second modèle')
  assert.equal(duel.seriesRoomForModel([5], 5, null), false, 'carte inconnue')
  assert.equal(duel.seriesRoomForModel([5], Number.NaN, 140), false, 'taille inconnue')
  assert.equal(duel.seriesRoomForModel(Array(duel.DUEL_SERIES_MAX_MODELS).fill(1), 1, 10_000), false)
})

test('étape 382 : planning d’une série — chaque modèle au moins N duels, contre des adversaires variés, A/B au hasard', () => {
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (const [count, perModel] of [[4, 10], [5, 10], [12, 10], [30, 10], [7, 3], [9, 20], [2, 5], [3, 1]]) {
    const models = Array.from({ length: count }, (_, i) => `modele-${i}:7b`)
    const plan = duel.planDuelSeries(models, perModel, random)
    const counts = new Map()
    const opponents = new Map(models.map((m) => [m, new Set()]))
    let aFirst = 0
    for (const [a, b] of plan) {
      assert.notEqual(a, b)
      counts.set(a, (counts.get(a) ?? 0) + 1)
      counts.set(b, (counts.get(b) ?? 0) + 1)
      opponents.get(a).add(b)
      opponents.get(b).add(a)
      if (a < b) aFirst++
    }
    for (const model of models) {
      const n = counts.get(model) ?? 0
      assert.ok(n >= perModel, `${count} modèles × ${perModel} : ${model} n’a que ${n} duels`)
      assert.ok(n <= perModel + 2, `${model} : ${n} duels, beaucoup plus que demandé`)
      // Autant d'adversaires différents que possible (pas toujours les mêmes voisins).
      assert.ok(opponents.get(model).size >= Math.min(perModel, count - 1), `${model} : ${opponents.get(model).size} adversaires`)
    }
    // Le total reste proche du minimum (N × modèles / 2).
    assert.ok(plan.length <= Math.ceil((count * perModel) / 2) + 2)
    if (plan.length >= 20) assert.ok(aFirst > plan.length * 0.2 && aFirst < plan.length * 0.8, 'A/B au hasard')
  }
  assert.deepEqual(duel.planDuelSeries(['seul:7b'], 10), [])
  assert.deepEqual(duel.planDuelSeries(['a:7b', 'b:7b'], 0), [])
})

test('étape 384 : la série compte les duels déjà votés — « au moins N » au total, pas N de plus', () => {
  const models = ['a:7b', 'b:7b', 'c:7b', 'd:7b', 'e:7b']
  const done = duel.countDuelsByModel(
    [
      ...Array.from({ length: 8 }, () => ({ category: 'code', modelA: 'a:7b', modelB: 'z:1b' })),
      ...Array.from({ length: 10 }, () => ({ category: 'code', modelA: 'b:latest', modelB: 'z:1b' })),
      // Une autre catégorie ne compte pas.
      ...Array.from({ length: 10 }, () => ({ category: 'conversation', modelA: 'c:7b', modelB: 'z:1b' }))
    ],
    'code'
  )
  assert.equal(done.get('a:7b'), 8)
  assert.equal(done.get('b'), 10, '« :latest » compte comme le tag sans version')
  assert.equal(done.get('c:7b'), undefined)
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const plan = duel.planDuelSeries(models, 10, random, done)
  const counts = new Map()
  for (const [x, y] of plan) for (const m of [x, y]) counts.set(m, (counts.get(m) ?? 0) + 1)
  for (const m of ['c:7b', 'd:7b', 'e:7b']) assert.ok(counts.get(m) >= 10, `${m} : ${counts.get(m)}`)
  // a n'avait plus que 2 duels à faire : il ne joue pas 10 duels de plus (seulement comme adversaire si besoin).
  assert.ok((counts.get('a:7b') ?? 0) >= 2 && (counts.get('a:7b') ?? 0) < 10, `a : ${counts.get('a:7b')}`)
  assert.ok(plan.length < Math.ceil((5 * 10) / 2), 'moins de duels que si tout repartait de zéro')
  // Tout le monde a déjà ses N duels : rien à faire.
  const all = new Map(models.map((m) => [m, 10]))
  assert.deepEqual(duel.planDuelSeries(models, 10, random, all), [])
  // Un seul modèle a encore des duels : il joue contre ceux qui en ont déjà assez.
  const one = new Map(models.slice(1).map((m) => [m, 10]))
  const solo = duel.planDuelSeries(models, 10, random, one)
  assert.equal(solo.length, 10)
  assert.ok(solo.every((pair) => pair.includes('a:7b')))
  assert.ok(new Set(solo.flat().filter((m) => m !== 'a:7b')).size === 4, 'contre tous les autres, pas toujours le même')
})

test('étape 382 : nombre de duels par modèle accepté de 1 à 50, entier seulement', () => {
  for (const ok of [1, 10, 50]) assert.equal(duel.isDuelSeriesCount(ok), true)
  for (const bad of [0, 51, 2.5, '10', null, Number.NaN]) assert.equal(duel.isDuelSeriesCount(bad), false)
})
