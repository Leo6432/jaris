import { mkdir, readFile } from 'fs/promises'
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

let cache: DuelVote[] = []
let loaded = false

/** Abîmé, le fichier est rangé de côté (atomicFile.ts) ; momentanément illisible, l'erreur remonte sans rien réécrire. */
async function readVotes(): Promise<DuelVote[]> {
  const read = await readJsonDataFile(storePath, parseDuelVotes, unreadableDir, 'duel-votes')
  return read.status === 'ok' ? read.value : []
}

/** Relit les votes au démarrage. Un échec laisse la liste vide en mémoire : Jaris choisit alors sans les votes. */
export async function loadDuelVotes(): Promise<DuelVote[]> {
  try {
    cache = await readVotes()
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
    cache = votes
    loaded = true
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
