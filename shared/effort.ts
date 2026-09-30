/**
 * Réflexion (« think ») du modèle choisi — étapes 191 puis 192.
 *
 * Étape 191 : un curseur commun à cinq crans (Aucune → Maximale), traduit vers le niveau le plus proche. Léo
 * (étape 192) : « faut d'abord choisir le modèle… on peut choisir un modèle qui a rien et choisir max ». Il
 * avait raison : une échelle commune affiche des choix qui n'existent pas sur le modèle. On ne propose donc
 * plus que ce que CE modèle annonce lui-même dans `/api/show` (`capabilities` et `thinking.values`) :
 *   - des niveaux nommés (qwen3.8 : off/low/medium/xhigh, gpt-oss : low/medium/high) → ces niveaux-là ;
 *   - seulement avec/sans (qwen3.5, gemma4…) → on / off ;
 *   - aucune réflexion (qwen3-coder, devstral…) → rien du tout.
 * Le défaut d'origine reste corrigé : Jaris envoyait « high » à tous, et un modèle qui ne connaît pas ce mot
 * retombe sur SON niveau par défaut (qwen3.8 : xhigh, le maximum).
 *
 * Module pur : partagé par le main et l'écran, testé sans Ollama.
 */

/** Ce qu'Ollama dit de la réflexion d'un modèle (`/api/show`). `null` partout = Ollama n'a rien dit. */
export interface ModelThinking {
  /** `capabilities` contient « thinking » ; `null` si Ollama ne donne pas la liste. */
  canThink: boolean | null
  /** `thinking.values` : niveaux nommés (« low »…) et/ou true/false. `null` si absent. */
  values: Array<string | boolean> | null
  default: string | boolean | null
}

/** Ce qu'on envoie à Ollama dans `think` : un niveau du modèle, ou true/false. */
export type ThinkValue = string | boolean

/** `levels` : niveaux nommés ; `toggle` : avec ou sans ; `none` : ne réfléchit pas ; `unknown` : Ollama muet. */
export type ThinkingKind = 'levels' | 'toggle' | 'none' | 'unknown'

export interface ThinkOption {
  value: ThinkValue
  label: string
}

/** Le modèle choisi et ses vrais choix de réflexion, tels que les montre le sélecteur. */
export interface ModelThinkingChoice {
  model: string
  kind: ThinkingKind
  options: ThinkOption[]
  /** Réglage enregistré pour ce modèle ; `null` = Auto (Jaris décide, comme avant). */
  selected: ThinkValue | null
}

/** Réglage enregistré : lié au modèle pour lequel il a été choisi, jamais appliqué à un autre. */
export interface StoredThinkChoice {
  model: string
  think: ThinkValue
}

export function thinkingKind(meta: ModelThinking | null): ThinkingKind {
  if (!meta || (meta.canThink === null && !meta.values)) return 'unknown'
  if (meta.canThink === false && !meta.values) return 'none'
  const values = meta.values ?? [true, false]
  if (values.some((v) => typeof v === 'string')) return 'levels'
  return values.includes(true) ? 'toggle' : 'none'
}

/** Les choix affichés, dans l'ordre croissant : « off » d'abord s'il existe, puis les niveaux du modèle. */
export function thinkOptions(meta: ModelThinking | null): ThinkOption[] {
  const kind = thinkingKind(meta)
  if (kind === 'toggle') return [{ value: false, label: thinkLabel(false) }, { value: true, label: thinkLabel(true) }]
  if (kind !== 'levels') return []
  const values = meta?.values ?? []
  const named = values.filter((v): v is string => typeof v === 'string')
  return [...(values.includes(false) ? [{ value: false as ThinkValue, label: thinkLabel(false) }] : []), ...named.map((name) => ({ value: name, label: thinkLabel(name) }))]
}

/** Vrai seulement si CE modèle annonce accepter cette valeur : jamais « max » sur un modèle qui n'a rien. */
export function isAcceptedThink(value: unknown, meta: ModelThinking | null): value is ThinkValue {
  return thinkOptions(meta).some((option) => option.value === value)
}

/**
 * Étape 210 (Léo : « mets comme Claude : faible, moyen, élevé, et pour l'original mets extra ») : les niveaux
 * techniques d'Ollama (low/medium/high/xhigh) affichés en français, avec les mêmes mots que la qualité vidéo.
 * Un niveau inconnu garde son nom d'origine plutôt que d'être deviné.
 */
const THINK_LABELS: Record<string, string> = {
  off: 'Désactivée',
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Extra',
  max: 'Max'
}

export function thinkLabel(value: ThinkValue): string {
  if (value === true) return 'Activée'
  if (value === false) return 'Désactivée'
  return THINK_LABELS[value] ?? value
}

/**
 * La réflexion à envoyer : le réglage enregistré s'il a été choisi pour CE modèle et que ce modèle l'accepte
 * toujours, sinon `undefined` (Jaris garde son comportement habituel).
 */
export function chosenThink(stored: StoredThinkChoice | null | undefined, model: string, meta: ModelThinking | null): ThinkValue | undefined {
  if (!stored || stored.model !== model) return undefined
  return isAcceptedThink(stored.think, meta) ? stored.think : undefined
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
