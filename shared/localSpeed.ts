/**
 * Étape 367 (Léo : « un score vitesse avec les tokens par seconde, comme avant avec Artificial Analysis mais avec nos
 * mesures ») : la vitesse d'un modèle mesurée sur CE PC (`eval_count` / `eval_duration` d'Ollama). C'est la seule vitesse
 * de Jaris (étape 498) : elle sert au choix de Faible et de Moyen. Depuis l'étape 514, elle vient du TEST DE VITESSE
 * (mêmes questions pour tous), plus des réponses de tous les jours.
 *
 * Module pur : aucun accès au disque ni à Ollama (speedStore.ts garde les mesures, hardwareScan.ts s'en sert).
 */

/** Une réponse de quelques mots ne mesure rien (le temps est dominé par le premier mot). */
export const SPEED_MIN_TOKENS = 20

/**
 * Étape 514 (Léo : « un bouton pour tester la vitesse de tous les modèles, choisir ceux que je veux ou tout, et les
 * mêmes questions pour tout le monde — si on fait comme LFM, chaque modèle n'a pas les mêmes questions, donc enlève »)
 * : la vitesse ne vient plus de l'usage de tous les jours (des questions différentes d'un modèle à l'autre), mais d'un
 * TEST : les mêmes questions, les mêmes réglages, pour chaque modèle. Ne JAMAIS changer ces questions ni ces réglages
 * sans remesurer tout le monde : les vitesses ne seraient plus comparables.
 */
export const SPEED_TEST_PROMPTS = [
  "Raconte une histoire d'au moins 300 mots sur un phare au bord de la mer, avec un gardien et une tempête.",
  "Explique en au moins 300 mots comment fonctionne un moteur de voiture, étape par étape, pour un enfant de 12 ans.",
  "Écris une lettre d'au moins 300 mots à un ami pour lui raconter tes vacances à la montagne."
] as const
/** Tokens écrits par question : assez pour une mesure stable, sans rendre le test long. */
export const SPEED_TEST_MAX_TOKENS = 256
/** La fenêtre de contexte des conversations de Jaris (AUTO_CONTEXT_STEPS[0], ollama.ts) : la vitesse d'un vrai usage. */
export const SPEED_TEST_NUM_CTX = 16384
/** Réglages identiques pour tous : pas de hasard, pas de réflexion cachée. */
export const SPEED_TEST_OPTIONS = { temperature: 0, seed: 42, num_predict: SPEED_TEST_MAX_TOKENS, num_ctx: SPEED_TEST_NUM_CTX } as const
/** Version des questions et réglages : un fichier d'une autre version n'est pas relu (vitesses pas comparables). */
export const SPEED_TEST_VERSION = 1

/** Tokens par seconde d'une réponse (`eval_count` / `eval_duration` en nanosecondes), `null` si inutilisable. */
export function speedOfAnswer(tokens: number | undefined, durationNs: number | undefined): number | null {
  if (typeof tokens !== 'number' || typeof durationNs !== 'number') return null
  if (!Number.isFinite(tokens) || !Number.isFinite(durationNs) || tokens < SPEED_MIN_TOKENS || durationNs <= 0) return null
  const speed = tokens / (durationNs / 1e9)
  return Number.isFinite(speed) && speed > 0 ? speed : null
}

/** Résultat du test pour un modèle : vitesse retenue (médiane des questions) et date du test. */
export interface SpeedTestResult {
  speed: number
  testedAt: string
}
export type SpeedTestResults = Record<string, SpeedTestResult>

/**
 * Où vient la vitesse affichée et utilisée : `measured`, mesurée par le test de vitesse sur CE PC ; `published`
 * (étape 517), mesurée par Léo et publiée dans Jaris pour tout le monde (shared/publishedSpeeds.ts). Sans l'une ni
 * l'autre, la vitesse est inconnue (`null`).
 */
export type SpeedKind = 'measured' | 'published'

export interface ResolvedSpeed {
  speed: number | null
  kind: SpeedKind | null
  /** Vitesse publiée : mémoire vidéo de la carte qui l'a mesurée (un modèle plus gros y débordait sur la RAM). */
  referenceVramGb?: number
}

/** Étape 517 : les vitesses publiées et la mémoire vidéo de la carte qui les a mesurées (shared/publishedSpeeds.ts). */
export interface PublishedSpeeds {
  speeds: Record<string, number>
  vramGb: number
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

export function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Fichier relu (`model-speeds.json`) : seulement la version actuelle du test ; tout le reste est ignoré. */
export function parseSpeedTestFile(value: unknown): SpeedTestResults | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const file = value as { version?: unknown; results?: unknown }
  if (file.version !== SPEED_TEST_VERSION || !file.results || typeof file.results !== 'object' || Array.isArray(file.results)) return null
  const results: SpeedTestResults = {}
  for (const [model, entry] of Object.entries(file.results as Record<string, unknown>)) {
    const { speed, testedAt } = (entry ?? {}) as { speed?: unknown; testedAt?: unknown }
    if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0 && typeof testedAt === 'string') {
      results[speedKey(model)] = { speed, testedAt }
    }
  }
  return results
}

/** Les vitesses retenues, par modèle. */
export function speedsOf(results: SpeedTestResults): Record<string, number> {
  return Object.fromEntries(Object.entries(results).map(([model, r]) => [model, r.speed]))
}

/**
 * La vitesse d'un modèle pour CE PC : son test ici d'abord, sinon la vitesse publiée (étape 517 ; main.ts passe celles
 * de Léo, shared/publishedSpeeds.ts) — jamais une valeur inventée.
 */
export function resolveSpeed(model: string, measured: Record<string, number>, published?: PublishedSpeeds): ResolvedSpeed {
  const own = measured[speedKey(model)]
  if (own !== undefined) return { speed: own, kind: 'measured' }
  const shared = published?.speeds[speedKey(model)]
  return shared === undefined ? { speed: null, kind: null } : { speed: shared, kind: 'published', referenceVramGb: published?.vramGb }
}
