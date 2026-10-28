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
 * Ce que les votes changent à la force d'un modèle. Le classement (Bradley-Terry, comme LMArena) part de la note
 * d'Artificial Analysis — « a priori » de largeur PRIOR_SIGMA_KNOWN sur l'échelle logarithmique — et chaque vote la
 * corrige. Mesuré avant de choisir (victoires de suite du moins bien noté pour passer devant) :
 *   écart   1,5×  2×  3×
 *   σ 0,7    1    2   3   — un seul vote changeait souvent le modèle Élevé (les mieux notés sont proches)
 *   σ 0,5    2    3   5   — retenu : jamais un seul vote, mais des votes constants finissent toujours par décider
 * Avec beaucoup de votes, ce sont les votes qui décident, plus Artificial Analysis — la demande de Léo.
 *
 * Un modèle qu'Artificial Analysis n'a jamais mesuré part de la moyenne des modèles votés, avec plus de marge : ses
 * votes lui donnent une note, qu'il n'avait pas.
 */
export const PRIOR_SIGMA_KNOWN = 0.5
export const PRIOR_SIGMA_UNKNOWN = 1.0
/** Centre de départ quand AUCUN modèle voté n'a de note publiée : une note moyenne (l'échelle compte peu ici). */
const NEUTRAL_STRENGTH = 10

export interface DuelStanding {
  model: string
  /** Force après les votes, sur l'échelle de la note de départ (Artificial Analysis). */
  strength: number
  wins: number
  losses: number
  ties: number
  duels: number
}

/**
 * Classement d'une catégorie : la force de chaque modèle VOTÉ (les autres gardent leur note d'Artificial Analysis,
 * ils n'apparaissent pas ici). `prior` donne la note de départ d'un modèle, `null` si rien n'est publié.
 *
 * Maximum a posteriori calculé par Newton coordonnée par coordonnée : le problème est concave (log-vraisemblance
 * logistique + a priori gaussien), la solution est unique et ne dépend pas de l'ordre des votes — contrairement à un
 * Elo, où le même ensemble de votes rejoué dans un autre ordre donne un autre classement.
 */
export function rankDuels(votes: readonly DuelVote[], prior: (model: string) => number | null): Map<string, DuelStanding> {
  // Résultats regroupés par paire (i < j dans l'ordre alphabétique) : ce sont les paires qu'on parcourt, pas les votes.
  const pairs = new Map<string, { i: string; j: string; n: number; scoreI: number }>()
  const standings = new Map<string, DuelStanding>()
  const standing = (model: string): DuelStanding => {
    let s = standings.get(model)
    if (!s) {
      s = { model, strength: 0, wins: 0, losses: 0, ties: 0, duels: 0 }
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
  const known = models.map((m) => prior(m)).filter((v): v is number => v !== null && v > 0).map(Math.log)
  const fallback = known.length ? known.reduce((sum, v) => sum + v, 0) / known.length : Math.log(NEUTRAL_STRENGTH)
  const center = new Map<string, number>()
  const precision = new Map<string, number>()
  for (const m of models) {
    const p = prior(m)
    const has = p !== null && p > 0
    center.set(m, has ? Math.log(p) : fallback)
    precision.set(m, 1 / (has ? PRIOR_SIGMA_KNOWN : PRIOR_SIGMA_UNKNOWN) ** 2)
  }
  const byModel = new Map<string, Array<{ other: string; n: number; score: number }>>()
  for (const m of models) byModel.set(m, [])
  for (const { i, j, n, scoreI } of pairs.values()) {
    byModel.get(i)?.push({ other: j, n, score: scoreI })
    byModel.get(j)?.push({ other: i, n, score: n - scoreI })
  }

  const x = new Map(center)
  const logistic = (d: number): number => 1 / (1 + Math.exp(-d))
  for (let round = 0; round < 1000; round++) {
    let largest = 0
    for (const m of models) {
      const xm = x.get(m) as number
      const prec = precision.get(m) as number
      let gradient = -(xm - (center.get(m) as number)) * prec
      let curvature = prec
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
  for (const m of models) standing(m).strength = Math.exp(x.get(m) as number)
  return standings
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
