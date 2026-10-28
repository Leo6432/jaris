/**
 * Étape 361 — simulation des 3 conditions de remplacement d'un modèle en service (≥ 5 duels, plus de 95 %, note
 * devant d'au moins 5 %), sur des sessions de duel réalistes. Reproductible : générateur à graine fixe (mulberry32),
 * une graine dérivée par session, donc des sessions indépendantes.
 *
 * Protocole : 4 modèles, vraie force de chacun tirée de N(0, sigmaElo) ; paires « les moins essayées d'abord » ;
 * 15 % d'égalités, sinon le gagnant suit Bradley-Terry sur les vraies forces ; modèle en service = le premier tiré.
 * En fin de session, le meilleur du classement affiché remplace le modèle en service s'il remplit les 3 conditions.
 * Les intervalles mesurent l'incertitude de la SIMULATION, pas l'écart entre ces hypothèses et les vrais usages.
 *
 * `node scripts/duel-switch-sim.mjs` imprime le tableau recopié dans les notes de l'étape 361.
 */
import { loadTsModule } from './load-ts-module.mjs'

const duel = loadTsModule('shared/duel.ts')
export const SIM_SEED = 361

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rnd) {
  const u = Math.max(rnd(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

/** Intervalle de Wilson à 95 % d'une proportion k/n. */
export function wilson(k, n) {
  if (!n) return [0, 1]
  const z = 1.96
  const p = k / n
  const den = 1 + (z * z) / n
  const mid = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return [Math.max(0, mid - half), Math.min(1, mid + half)]
}

/**
 * `prob(votes, challenger, incumbent)` : la probabilité de décision testée (switchProbability, ou l'ancienne).
 * Rend, pour `sessions` sessions : changements, changements à tort, nuisibles (moins bon de plus de 25 points), et la
 * perte moyenne par session en points (0 si pas de changement ou changement juste), avec un intervalle bootstrap.
 */
export function simulate({ sigmaElo, votesPerSession, sessions, seed = SIM_SEED, prob }) {
  const models = ['m0', 'm1', 'm2', 'm3']
  let switches = 0
  let wrong = 0
  let harmful = 0
  const losses = []
  for (let s = 0; s < sessions; s++) {
    const rnd = mulberry32((seed * 2654435761 + s * 0x9e3779b9) >>> 0)
    const truth = Object.fromEntries(models.map((m) => [m, gaussian(rnd) * sigmaElo]))
    const incumbent = models[0]
    const tried = Object.fromEntries(models.map((m) => [m, 0]))
    const votes = []
    for (let v = 0; v < votesPerSession; v++) {
      const order = [...models].sort((x, y) => tried[x] - tried[y] || rnd() - 0.5)
      let [a, b] = order
      if (rnd() < 0.5) [a, b] = [b, a]
      tried[a]++
      tried[b]++
      let outcome
      if (rnd() < 0.15) outcome = 'tie'
      else outcome = rnd() < 1 / (1 + 10 ** ((truth[b] - truth[a]) / 400)) ? 'a' : 'b'
      votes.push({ id: `v${v}`, category: 'conversation', at: v, sessionId: 's', modelA: a, modelB: b, outcome, prompt: '' })
    }
    const shown = duel.rankDuels(votes)
    const best = [...shown.values()].sort((x, y) => y.strength - x.strength)[0]
    const kept = shown.get(incumbent)
    let loss = 0
    if (best && kept && best.model !== incumbent && best.duels >= 5 && best.strength >= kept.strength * 1.05) {
      const p = prob(votes, best.model, incumbent)
      if (p !== null && p > 0.95) {
        switches++
        const diff = truth[best.model] - truth[incumbent]
        if (diff < 0) {
          wrong++
          loss = -diff
          if (diff < -25) harmful++
        }
      }
    }
    losses.push(loss)
  }
  const mean = losses.reduce((sum, x) => sum + x, 0) / sessions
  const rnd = mulberry32(seed ^ 0x5bd1e995)
  const boots = []
  for (let b = 0; b < 400; b++) {
    let sum = 0
    for (let k = 0; k < sessions; k++) sum += losses[Math.floor(rnd() * sessions)]
    boots.push(sum / sessions)
  }
  boots.sort((x, y) => x - y)
  return {
    sessions,
    switches,
    wrong,
    harmful,
    wrongRate: switches ? wrong / switches : 0,
    wrongCi: wilson(wrong, switches),
    harmfulRate: switches ? harmful / switches : 0,
    harmfulCi: wilson(harmful, switches),
    meanLoss: mean,
    meanLossCi: [boots[Math.floor(0.025 * boots.length)], boots[Math.floor(0.975 * boots.length)]]
  }
}

export const switchProb = (votes, c, i) => duel.switchProbability(votes, c, i)
/** Probabilité de la v0.40.2 (a priori du classement affiché), pour comparaison. */
export const oldProb = (votes, c, i) => {
  const r = duel.rankDuels(votes)
  return duel.probabilityBetter(r.get(c), r.get(i))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pct = (x) => `${(100 * x).toFixed(1)} %`
  const ci = ([a, b]) => `${(100 * a).toFixed(1)}-${(100 * b).toFixed(1)} %`
  console.log(`graine ${SIM_SEED}, 4 000 sessions par case`)
  for (const [name, prob] of [['v0.40.2', oldProb], ['150 points', switchProb]]) {
    for (const sigmaElo of [25, 50, 100, 300]) {
      for (const votesPerSession of [12, 40]) {
        const r = simulate({ sigmaElo, votesPerSession, sessions: 4000, prob })
        console.log(
          `${name} | σ=${sigmaElo} | ${votesPerSession} votes | changements ${r.switches} | à tort ${pct(r.wrongRate)} (${ci(r.wrongCi)})` +
            ` | nuisibles ${pct(r.harmfulRate)} (${ci(r.harmfulCi)}) | perte moyenne ${r.meanLoss.toFixed(2)} (${r.meanLossCi.map((x) => x.toFixed(2)).join('-')}) points`
        )
      }
    }
  }
}
