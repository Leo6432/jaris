import type { CodeActivity } from '../../shared/ipc'
import {
  MAX_CODE_REPOS,
  MAX_CODE_TURNS,
  isCodeConversationKey,
  isCodeRepoEntry,
  mergeCodeConversations,
  sanitizeCodeConversations,
  type CodeConversationsData,
  type CodeRepoEntry
} from '../../shared/codeConversations'

/**
 * Les conversations du mode Code (étape 288, Léo : « c'est bizarre, je suis dans le chat en train de parler et je
 * vois aucune conversation à gauche »). Chaque élément de la liste de gauche — une application générée, ou un dépôt
 * GitHub sur lequel Jaris a travaillé — garde sa conversation : la rouvrir la retrouve, comme dans le Chat.
 *
 * Gardées par le processus principal dans `code-conversations.json`, dans le dossier de données (elles survivent à un
 * redémarrage ET à un « Déplacer », voir shared/codeConversations.ts) : lues une fois au premier usage, puis gardées
 * en mémoire ici ; chaque changement est envoyé au main, qui l'écrit. Sans réponse du main, elles tiennent au moins
 * le temps de la session au lieu de disparaître au premier clic — et rien n'est écrit par-dessus le fichier.
 */
/** Un fichier de la carte de fin (étape 290) : ses lignes ajoutées et retirées. */
export interface ChangedFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
}

export type ChatTurn =
  | { id: number; kind: 'user' | 'reply' | 'note'; text: string }
  | { id: number; kind: 'activity'; activity: CodeActivity }
  /** Étape 290 : « Travaillé pendant 2 min 10 » (ou « Arrêté après… »), à la place du bandeau vert de fin. */
  | { id: number; kind: 'worked'; durationMs: number; stopped?: boolean }
  /**
   * Étape 290 : la carte « N fichiers modifiés », comme ChatGPT. Étape 302 : `commit`, une fois ces changements
   * enregistrés sur GitHub — gardé avec la conversation, pour pouvoir les revoir même après une relance de Jaris.
   */
  | { id: number; kind: 'changes'; files: ChangedFile[]; commit?: { url: string; sha: string } }

/**
 * Étape 302 (Léo : « pourquoi les boutons disparaissent quand je relance ») : le commit enregistré est attaché à la
 * carte du DERNIER travail. Ce qui est préparé ne vit qu'en mémoire (fermer Jaris l'abandonne, voir githubSession.ts)
 * et disparaît donc avec ses boutons ; un commit, lui, existe pour de bon sur GitHub et reste consultable. Pure.
 */
export function attachCommit(turns: ChatTurn[], commit: { url: string; sha: string }): ChatTurn[] {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn.kind !== 'changes') continue
    const next = [...turns]
    next[index] = { ...turn, commit }
    return next
  }
  return turns
}

/** Un dépôt de la liste ; `at` : dernière ouverture ou dernier travail de Jaris dessus (ms), la liste est triée par là. */
export type RecentRepo = CodeRepoEntry

/** Ancien stockage de la fenêtre (avant le fichier) : repris une fois, puis vidé. */
const LEGACY_REPOS_KEY = 'jaris.codeRepos'
const LEGACY_TURNS_PREFIX = 'jaris.codeConversation.'

export const appConversationKey = (path: string): string => `app:${path}`
export const repoConversationKey = (fullName: string): string => `repo:${fullName}`

const isTurns = (value: unknown): value is ChatTurn[] =>
  Array.isArray(value) && value.every((turn) => turn && typeof turn === 'object' && typeof (turn as ChatTurn).id === 'number' && typeof (turn as ChatTurn).kind === 'string')

type Bridge = Pick<Window['jaris'], 'loadCodeConversations' | 'saveCodeConversation' | 'saveCodeRepos' | 'importCodeConversations'>

interface Store {
  repos: RecentRepo[]
  conversations: Map<string, ChatTurn[]>
  /** `null` : le fichier n'a pas pu être lu — on ne lui envoie RIEN, pour ne jamais l'écraser avec une liste vide. */
  bridge: Bridge | null
}

let store: Store | null = null

function findBridge(): Bridge | null {
  try {
    const jaris = (globalThis as { window?: { jaris?: Partial<Bridge> } }).window?.jaris
    return jaris && typeof jaris.loadCodeConversations === 'function' ? (jaris as Bridge) : null
  } catch {
    return null
  }
}

function fromData(data: CodeConversationsData | null): Pick<Store, 'repos' | 'conversations'> {
  const conversations = new Map<string, ChatTurn[]>()
  for (const [key, turns] of Object.entries(data?.conversations ?? {})) {
    if (isCodeConversationKey(key) && isTurns(turns) && turns.length > 0) conversations.set(key, turns)
  }
  return { repos: (data?.repos ?? []).filter(isCodeRepoEntry).slice(0, MAX_CODE_REPOS), conversations }
}

/**
 * Ce que l'ancienne version gardait dans le stockage de la fenêtre (avant le fichier). `null` s'il n'y a rien.
 * Seules les entrées lisibles sont reprises (et donc effacées ensuite) : une entrée abîmée reste où elle est.
 */
export function readLegacyCodeConversations(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>
): { data: CodeConversationsData; keys: string[] } | null {
  const data: CodeConversationsData = { repos: [], conversations: {} }
  const keys: string[] = []
  const names: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index)
    if (name) names.push(name)
  }
  for (const name of names) {
    if (name !== LEGACY_REPOS_KEY && !name.startsWith(LEGACY_TURNS_PREFIX)) continue
    let value: unknown
    try {
      value = JSON.parse(storage.getItem(name) ?? '')
    } catch {
      continue
    }
    if (name === LEGACY_REPOS_KEY) {
      if (!Array.isArray(value)) continue
      data.repos = value.filter(isCodeRepoEntry)
      keys.push(name)
      continue
    }
    const key = name.slice(LEGACY_TURNS_PREFIX.length)
    if (!isCodeConversationKey(key) || !isTurns(value) || value.length === 0) continue
    data.conversations[key] = value.slice(-MAX_CODE_TURNS)
    keys.push(name)
  }
  return keys.length > 0 ? { data, keys } : null
}

/**
 * Reprise (premier lancement de cette version) : les anciennes conversations sont affichées tout de suite, ajoutées au
 * fichier sans y écraser quoi que ce soit, puis retirées du stockage de la fenêtre — seulement une fois l'écriture
 * CONFIRMÉE par le main. Si elle échoue, elles restent où elles sont et seront reprises au lancement suivant.
 */
function adoptLegacy(target: Store): void {
  let storage: Storage
  let legacy: ReturnType<typeof readLegacyCodeConversations>
  try {
    storage = localStorage
    legacy = readLegacyCodeConversations(storage)
  } catch {
    return // Stockage refusé (page de test sur about:blank…) : rien à reprendre.
  }
  if (!legacy) return
  const merged = fromData(
    mergeCodeConversations({ repos: target.repos, conversations: Object.fromEntries(target.conversations) }, legacy.data)
  )
  target.repos = merged.repos
  target.conversations = merged.conversations
  if (!target.bridge) return
  const { keys } = legacy
  target.bridge.importCodeConversations(legacy.data).then(
    () => {
      for (const key of keys) {
        try {
          storage.removeItem(key)
        } catch {
          // Déjà dans le fichier : une entrée restée ici est simplement ignorée au prochain lancement.
        }
      }
    },
    (err: unknown) => console.error('[code] Reprise des anciennes conversations du mode Code impossible :', err)
  )
}

function ensureStore(): Store {
  if (store) return store
  const bridge = findBridge()
  let loaded: CodeConversationsData | null = null
  try {
    // Revérifié ici aussi : une réponse inattendue (pas une liste de conversations) compte comme « pas de fichier lu ».
    loaded = bridge ? sanitizeCodeConversations(bridge.loadCodeConversations()) : null
  } catch {
    loaded = null
  }
  store = { ...fromData(loaded), bridge: loaded ? bridge : null }
  adoptLegacy(store)
  return store
}

function send(write: (bridge: Bridge) => Promise<void>): void {
  const bridge = ensureStore().bridge
  if (!bridge) return
  write(bridge).catch((err: unknown) => console.error('[code] Conversation du mode Code non enregistrée :', err))
}

export function loadConversation(key: string): ChatTurn[] {
  return ensureStore().conversations.get(key) ?? []
}

export function saveConversation(key: string, turns: ChatTurn[]): void {
  const current = ensureStore()
  // Rouvrir une conversation la renvoie ici telle quelle (même liste) : rien de neuf, rien à réécrire sur le disque.
  if (current.conversations.get(key) === turns) return
  const kept = turns.length > MAX_CODE_TURNS ? turns.slice(-MAX_CODE_TURNS) : turns
  if (kept.length > 0) current.conversations.set(key, kept)
  else current.conversations.delete(key)
  send((bridge) => bridge.saveCodeConversation(key, kept.length > 0 ? kept : null))
}

export function forgetConversation(key: string): void {
  ensureStore().conversations.delete(key)
  send((bridge) => bridge.saveCodeConversation(key, null))
}

export function loadRecentRepos(): RecentRepo[] {
  return ensureStore().repos
}

function saveRecentRepos(repos: RecentRepo[]): RecentRepo[] {
  const current = ensureStore()
  const saved = repos.slice(0, MAX_CODE_REPOS)
  current.repos = saved
  send((bridge) => bridge.saveCodeRepos(saved))
  return saved
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
