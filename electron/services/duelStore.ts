import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { parseDuelVotes, type DuelVote } from '../../shared/duel'

/**
 * Étape 355 : les votes des duels, une liste dans le dossier de données de Léo (OWNED_ENTRIES : ils suivent
 * « Déplacer », et un disque rebranché les réunit par identifiant, comme les rappels).
 *
 * Gardés aussi en mémoire : le choix des modèles (hardwareScan.ts) les relit à chaque calcul, sans attendre le disque.
 */
const storePath = join(getDataRoot(), 'duel-votes.json')
/** Les applications des duels Code, une par côté : `<identifiant du vote>-a.html`. */
const appsDir = join(getDataRoot(), 'duel-apps')
const unreadableDir = join(getDataRoot(), UNREADABLE_DATA_DIR)
/**
 * Étape 398 (Léo : « dans l'historique, pouvoir supprimer des choses ou tout supprimer ») : les identifiants des votes
 * supprimés. Gardés à part pour deux raisons : un vote déjà livré avec Jaris (étape 369) ne compte plus non plus sur ce
 * PC, et un disque rebranché (union par identifiant) ne ramène pas un vote supprimé.
 */
const deletedPath = join(getDataRoot(), 'duel-votes-deleted.json')

let cache: DuelVote[] = []
let loaded = false
/** Nouvel objet à chaque changement : getRankingVotes compare par référence. */
let deleted: ReadonlySet<string> = new Set()

function parseDeletedIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((item) => {
    const id = (item as { id?: unknown } | null)?.id
    return typeof id === 'string' && id ? [id] : []
  })
}

async function readDeleted(): Promise<Set<string>> {
  const read = await readJsonDataFile(deletedPath, parseDeletedIds, unreadableDir, 'duel-votes-deleted')
  return new Set(read.status === 'ok' ? read.value : [])
}

/** Abîmé, le fichier est rangé de côté (atomicFile.ts) ; momentanément illisible, l'erreur remonte sans rien réécrire. */
async function readVotes(): Promise<DuelVote[]> {
  const read = await readJsonDataFile(storePath, parseDuelVotes, unreadableDir, 'duel-votes')
  return read.status === 'ok' ? read.value : []
}

const notDeleted = (votes: DuelVote[], ids: ReadonlySet<string>): DuelVote[] => (ids.size ? votes.filter((v) => !ids.has(v.id)) : votes)

/** Relit les votes au démarrage. Un échec laisse la liste vide en mémoire : Jaris choisit alors sans les votes. */
export async function loadDuelVotes(): Promise<DuelVote[]> {
  try {
    deleted = await readDeleted()
    cache = notDeleted(await readVotes(), deleted)
    loaded = true
  } catch (err) {
    console.error('[jaris] Votes des duels illisibles pour l’instant :', err)
  }
  return cache
}

/** Les votes connus, sans attendre le disque (vide tant que loadDuelVotes n'a pas répondu). */
export function getDuelVotes(): readonly DuelVote[] {
  return cache
}

/**
 * Étape 369 (Léo : « mets mes votes dans Jaris ») : les votes de Léo livrés avec Jaris
 * (scripts/shared-duel-votes.json, comme verified-tool-scores.md) comptent pour tout le monde dans le classement et
 * le choix des modèles. Seuls les champs utiles au calcul y sont : ni la demande ni les réponses de Léo. Ils ne
 * s'affichent jamais dans l'historique d'un autre PC (getDuelVotes reste local).
 */
let shared: DuelVote[] = []

/** Relit le fichier livré une fois au démarrage. Absent ou illisible : aucun vote partagé, jamais une erreur. */
export async function loadSharedDuelVotes(file: string): Promise<readonly DuelVote[]> {
  try {
    shared = parseDuelVotes(JSON.parse(await readFile(file, 'utf8'))) ?? []
  } catch {
    shared = []
  }
  return shared
}

let merged: { local: readonly DuelVote[]; shared: readonly DuelVote[]; deleted: ReadonlySet<string>; votes: readonly DuelVote[] } | null = null

/**
 * Votes du classement : ceux de ce PC + ceux livrés avec Jaris, un même identifiant compté une fois (le PC de Léo a
 * les deux). Même objet tant que rien ne change : main.ts met ses calculs en cache par référence.
 */
export function getRankingVotes(): readonly DuelVote[] {
  if (merged?.local === cache && merged.shared === shared && merged.deleted === deleted) return merged.votes
  const ids = new Set(cache.map((v) => v.id))
  const votes = shared.length ? [...cache, ...shared.filter((v) => !ids.has(v.id) && !deleted.has(v.id))] : cache
  merged = { local: cache, shared, deleted, votes }
  return votes
}

export function duelVotesLoaded(): boolean {
  return loaded
}

/** Une modification à la fois : relue, changée, réécrite (même raison que les rappels, reminders.ts). */
let writeChain: Promise<unknown> = Promise.resolve()
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

/** Ajoute un vote, d'un seul tenant (atomicFile.ts). Jamais deux fois le même identifiant. */
export function addDuelVote(vote: DuelVote): Promise<void> {
  return exclusive(async () => {
    const votes = await readVotes()
    if (!votes.some((v) => v.id === vote.id)) votes.push(vote)
    await writeFileAtomic(storePath, JSON.stringify(votes, null, 2))
    cache = notDeleted(votes, deleted)
    loaded = true
  })
}

/**
 * Étape 398 : supprime des votes de ce PC (`'all'` : tous), avec leurs applications gardées. Ils ne comptent plus dans
 * le classement ni dans le choix des modèles. Renvoie le nombre de votes supprimés. Les identifiants sont notés AVANT
 * de réécrire la liste : une coupure entre les deux ne ramène jamais un vote supprimé.
 */
export function deleteDuelVotes(which: readonly string[] | 'all'): Promise<number> {
  return exclusive(async () => {
    const votes = await readVotes()
    const wanted = which === 'all' ? null : new Set(which)
    const gone = votes.filter((v) => (wanted ? wanted.has(v.id) : true) && !deleted.has(v.id))
    // Un vote déjà supprimé ailleurs (ou livré avec Jaris et absent de ce PC) peut quand même être demandé.
    const ids = new Set([...gone.map((v) => v.id), ...(wanted ? [...wanted].filter((id) => VOTE_ID.test(id)) : [])])
    if (!ids.size) return 0
    const known = await readDeleted()
    const now = Date.now()
    const nextDeleted = new Set([...known, ...ids])
    await writeFileAtomic(deletedPath, JSON.stringify([...nextDeleted].map((id) => ({ id, at: now })), null, 2))
    deleted = nextDeleted
    const kept = votes.filter((v) => !nextDeleted.has(v.id))
    await writeFileAtomic(storePath, JSON.stringify(kept, null, 2))
    cache = kept
    for (const id of ids) {
      for (const side of ['a', 'b'] as const) {
        const path = appPath(id, side)
        if (path) await rm(path, { force: true }).catch(() => undefined)
      }
    }
    return gone.length
  })
}

/** Un identifiant de vote (randomUUID) : le seul nom de fichier accepté, jamais un chemin venu de l'écran. */
const VOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function appPath(voteId: string, side: 'a' | 'b'): string | null {
  if (!VOTE_ID.test(voteId) || (side !== 'a' && side !== 'b')) return null
  return join(appsDir, `${voteId}-${side}.html`)
}

/** Garde l'application d'un côté d'un duel Code, pour la rouvrir depuis l'historique. */
export async function saveDuelApp(voteId: string, side: 'a' | 'b', html: string): Promise<void> {
  const path = appPath(voteId, side)
  if (!path) throw new Error('identifiant de duel invalide')
  await mkdir(appsDir, { recursive: true })
  await writeFileAtomic(path, html)
}

/**
 * Étape 362 (Léo : « un bouton télécharger les votes, toutes les sessions depuis le début ») : tout l'historique des
 * duels en un seul fichier — chaque vote avec sa demande, ses deux réponses, ce qu'elles ont fait sur le PC, et les
 * applications des duels Code. Relu depuis le disque, pas depuis la mémoire, pour exporter exactement ce qui est gardé.
 */
export const DUEL_EXPORT_FORMAT = 'jaris-duel-votes'
export const DUEL_EXPORT_VERSION = 1

export async function buildDuelVotesExport(appVersion: string, now: Date): Promise<{ json: string; count: number }> {
  const votes = (await readVotes()).sort((a, b) => a.at - b.at)
  const apps: Record<string, string> = {}
  for (const vote of votes) {
    for (const side of ['a', 'b'] as const) {
      if (!vote.sides?.[side]?.app) continue
      const html = await readDuelApp(vote.id, side)
      if (html !== null) apps[`${vote.id}-${side}`] = html
    }
  }
  const json = JSON.stringify(
    {
      format: DUEL_EXPORT_FORMAT,
      version: DUEL_EXPORT_VERSION,
      appVersion,
      exportedAt: now.toISOString(),
      sessions: new Set(votes.map((v) => v.sessionId)).size,
      votes,
      apps
    },
    null,
    2
  )
  return { json, count: votes.length }
}

/** Nom proposé pour le fichier : jaris-votes-AAAA-MM-JJ.json (date locale). */
export function defaultDuelExportName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `jaris-votes-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

/** L'application gardée, ou `null` (identifiant inconnu, fichier absent). */
export async function readDuelApp(voteId: string, side: 'a' | 'b'): Promise<string | null> {
  const path = appPath(voteId, side)
  if (!path) return null
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
