/**
 * Étape 367 (Léo : « un score vitesse avec les tokens par seconde, comme avant avec Artificial Analysis mais avec nos
 * mesures ») : la vitesse d'un modèle mesurée sur CE PC, à la fin de chaque réponse d'Ollama (`eval_count` /
 * `eval_duration`). C'est la seule vitesse de Jaris (étape 498) : elle sert au choix de Faible et de Moyen.
 *
 * Module pur : aucun accès au disque ni à Ollama (speedStore.ts garde les mesures, hardwareScan.ts s'en sert).
 */

/** Une réponse de quelques mots ne mesure rien (le temps est dominé par le premier mot). */
export const SPEED_MIN_TOKENS = 20
/** Mesures gardées par modèle : la vitesse retenue est leur médiane (une mesure faussée ne compte pas). */
export const SPEED_SAMPLES_KEPT = 10

/** Mesures en tokens par seconde, par modèle (clé : speedKey). */
export type SpeedSamples = Record<string, number[]>

/**
 * Où vient la vitesse affichée et utilisée : `measured`, mesurée sur ce PC. Étape 498 (Léo : « supprime toutes les
 * vitesses, tous les trucs d'Artificial Analysis, on va les mesurer sur le PC ») : plus de vitesse publiée ni de
 * vitesse « estimée » à partir d'elle — sans mesure ici, la vitesse est inconnue (`null`).
 */
export type SpeedKind = 'measured'

export interface ResolvedSpeed {
  speed: number | null
  kind: SpeedKind | null
}

/** Ollama liste un modèle sans tag sous `:latest` : les deux noms désignent la même mesure. */
export function speedKey(model: string): string {
  return model.trim().replace(/:latest$/i, '')
}

/** Tokens par seconde d'une réponse, ou `null` si elle est trop courte ou ses chiffres inutilisables. */
export function sampleSpeed(tokens: number | undefined, ms: number | undefined): number | null {
  if (typeof tokens !== 'number' || typeof ms !== 'number') return null
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens < SPEED_MIN_TOKENS || ms <= 0) return null
  const speed = tokens / (ms / 1000)
  return Number.isFinite(speed) && speed > 0 ? speed : null
}

/** Ajoute une mesure, en ne gardant que les SPEED_SAMPLES_KEPT dernières. Ne modifie pas `samples`. */
export function addSpeedSample(samples: SpeedSamples, model: string, speed: number): SpeedSamples {
  const key = speedKey(model)
  const previous = samples[key] ?? []
  return { ...samples, [key]: [...previous, speed].slice(-SPEED_SAMPLES_KEPT) }
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** La vitesse retenue de chaque modèle mesuré : la médiane de ses dernières mesures. */
export function measuredSpeeds(samples: SpeedSamples): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [model, values] of Object.entries(samples)) {
    const value = median(values)
    if (value !== null) result[model] = value
  }
  return result
}

/** Fichier relu : tout ce qui n'a pas la bonne forme est ignoré, jamais une valeur inventée. */
export function parseSpeedSamples(value: unknown): SpeedSamples | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: SpeedSamples = {}
  for (const [model, values] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue
    const kept = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0).slice(-SPEED_SAMPLES_KEPT)
    if (kept.length) result[speedKey(model)] = kept
  }
  return result
}

/** La vitesse d'un modèle pour CE PC : sa mesure ici, sinon inconnue — jamais une vitesse venue d'ailleurs. */
export function resolveSpeed(model: string, measured: Record<string, number>): ResolvedSpeed {
  const own = measured[speedKey(model)]
  return own === undefined ? { speed: null, kind: null } : { speed: own, kind: 'measured' }
}
