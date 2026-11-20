import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { DUEL_SERIES_MAX, type DuelAction, type DuelCategory } from '../../shared/duel'

/**
 * Étape 382 : une série de duels Code tourne toute une nuit, sans Léo. Une mise à jour de Windows qui redémarre le PC,
 * ou Jaris fermé par erreur, ne doit pas perdre les applications déjà écrites : la série est gardée ici, duel par duel,
 * et reprise au lancement suivant (duelSession.ts, restoreDuelSeries). Un duel voté en sort (il est alors dans les votes,
 * duelStore.ts). Les applications, une par côté, sont rangées à part : `duel-series/<numéro>-a.html`.
 *
 * Les deux suivent « Déplacer » (OWNED_ENTRIES, storageRoot.ts).
 */
export const SERIES_FILE = 'duel-series.json'
export const SERIES_APPS_DIR = 'duel-series'
const seriesPath = (): string => join(getDataRoot(), SERIES_FILE)
const appsDir = (): string => join(getDataRoot(), SERIES_APPS_DIR)

export const SERIES_FORMAT = 'jaris-duel-series'
export const SERIES_VERSION = 1

export type SeriesSideStatus = 'idle' | 'done' | 'error'

export interface SeriesSideSnapshot {
  status: SeriesSideStatus
  text: string
  error: string | null
  durationMs: number | null
  /** L'application de ce côté est gardée dans duel-series/. */
  app: boolean
  /** Étape 506 : série Agentique — ce que le modèle a fait sur le PC simulé (dernier message, et ceux d'avant). */
  actions?: DuelAction[]
  earlier?: { text: string; actions: DuelAction[] }[]
  /** Étape 506 : le jugement automatique de la tâche (montré seulement après le vote). */
  check?: boolean
}

export interface SeriesRoundSnapshot {
  number: number
  pair: [string, string]
  prompt: string
  /** Étape 484 : série Vision — le nom de l'image proposée (jamais l'image). */
  sample?: string
  /** Étape 506 : série Agentique — la tâche (son identifiant) et son jeu de résultats simulés. */
  task?: { id: string; variant: number }
  a: SeriesSideSnapshot
  b: SeriesSideSnapshot
}

export interface SeriesSnapshot {
  format: typeof SERIES_FORMAT
  version: typeof SERIES_VERSION
  id: string
  createdAt: number
  perModel: number
  remote: { host: string; vramGb: number | null; ramGb: number } | null
  vramGb: number | null
  sizes: Record<string, number>
  models: string[]
  /** Les modèles téléchargés par la série et pas encore supprimés (proposés à la suppression à la fin). */
  downloaded: Record<string, number>
  dropped: number
  dropReason: string | null
  deleted: number
  /** Étape 484 : absent dans les séries d'avant (toujours Code). */
  category?: DuelCategory
  rounds: SeriesRoundSnapshot[]
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumberRecord = (v: unknown): v is Record<string, number> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((n) => typeof n === 'number' && Number.isFinite(n))

/** Étape 506 : des actions relues telles quelles (un nom d'outil, un détail court) ; tout le reste est ignoré. */
function parseActions(value: unknown): DuelAction[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((a): a is { tool: string; detail: unknown } => Boolean(a) && typeof a === 'object' && isString((a as { tool?: unknown }).tool))
    .slice(0, 50)
    .map((a) => ({ tool: a.tool.slice(0, 64), detail: isString(a.detail) ? a.detail.slice(0, 500) : null }))
}

function parseSide(value: unknown): SeriesSideSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (s.status !== 'idle' && s.status !== 'done' && s.status !== 'error') return null
  const actions = parseActions(s.actions)
  const earlier = Array.isArray(s.earlier)
    ? s.earlier
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .slice(0, 10)
        .map((e) => ({ text: isString(e.text) ? e.text : '', actions: parseActions(e.actions) }))
    : []
  return {
    status: s.status,
    text: isString(s.text) ? s.text : '',
    error: isString(s.error) ? s.error : null,
    durationMs: typeof s.durationMs === 'number' && Number.isFinite(s.durationMs) ? s.durationMs : null,
    app: s.app === true,
    ...(actions.length ? { actions } : {}),
    ...(earlier.length ? { earlier } : {}),
    ...(typeof s.check === 'boolean' ? { check: s.check } : {})
  }
}

/** Relit un fichier de série ; `null` s'il n'a pas la bonne forme (rien n'est inventé pour le compléter). */
export function parseSeriesSnapshot(value: unknown): SeriesSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (s.format !== SERIES_FORMAT || s.version !== SERIES_VERSION || !isString(s.id)) return null
  if (typeof s.perModel !== 'number' || !Number.isInteger(s.perModel) || s.perModel < 1 || s.perModel > DUEL_SERIES_MAX) return null
  if (!Array.isArray(s.models) || !s.models.every(isString) || !Array.isArray(s.rounds)) return null
  if (!isNumberRecord(s.sizes) || !isNumberRecord(s.downloaded)) return null
  let remote: SeriesSnapshot['remote'] = null
  if (s.remote !== null && s.remote !== undefined) {
    const r = s.remote as Record<string, unknown>
    if (!isString(r.host) || typeof r.ramGb !== 'number' || (r.vramGb !== null && typeof r.vramGb !== 'number')) return null
    remote = { host: r.host, vramGb: r.vramGb as number | null, ramGb: r.ramGb }
  }
  const models = new Set(s.models)
  const rounds: SeriesRoundSnapshot[] = []
  for (const raw of s.rounds) {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const pair = r.pair
    if (typeof r.number !== 'number' || !Number.isInteger(r.number) || r.number < 1 || !isString(r.prompt)) return null
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((m) => isString(m) && models.has(m)) || pair[0] === pair[1]) return null
    const a = parseSide(r.a)
    const b = parseSide(r.b)
    if (!a || !b) return null
    // Étape 484 : un nom d'image proposée seulement (lettres, chiffres, tirets, .jpg) — jamais un chemin.
    if (r.sample !== undefined && !(isString(r.sample) && /^[a-z0-9-]+\.jpg$/.test(r.sample))) return null
    // Étape 506 : un identifiant de tâche seulement (minuscules, chiffres, tirets) et un jeu de résultats 0 ou 1.
    let task: { id: string; variant: number } | null = null
    if (r.task !== undefined) {
      const raw = r.task as Record<string, unknown> | null
      if (!raw || !isString(raw.id) || !/^[a-z0-9-]{1,64}$/.test(raw.id) || (raw.variant !== 0 && raw.variant !== 1)) return null
      task = { id: raw.id, variant: raw.variant }
    }
    rounds.push({ number: r.number, pair: [pair[0], pair[1]], prompt: r.prompt, ...(isString(r.sample) ? { sample: r.sample } : {}), ...(task ? { task } : {}), a, b })
  }
  // Étape 484 : seules les catégories qui ont des séries ; absent = Code (séries d'avant).
  if (s.category !== undefined && s.category !== 'code' && s.category !== 'vision' && s.category !== 'agent') return null
  return {
    format: SERIES_FORMAT,
    version: SERIES_VERSION,
    id: s.id,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
    perModel: s.perModel,
    remote,
    vramGb: typeof s.vramGb === 'number' && Number.isFinite(s.vramGb) ? s.vramGb : null,
    sizes: s.sizes,
    models: [...models],
    downloaded: s.downloaded,
    dropped: typeof s.dropped === 'number' ? s.dropped : 0,
    dropReason: isString(s.dropReason) ? s.dropReason : null,
    deleted: typeof s.deleted === 'number' ? s.deleted : 0,
    ...(s.category === 'vision' || s.category === 'agent' ? { category: s.category as DuelCategory } : {}),
    rounds
  }
}

/** Une écriture à la fois : la dernière gagne toujours (une plus ancienne ne passe jamais après). */
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.catch(() => undefined)
  return run
}

export function saveSeries(snapshot: SeriesSnapshot): Promise<void> {
  const json = JSON.stringify(snapshot, null, 2)
  return exclusive(() => writeFileAtomic(seriesPath(), json))
}

/** La série gardée, ou `null` (aucune, ou fichier abîmé : rangé de côté par readJsonDataFile, jamais réécrit vide). */
export async function loadSeries(): Promise<SeriesSnapshot | null> {
  const read = await readJsonDataFile(seriesPath(), parseSeriesSnapshot, join(getDataRoot(), UNREADABLE_DATA_DIR), 'duel-series')
  return read.status === 'ok' ? read.value : null
}

/** Fin de la série (« Terminer », tout voté) : le fichier et les applications non votées partent. */
export function clearSeries(): Promise<void> {
  return exclusive(async () => {
    await rm(seriesPath(), { force: true })
    await rm(appsDir(), { recursive: true, force: true })
  })
}

function appPath(number: number, side: 'a' | 'b'): string | null {
  if (!Number.isInteger(number) || number < 1 || (side !== 'a' && side !== 'b')) return null
  return join(appsDir(), `${number}-${side}.html`)
}

export async function saveSeriesApp(number: number, side: 'a' | 'b', html: string): Promise<void> {
  const path = appPath(number, side)
  if (!path) throw new Error('numéro de duel invalide')
  await mkdir(appsDir(), { recursive: true })
  await writeFileAtomic(path, html)
}

export async function readSeriesApp(number: number, side: 'a' | 'b'): Promise<string | null> {
  const path = appPath(number, side)
  if (!path) return null
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
