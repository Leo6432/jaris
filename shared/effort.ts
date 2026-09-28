/**
 * Effort de réflexion (étape 191, Léo : « même présentation que ChatGPT… ajoute effort et modèle »).
 *
 * Chaque modèle a SES niveaux, vérifiés sur les fiches officielles (étape 191) : qwen3.8 = off/low/medium/xhigh
 * (par défaut xhigh), gpt-oss = low/medium/high, granite4.2 = off/low/high, la plupart des autres = réfléchit
 * ou pas, et certains ne réfléchissent pas du tout. Jaris envoyait « high » à tous : un modèle qui ne connaît
 * pas ce mot retombe sur SON niveau par défaut (documentation d'Ollama) — qwen3.8 réfléchissait donc au
 * maximum sans que personne l'ait demandé.
 *
 * L'écran propose donc UNE échelle commune à cinq crans, et ce module la traduit vers le niveau réel le plus
 * proche que le modèle accepte, d'après ce qu'Ollama annonce lui-même (`/api/show` : `capabilities` et
 * `thinking.values`). Module pur : partagé par le main et l'écran, testé sans Ollama.
 */

export type EffortChoice = 'none' | 'low' | 'medium' | 'high' | 'max'

export const EFFORT_STEPS: ReadonlyArray<{ value: EffortChoice; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyenne' },
  { value: 'high', label: 'Élevée' },
  { value: 'max', label: 'Maximale' }
]

export function isEffortChoice(value: unknown): value is EffortChoice {
  return EFFORT_STEPS.some((step) => step.value === value)
}

export function effortLabel(choice: EffortChoice | null): string {
  return EFFORT_STEPS.find((step) => step.value === choice)?.label ?? 'Auto'
}

/** Ce qu'Ollama dit de la réflexion d'un modèle (`/api/show`). `null` partout = Ollama n'a rien dit. */
export interface ModelThinking {
  /** `capabilities` contient « thinking » ; `null` si Ollama ne donne pas la liste. */
  canThink: boolean | null
  /** `thinking.values` : niveaux nommés (« low »…) et/ou true/false. `null` si absent. */
  values: Array<string | boolean> | null
  default: string | boolean | null
}

/** Ce qu'on envoie à Ollama dans `think` : un niveau du modèle, true/false, ou rien (comportement habituel). */
export type ThinkValue = string | boolean

const EFFORT_RANK: Record<EffortChoice, number> = { none: 0, low: 1, medium: 2, high: 3, max: 4 }

/** Rang des noms de niveaux connus ; un nom inconnu est placé d'après sa position dans la liste du modèle. */
const KNOWN_RANK: Record<string, number> = { minimal: 0.5, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }

function rankedLevels(values: Array<string | boolean>): Array<{ name: string; rank: number }> {
  const named = values.filter((v): v is string => typeof v === 'string')
  return named.map((name, index) => ({
    name,
    rank: KNOWN_RANK[name.toLowerCase()] ?? 1 + (named.length > 1 ? (3 * index) / (named.length - 1) : 1)
  }))
}

export interface ResolvedEffort {
  /** À envoyer dans `think` ; `undefined` = ne rien changer au comportement habituel de Jaris. */
  think: ThinkValue | undefined
  /** Ce que le modèle fera vraiment, en clair : « medium », « sans réflexion », « ne réfléchit pas »… */
  applied: string
}

/**
 * Traduit le cran choisi vers ce que CE modèle accepte. Le niveau le plus proche l'emporte ; à égalité, le
 * plus haut (on a demandé « Élevée », pas « Moyenne »). Un modèle qui ne sait pas couper sa réflexion (gpt-oss)
 * reçoit son plus bas niveau pour « Aucune ».
 */
export function resolveEffort(choice: EffortChoice | null, meta: ModelThinking | null): ResolvedEffort {
  if (choice === null) return { think: undefined, applied: 'automatique' }
  if (!meta || (meta.canThink === null && !meta.values)) {
    // Ollama n'a rien dit : couper la réflexion reste sûr, le reste garde le comportement habituel.
    return choice === 'none' ? { think: false, applied: 'sans réflexion' } : { think: undefined, applied: 'automatique' }
  }
  if (meta.canThink === false && !meta.values) return { think: undefined, applied: 'ne réfléchit pas' }

  const values = meta.values ?? [true, false]
  const levels = rankedLevels(values)
  const canTurnOff = values.includes(false)

  if (choice === 'none') {
    if (canTurnOff || !levels.length) return { think: false, applied: 'sans réflexion' }
    const lowest = levels.reduce((a, b) => (b.rank < a.rank ? b : a))
    return { think: lowest.name, applied: lowest.name }
  }
  if (!levels.length) return { think: true, applied: 'avec réflexion' }

  const target = EFFORT_RANK[choice]
  const best = levels.reduce((a, b) => {
    const da = Math.abs(a.rank - target)
    const db = Math.abs(b.rank - target)
    return db < da || (db === da && b.rank > a.rank) ? b : a
  })
  return { think: best.name, applied: best.name }
}

/** Les niveaux du modèle, pour l'écran : « off · low · medium · xhigh », « avec ou sans », « ne réfléchit pas ». */
export function describeModelThinking(meta: ModelThinking | null): string {
  if (!meta || (meta.canThink === null && !meta.values)) return 'inconnu'
  if (meta.canThink === false && !meta.values) return 'ne réfléchit pas'
  const values = meta.values ?? [true, false]
  const levels = rankedLevels(values).map((level) => level.name)
  if (!levels.length) return values.includes(false) ? 'avec ou sans réflexion' : 'réfléchit toujours'
  return [...(values.includes(false) ? ['off'] : []), ...levels].join(' · ')
}

/** Lecture tolérante de la réponse de `/api/show` : un champ absent ou d'un type inattendu vaut « inconnu ». */
export function parseModelThinking(data: unknown): ModelThinking {
  const body = (data ?? {}) as { capabilities?: unknown; thinking?: { values?: unknown; default?: unknown } }
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : null
  const rawValues = Array.isArray(body.thinking?.values) ? body.thinking.values : null
  const values = rawValues ? rawValues.filter((v): v is string | boolean => typeof v === 'string' || typeof v === 'boolean') : null
  const def = body.thinking?.default
  return {
    canThink: capabilities ? capabilities.includes('thinking') : null,
    values: values && values.length ? values : null,
    default: typeof def === 'string' || typeof def === 'boolean' ? def : null
  }
}
