import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { DUEL_SERIES_MAX } from '../../shared/duel'

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
}

export interface SeriesRoundSnapshot {
  number: number
  pair: [string, string]
  prompt: string
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
  rounds: SeriesRoundSnapshot[]
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumberRecord = (v: unknown): v is Record<string, number> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((n) => typeof n === 'number' && Number.isFinite(n))

function parseSide(value: unknown): SeriesSideSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (s.status !== 'idle' && s.status !== 'done' && s.status !== 'error') return null
  return {
    status: s.status,
    text: isString(s.text) ? s.text : '',
    error: isString(s.error) ? s.error : null,
    durationMs: typeof s.durationMs === 'number' && Number.isFinite(s.durationMs) ? s.durationMs : null,
    app: s.app === true
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
    rounds.push({ number: r.number, pair: [pair[0], pair[1]], prompt: r.prompt, a, b })
  }
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
