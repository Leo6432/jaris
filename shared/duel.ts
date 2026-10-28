/**
 * Étape 355, Léo : « un bouton duel, une session duel télécharge 4-6 modèles qui tiennent, anonymes, on choisit
 * conversation, code ou vocal, et on vote, à la place d'Artificial Analysis ». Deux modèles anonymes répondent à la
 * même demande ; Léo vote ; ses votes classent les modèles et décident du choix de Jaris.
 *
 * Ce module est PUR (aucun accès au disque, à Ollama ni à Electron) : le classement, l'ordre des duels et la lecture
 * des actions faites par un modèle se testent sans rien simuler.
 */

/** Les trois sortes de duel. Vocal : la réponse est écrite pour être lue à voix haute, puis lue par Jaris. */
export type DuelCategory = 'conversation' | 'code' | 'voice'
export const DUEL_CATEGORIES: readonly DuelCategory[] = ['conversation', 'code', 'voice']

/** « Les deux sont nuls » compte comme une égalité pour le classement (comme sur LMArena), mais reste noté à part. */
export type DuelOutcome = 'a' | 'b' | 'tie' | 'bothBad'
export const DUEL_OUTCOMES: readonly DuelOutcome[] = ['a', 'b', 'tie', 'bothBad']
export type DuelSide = 'a' | 'b'

/** Nombre de modèles d'une session : 4 à 6 (Léo), jamais moins de 2 (sinon pas de duel possible). */
export const DUEL_MIN_MODELS = 2
export const DUEL_SESSION_SIZES = [4, 5, 6] as const
/** Étape 363, Léo : « choisir les modèles qu'on veut, il y a un minimum de 4 ». */
export const DUEL_MIN_CHOSEN = 4
export const DUEL_DEFAULT_SIZE = 5

/**
 * Ce qu'un modèle a fait pendant un duel, gardé avec le vote pour l'historique (Léo : « voir tous les combats, un
 * historique complet »). La réponse est coupée à DUEL_HISTORY_TEXT_MAX caractères ; l'application d'un duel Code est
 * rangée à part (duelStore.ts), `app` dit seulement qu'elle existe.
 */
export interface DuelVoteSide {
  text: string
  actions: DuelAction[]
  durationMs: number | null
  error: string | null
  app: boolean
}

export const DUEL_HISTORY_TEXT_MAX = 8000

export interface DuelVote {
  id: string
  category: DuelCategory
  /** Horodatage (ms). */
  at: number
  sessionId: string
  modelA: string
  modelB: string
  outcome: DuelOutcome
  /** La demande faite, gardée pour que Léo puisse relire ses duels. */
  prompt: string
  /** Les deux réponses ; absentes pour un vote d'une version qui ne les gardait pas. */
  sides?: { a: DuelVoteSide; b: DuelVoteSide }
}

export function isDuelCategory(value: unknown): value is DuelCategory {
  return typeof value === 'string' && (DUEL_CATEGORIES as readonly string[]).includes(value)
}

export function isDuelOutcome(value: unknown): value is DuelOutcome {
  return typeof value === 'string' && (DUEL_OUTCOMES as readonly string[]).includes(value)
}

/** Un vote lu sur le disque, ou `null` s'il n'a pas la bonne forme (fichier abîmé, autre version). */
export function parseDuelVote(value: unknown): DuelVote | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return null
  if (!isDuelCategory(v.category) || !isDuelOutcome(v.outcome)) return null
  if (typeof v.modelA !== 'string' || !v.modelA || typeof v.modelB !== 'string' || !v.modelB || v.modelA === v.modelB) return null
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  const a = parseVoteSide(typeof v.sides === 'object' && v.sides !== null ? (v.sides as Record<string, unknown>).a : null)
  const b = parseVoteSide(typeof v.sides === 'object' && v.sides !== null ? (v.sides as Record<string, unknown>).b : null)
  return {
    id: v.id,
    category: v.category,
    at: v.at,
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
    modelA: v.modelA,
    modelB: v.modelB,
    outcome: v.outcome,
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    ...(a && b ? { sides: { a, b } } : {})
  }
}

/** Une réponse gardée, ou `null` si elle n'a pas la bonne forme (le vote reste valable sans elle). */
function parseVoteSide(value: unknown): DuelVoteSide | null {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (typeof s.text !== 'string') return null
  const actions = Array.isArray(s.actions)
    ? s.actions.filter(
        (x): x is DuelAction =>
          typeof x === 'object' && x !== null && typeof (x as DuelAction).tool === 'string' &&
          ((x as DuelAction).detail === null || typeof (x as DuelAction).detail === 'string')
      )
    : []
  return {
    text: s.text.slice(0, DUEL_HISTORY_TEXT_MAX),
    actions,
    durationMs: typeof s.durationMs === 'number' && Number.isFinite(s.durationMs) ? s.durationMs : null,
    error: typeof s.error === 'string' ? s.error : null,
    app: s.app === true
  }
}

/**
 * Étape 355, Léo : « si le modèle a un problème avec l'outil de navigation, c'est pas sa faute ? ». Ces outils
 * dépendent de Jaris ou d'internet, pas du modèle du duel : la recherche et la lecture de pages (moteur bloqué, pas
 * d'internet), regarder l'écran et piloter le PC (modèle de vision de Jaris), dessiner (moteur d'images), l'état du PC.
 * Quand l'un d'eux ÉCHOUE, le duel ne compte pas : rien n'est voté contre le modèle.
 *
 * Exception : une page qui répond « introuvable » (404…) — c'est l'adresse choisie par le modèle qui est en cause.
 * Ouvrir une application (nom inventé) ou taper du texte restent de la responsabilité du modèle.
 */
export const JARIS_SIDE_TOOLS: ReadonlySet<string> = new Set([
  'search_web',
  'read_web_page',
  'look_at_screen',
  'computer_use_task',
  'generate_image',
  'get_system_stats'
])

export function isJarisToolFailure(tool: string, errorName: string | null | undefined): boolean {
  if (!JARIS_SIDE_TOOLS.has(tool)) return false
  return !(tool === 'read_web_page' && errorName === 'PageHttpError')
}

/** L'outil de Jaris qui a échoué pendant un tour, et son message (déjà sans le nom des modèles). */
export interface DuelToolTrouble {
  tool: string
  message: string
}

/** Le fichier des votes : une liste de votes. Un vote illisible est écarté, jamais tout le fichier. */
export function parseDuelVotes(value: unknown): DuelVote[] | null {
  if (!Array.isArray(value)) return null
  return value.map(parseDuelVote).filter((vote): vote is DuelVote => vote !== null)
}

/** Part de victoire du modèle A : 1 s'il gagne, 0 s'il perd, 0,5 pour une égalité (« les deux sont nuls » compris). */
export function scoreOfA(outcome: DuelOutcome): number {
  return outcome === 'a' ? 1 : outcome === 'b' ? 0 : 0.5
}

/**
 * Étape 358, Léo : « fais comme Arena en point de départ, au début tous les modèles vont être à 0 ». Le classement
 * (Bradley-Terry, comme LMArena) ne part plus d'Artificial Analysis : tous les modèles partent de 0, et seuls les
 * votes les séparent. Un modèle invaincu aurait une force infinie avec le maximum de vraisemblance pur : une très
 * légère régularisation (a priori centré sur 0, écart ARENA_SIGMA, ≈ 350 points) la garde finie, sans peser sur
 * le classement dès qu'il y a des votes.
 *
 * Points affichés : l'échelle des classements Elo (400 points = 10 fois plus de chances d'être préféré), partant de
 * 0. Intervalle de confiance à 95 % : approximation de Laplace (inverse de la courbure au maximum), comme une marge
 * d'Arena. Rang possible (« Rank Spread ») : meilleur et pire rang compatibles avec ces marges.
 */
export const ARENA_SIGMA = 2
/** 400 / ln(10) : un écart de 400 points veut dire 10 fois plus de chances d'être préféré. */
export const DUEL_POINTS_PER_UNIT = 400 / Math.LN10
const Z_95 = 1.96

export interface DuelStanding {
  model: string
  /** Points façon Arena : 0 au départ, positif = préféré plus souvent que la moyenne. */
  score: number
  /** Demi-largeur de l'intervalle de confiance à 95 %, en points. */
  margin: number
  /** Multiplicateur de la note de Jaris : 1 à 0 point, × 10 tous les 400 points (estimation, sans la marge). */
  strength: number
  /**
   * Étape 360 : covariance de la force de ce modèle avec chaque modèle voté (échelle naturelle, pas en points).
   * Sert à comparer DIRECTEMENT deux modèles (probabilityBetter) : l'incertitude d'une différence n'est pas la somme
   * des deux marges, les deux forces sont estimées sur les mêmes votes.
   */
  covariance: Record<string, number>
  /** Meilleur et pire rang possibles compte tenu de l'incertitude (1 = premier). */
  rankBest: number
  rankWorst: number
  wins: number
  losses: number
  ties: number
  duels: number
}

/**
 * Classement d'une catégorie : seuls les modèles VOTÉS y figurent (les autres sont à 0 point, force 1).
 * Maximum a posteriori calculé par Newton coordonnée par coordonnée : le problème est concave, la solution est unique
 * et ne dépend pas de l'ordre des votes — contrairement à un Elo, où le même ensemble de votes rejoué dans un autre
 * ordre donne un autre classement.
 */
export function rankDuels(votes: readonly DuelVote[], sigma: number = ARENA_SIGMA): Map<string, DuelStanding> {
  // Résultats regroupés par paire (i < j dans l'ordre alphabétique) : ce sont les paires qu'on parcourt, pas les votes.
  const pairs = new Map<string, { i: string; j: string; n: number; scoreI: number }>()
  const standings = new Map<string, DuelStanding>()
  const standing = (model: string): DuelStanding => {
    let s = standings.get(model)
    if (!s) {
      s = { model, score: 0, margin: 0, strength: 1, covariance: {}, rankBest: 1, rankWorst: 1, wins: 0, losses: 0, ties: 0, duels: 0 }
      standings.set(model, s)
    }
    return s
  }
  for (const vote of votes) {
    const a = standing(vote.modelA)
    const b = standing(vote.modelB)
    a.duels += 1
    b.duels += 1
    if (vote.outcome === 'a') {
      a.wins += 1
      b.losses += 1
    } else if (vote.outcome === 'b') {
      b.wins += 1
      a.losses += 1
    } else {
      a.ties += 1
      b.ties += 1
    }
    const [i, j] = vote.modelA < vote.modelB ? [vote.modelA, vote.modelB] : [vote.modelB, vote.modelA]
    const key = `${i}\u0000${j}`
    const pair = pairs.get(key) ?? { i, j, n: 0, scoreI: 0 }
    pair.n += 1
    pair.scoreI += i === vote.modelA ? scoreOfA(vote.outcome) : 1 - scoreOfA(vote.outcome)
    pairs.set(key, pair)
  }
  if (!standings.size) return standings

  const models = [...standings.keys()]
  const index = new Map(models.map((m, k) => [m, k]))
  const precision = 1 / sigma ** 2
  const byModel = new Map<string, Array<{ other: string; n: number; score: number }>>()
  for (const m of models) byModel.set(m, [])
  for (const { i, j, n, scoreI } of pairs.values()) {
    byModel.get(i)?.push({ other: j, n, score: scoreI })
    byModel.get(j)?.push({ other: i, n, score: n - scoreI })
  }

  const x = new Map(models.map((m) => [m, 0]))
  const logistic = (d: number): number => 1 / (1 + Math.exp(-d))
  for (let round = 0; round < 1000; round++) {
    let largest = 0
    for (const m of models) {
      const xm = x.get(m) as number
      let gradient = -xm * precision
      let curvature = precision
      for (const { other, n, score } of byModel.get(m) as Array<{ other: string; n: number; score: number }>) {
        const p = logistic(xm - (x.get(other) as number))
        gradient += score - n * p
        curvature += n * p * (1 - p)
      }
      const step = gradient / curvature
      x.set(m, xm + step)
      largest = Math.max(largest, Math.abs(step))
    }
    if (largest < 1e-10) break
  }

  // Incertitude : inverse de la courbure complète (Hessienne) au maximum — les forces sont liées entre elles.
  const size = models.length
  const hessian = models.map(() => new Array<number>(size).fill(0))
  for (let k = 0; k < size; k++) hessian[k][k] = precision
  for (const { i, j, n } of pairs.values()) {
    const a = index.get(i) as number
    const b = index.get(j) as number
    const p = logistic((x.get(i) as number) - (x.get(j) as number))
    const w = n * p * (1 - p)
    hessian[a][a] += w
    hessian[b][b] += w
    hessian[a][b] -= w
    hessian[b][a] -= w
  }
  // Comme Arena, le classement ne dit que des ÉCARTS : on mesure l'incertitude de chaque modèle par rapport à la
  // moyenne des modèles votés (force centrée), sinon la marge garderait la largeur de l'a priori quels que soient les votes.
  const inverse = inverseMatrix(hessian)
  const rowMean = inverse.map((row) => row.reduce((sum, v) => sum + v, 0) / size)
  const allMean = rowMean.reduce((sum, v) => sum + v, 0) / size
  const meanTheta = models.reduce((sum, m) => sum + (x.get(m) as number), 0) / size
  for (const m of models) {
    const k = index.get(m) as number
    const s = standing(m)
    const theta = (x.get(m) as number) - meanTheta
    const variance = inverse[k][k] - 2 * rowMean[k] + allMean
    s.score = theta * DUEL_POINTS_PER_UNIT
    s.margin = Z_95 * Math.sqrt(Math.max(0, variance)) * DUEL_POINTS_PER_UNIT
    s.strength = Math.exp(theta)
    // Covariance centrée (comme la marge) : ce sont les écarts qui comptent.
    s.covariance = Object.fromEntries(
      models.map((other) => {
        const j = index.get(other) as number
        return [other, inverse[k][j] - rowMean[k] - rowMean[j] + allMean]
      })
    )
  }
  const all = [...standings.values()]
  for (const s of all) {
    // Comme Arena : 1 + le nombre de modèles sûrement devant (leur bas de marge au-dessus de notre haut de marge).
    s.rankBest = 1 + all.filter((o) => o !== s && o.score - o.margin > s.score + s.margin).length
    s.rankWorst = 1 + all.filter((o) => o !== s && o.score + o.margin >= s.score - s.margin).length
  }
  return standings
}

/**
 * Étape 360 (relecture de ChatGPT, acceptée par Léo) : probabilité que `challenger` soit réellement meilleur que
 * `incumbent`, d'après la différence de leurs forces et l'incertitude de CETTE différence (approximation normale,
 * vérifiée contre un bootstrap dans test-duel.mjs). `null` si l'un des deux n'a jamais été voté.
 */
export function probabilityBetter(
  challenger: Pick<DuelStanding, 'model' | 'score' | 'covariance'> | undefined,
  incumbent: Pick<DuelStanding, 'model' | 'score' | 'covariance'> | undefined
): number | null {
  if (!challenger || !incumbent) return null
  const cc = challenger.covariance[challenger.model]
  const ii = incumbent.covariance[incumbent.model]
  const ci = challenger.covariance[incumbent.model]
  if (cc === undefined || ii === undefined || ci === undefined) return null
  const diff = (challenger.score - incumbent.score) / DUEL_POINTS_PER_UNIT
  const sd = Math.sqrt(Math.max(1e-12, cc + ii - 2 * ci))
  return normalCdf(diff / sd)
}

/**
 * Étape 361 (relecture de ChatGPT, acceptée par Léo) : pour REMPLACER un modèle en service, l'a priori large du
 * classement affiché (ARENA_SIGMA, plus de 490 points d'écart possibles entre deux modèles) est trop optimiste — 5
 * victoires sur 5 y donnaient déjà 96 %. La décision suppose donc un écart a priori de SWITCH_PRIOR_ELO points entre
 * deux modèles (écart-type de la différence), soit SWITCH_SIGMA par modèle. Vérifié contre un calcul exact et par
 * simulation (test-duel.mjs, notes de l'étape 361). Le classement affiché, lui, ne change pas.
 */
export const SWITCH_PRIOR_ELO = 150
export const SWITCH_SIGMA = SWITCH_PRIOR_ELO / DUEL_POINTS_PER_UNIT / Math.SQRT2

/** Probabilité, pour la décision de remplacement, que `challenger` soit meilleur que `incumbent` (votes d'UNE catégorie). */
export function switchProbability(votes: readonly DuelVote[], challenger: string, incumbent: string): number | null {
  const standings = rankDuels(votes, SWITCH_SIGMA)
  return probabilityBetter(standings.get(challenger), standings.get(incumbent))
}

/** Fonction de répartition de la loi normale (approximation d'Abramowitz et Stegun, erreur < 1e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}

/** Inverse d'une matrice symétrique définie positive (Gauss-Jordan, petites tailles : quelques dizaines de modèles). */
function inverseMatrix(matrix: number[][]): number[][] {
  const n = matrix.length
  const a = matrix.map((row, r) => [...row, ...Array.from({ length: n }, (_, c) => (c === r ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const div = a[col][col]
    for (let c = 0; c < 2 * n; c++) a[col][c] /= div
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (factor === 0) continue
      for (let c = 0; c < 2 * n; c++) a[r][c] -= factor * a[col][c]
    }
  }
  return a.map((row) => row.slice(n))
}

/** Ce qu'il faut savoir d'un modèle pour composer une session (rempli par hardwareScan.ts, getDuelCandidates). */
export interface DuelPick {
  model: string
  vramGb: number
  note: number | null
  duels: number
  inUse: boolean
  /**
   * Le groupe de rôles qu'il peut tenir : `card` (tient sur la carte : Faible et Moyen), `ram` (seulement en débordant
   * sur la RAM : Élevé), ou un seul groupe pour le Code. Absent = un seul groupe.
   */
  group?: string
}

/**
 * Les modèles d'une session de `count` modèles. Toujours les mêmes pour les mêmes données — le poids annoncé avant
 * de lancer est donc exactement celui qui sera téléchargé :
 * 1. ceux que Jaris utilise déjà pour la catégorie (un autre doit pouvoir les détrôner), les mieux notés d'abord ;
 * 2. puis, à tour de rôle dans chaque groupe, ceux qui ont joué le moins de duels (chaque session en fait découvrir
 *    d'autres), à égalité les mieux notés. Sans les groupes, la machine de Léo (8 Go) ne recevait que des modèles de
 *    27 milliards de paramètres, mieux notés : aucun challenger pour Faible et Moyen, qui doivent tenir sur la carte.
 */
export function selectDuelModels(candidates: readonly DuelPick[], count: number): string[] {
  const byNote = (a: DuelPick, b: DuelPick): number => {
    if (a.note !== null && b.note !== null && a.note !== b.note) return b.note - a.note
    if (a.note !== null && b.note === null) return -1
    if (a.note === null && b.note !== null) return 1
    return a.model.localeCompare(b.model)
  }
  const byNovelty = (a: DuelPick, b: DuelPick): number => a.duels - b.duels || byNote(a, b)
  const used = candidates.filter((c) => c.inUse).sort(byNote)
  const groups = new Map<string, DuelPick[]>()
  for (const c of candidates) {
    if (c.inUse) continue
    const key = c.group ?? ''
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  // Le groupe dont le premier candidat passe avant les autres commence ; ensuite, chacun son tour.
  const queues = [...groups.values()].map((group) => group.sort(byNovelty)).sort((a, b) => byNovelty(a[0], b[0]))
  const others: DuelPick[] = []
  for (let turn = 0; queues.some((q) => q.length); turn++) {
    const next = queues[turn % queues.length].shift()
    if (next) others.push(next)
  }
  return [...used, ...others].slice(0, Math.max(0, count)).map((c) => c.model)
}

/** Clé d'une paire, quel que soit l'ordre A/B. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/**
 * Le prochain duel d'une session : la paire la moins jouée dans cette session (toutes les paires y passent avant
 * qu'une revienne), jamais deux fois de suite la même quand c'est possible, et A/B tirés au hasard — un modèle ne
 * doit pas être toujours « A ». `random` injectable pour les tests.
 */
export function nextDuelPair(
  models: readonly string[],
  played: ReadonlyMap<string, number>,
  last: readonly [string, string] | null,
  random: () => number = Math.random
): [string, string] | null {
  if (models.length < DUEL_MIN_MODELS) return null
  const all: Array<[string, string]> = []
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) all.push([models[i], models[j]])
  const count = (p: [string, string]): number => played.get(pairKey(p[0], p[1])) ?? 0
  const fewest = Math.min(...all.map(count))
  let pool = all.filter((p) => count(p) === fewest)
  if (last && pool.length > 1) {
    const lastKey = pairKey(last[0], last[1])
    const others = pool.filter((p) => pairKey(p[0], p[1]) !== lastKey)
    if (others.length) pool = others
  }
  const [first, second] = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
  return random() < 0.5 ? [first, second] : [second, first]
}

/** Une action faite par un modèle pendant son tour, lue dans le journal (« Outil appelé : open_app({…}) »). */
export interface DuelAction {
  tool: string
  /** Le détail utile à vérifier (nom de l'application, recherche, texte tapé…), déjà raccourci ; `null` sans détail. */
  detail: string | null
}

/** Le champ qui dit quoi vérifier, outil par outil (paramètres de tools.ts). */
const DETAIL_FIELDS: Record<string, string> = {
  open_app: 'app_name',
  set_reminder: 'message',
  look_at_screen: 'question',
  search_web: 'query',
  read_web_page: 'url',
  remember: 'title',
  recall_memory: 'title',
  type_text: 'text',
  press_key: 'key',
  media_control: 'action',
  computer_use_task: 'goal',
  generate_image: 'prompt'
}

/** Coupe un détail trop long pour une ligne (une recherche ou un texte tapé de plusieurs phrases). */
function shorten(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * L'action d'une ligne du journal, ou `null` si la ligne n'en annonce pas. Les lignes du journal restent en français
 * (diagnostic interne) : c'est sur elles qu'on lit, jamais sur une phrase affichée.
 */
export function duelActionFromLog(line: string): DuelAction | null {
  const match = line.match(/^Outil appelé : (\w+)\((.*)\)$/su)
  if (!match) {
    // Les raccourcis de Jaris sont coupés en duel ; le pilotage direct d'une action à l'écran reste une action.
    return null
  }
  const tool = match[1]
  let detail: string | null = null
  try {
    const args = JSON.parse(match[2]) as Record<string, unknown> | null
    const field = DETAIL_FIELDS[tool]
    const value = field ? args?.[field] : undefined
    if (typeof value === 'string' && value.trim()) detail = shorten(value)
    else if (typeof value === 'number' && Number.isFinite(value)) detail = String(value)
  } catch {
    // Arguments illisibles : l'action compte quand même, sans détail.
  }
  return { tool, detail }
}
