import type { CodeActivity } from '../../shared/ipc'
import { readSaved, writeSaved } from './savedSetting'

/**
 * Les conversations du mode Code (étape 288, Léo : « c'est bizarre, je suis dans le chat en train de parler et je
 * vois aucune conversation à gauche »). Chaque élément de la liste de gauche — une application générée, ou un dépôt
 * GitHub sur lequel Jaris a travaillé — garde sa conversation : la rouvrir la retrouve, comme dans le Chat.
 *
 * Gardées dans le stockage de la fenêtre (elles survivent à un redémarrage), avec une copie en mémoire : si ce
 * stockage est refusé, elles tiennent au moins le temps de la session au lieu de disparaître au premier clic.
 */
export type ChatTurn =
  | { id: number; kind: 'user' | 'reply' | 'note'; text: string }
  | { id: number; kind: 'activity'; activity: CodeActivity }

export interface RecentRepo {
  fullName: string
  /** Dernière ouverture ou dernier travail de Jaris dessus (ms) : la liste est triée par là, comme le Chat. */
  at: number
}

/** Une conversation garde ses derniers messages : au-delà, les plus anciens partent (le stockage est limité). */
const MAX_TURNS = 200
const MAX_REPOS = 30
const REPOS_KEY = 'jaris.codeRepos'
const turnsKey = (key: string): string => `jaris.codeConversation.${key}`

const memory = new Map<string, ChatTurn[]>()
let memoryRepos: RecentRepo[] | null = null

export const appConversationKey = (path: string): string => `app:${path}`
export const repoConversationKey = (fullName: string): string => `repo:${fullName}`

function parse<T>(raw: string | null, valid: (value: unknown) => value is T): T | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return valid(value) ? value : null
  } catch {
    return null
  }
}

const isTurns = (value: unknown): value is ChatTurn[] =>
  Array.isArray(value) && value.every((turn) => turn && typeof turn === 'object' && typeof (turn as ChatTurn).id === 'number' && typeof (turn as ChatTurn).kind === 'string')

const isRepos = (value: unknown): value is RecentRepo[] =>
  Array.isArray(value) && value.every((repo) => repo && typeof repo.fullName === 'string' && typeof repo.at === 'number')

export function loadConversation(key: string): ChatTurn[] {
  return memory.get(key) ?? parse(readSaved(turnsKey(key)), isTurns) ?? []
}

export function saveConversation(key: string, turns: ChatTurn[]): void {
  const kept = turns.slice(-MAX_TURNS)
  memory.set(key, kept)
  writeSaved(turnsKey(key), kept.length > 0 ? JSON.stringify(kept) : null)
}

export function forgetConversation(key: string): void {
  memory.delete(key)
  writeSaved(turnsKey(key), null)
}

export function loadRecentRepos(): RecentRepo[] {
  memoryRepos ??= parse(readSaved(REPOS_KEY), isRepos) ?? []
  return memoryRepos
}

function saveRecentRepos(repos: RecentRepo[]): RecentRepo[] {
  memoryRepos = repos.slice(0, MAX_REPOS)
  writeSaved(REPOS_KEY, JSON.stringify(memoryRepos))
  return memoryRepos
}

/** Le dépôt remonte en tête de la liste (ouvert, ou Jaris vient d'y travailler). */
export function rememberRepo(fullName: string, at = Date.now()): RecentRepo[] {
  const others = loadRecentRepos().filter((repo) => repo.fullName.toLowerCase() !== fullName.toLowerCase())
  return saveRecentRepos([{ fullName, at }, ...others])
}

/** Retiré de la LISTE seulement : le dépôt, lui, reste sur GitHub. */
export function forgetRepo(fullName: string): RecentRepo[] {
  forgetConversation(repoConversationKey(fullName))
  return saveRecentRepos(loadRecentRepos().filter((repo) => repo.fullName.toLowerCase() !== fullName.toLowerCase()))
}
