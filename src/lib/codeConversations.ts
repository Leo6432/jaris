import type { CodeActivity } from '../../shared/ipc'
import {
  MAX_CODE_REPOS,
  MAX_CODE_TURNS,
  addCodeConversation,
  isCodeConversationKey,
  isCodeRepoEntry,
  mergeCodeConversations,
  normalizeCodeConversationKey,
  sanitizeCodeConversations,
  type CodeConversationsData,
  type CodeRepoEntry
} from '../../shared/codeConversations'

/**
 * Clé d'une application : le NOM de son dossier, jamais son chemin (qui change à chaque « Déplacer ») — voir
 * shared/codeConversations.ts. Les anciennes clés « app:<chemin> » sont converties à la lecture.
 */
export { appConversationKey } from '../../shared/codeConversations'

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
    // Rangée sous la clé actuelle (nom du dossier) : l'écran ne demande plus jamais « app:<chemin> ».
    addCodeConversation(data.conversations, key, value)
    keys.push(name)
  }
  return keys.length > 0 ? { data, keys } : null
}

function readLegacy(): { storage: Storage; legacy: NonNullable<ReturnType<typeof readLegacyCodeConversations>> } | null {
  try {
    const storage = localStorage
    const legacy = readLegacyCodeConversations(storage)
    return legacy ? { storage, legacy } : null
  } catch {
    return null // Stockage refusé (page de test sur about:blank…) : rien à reprendre.
  }
}

let migration: Promise<boolean> | null = null

/**
 * Reprise de l'ancien stockage de la fenêtre (avant le fichier) : ajouté au fichier par le main SANS y écraser quoi
 * que ce soit, puis retiré du stockage de la fenêtre — seulement une fois l'écriture CONFIRMÉE. `true` quand il ne
 * reste rien à reprendre ; `false` si l'écriture a échoué (tout reste alors où c'était, et sera repris au prochain
 * appel).
 *
 * Lancée dès l'ouverture de la fenêtre principale (App.tsx), pas seulement à la première visite de l'écran Code :
 * Jaris s'ouvre sur l'Agent vocal, et un « Déplacer » fait sans être passé par Code effaçait l'ancien dossier de
 * Chromium — avec ce stockage jamais repris. Pour la même raison, « Déplacer » l'attend avant de commencer
 * (OptionsMenu.tsx). Passe par le pont même si la lecture du fichier a échoué à l'ouverture : c'est le main qui
 * décide, et il refuse d'écrire tant qu'il n'a pas pu lire le fichier existant.
 */
export function migrateLegacyCodeConversations(): Promise<boolean> {
  if (migration) return migration
  const found = readLegacy()
  if (!found) return Promise.resolve(true)
  const bridge = findBridge()
  if (!bridge) return Promise.resolve(false)
  const { storage, legacy } = found
  // Envoyé tout de suite (pas au tour suivant) : il part avant toute autre demande de cette fenêtre au main.
  let pending: Promise<void>
  try {
    pending = Promise.resolve(bridge.importCodeConversations(legacy.data))
  } catch (err) {
    pending = Promise.reject(err)
  }
  const running = pending.then(
    () => {
      for (const key of legacy.keys) {
        try {
          storage.removeItem(key)
        } catch {
          // Déjà dans le fichier : une entrée restée ici serait simplement reprise (sans rien écraser) plus tard.
        }
      }
      return true
    },
    (err: unknown) => {
      console.error('[code] Reprise des anciennes conversations du mode Code impossible :', err)
      return false
    }
  )
  migration = running
  void running.then(() => {
    if (migration === running) migration = null
  })
  return running
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
  // Ce qui reste dans l'ancien stockage est affiché tout de suite (sans écraser ce que le fichier contient déjà),
  // même si sa reprise dans le fichier est encore en cours ou a échoué.
  const found = readLegacy()
  if (found) {
    const merged = fromData(
      mergeCodeConversations({ repos: store.repos, conversations: Object.fromEntries(store.conversations) }, found.legacy.data)
    )
    store.repos = merged.repos
    store.conversations = merged.conversations
  }
  void migrateLegacyCodeConversations()
  return store
}

function send(write: (bridge: Bridge) => Promise<void>): void {
  const bridge = ensureStore().bridge
  if (!bridge) return
  write(bridge).catch((err: unknown) => console.error('[code] Conversation du mode Code non enregistrée :', err))
}

export function loadConversation(rawKey: string): ChatTurn[] {
  return ensureStore().conversations.get(normalizeCodeConversationKey(rawKey)) ?? []
}

export function saveConversation(rawKey: string, turns: ChatTurn[]): void {
  const key = normalizeCodeConversationKey(rawKey)
  const current = ensureStore()
  // Rouvrir une conversation la renvoie ici telle quelle (même liste) : rien de neuf, rien à réécrire sur le disque.
  if (current.conversations.get(key) === turns) return
  const kept = turns.length > MAX_CODE_TURNS ? turns.slice(-MAX_CODE_TURNS) : turns
  if (kept.length > 0) current.conversations.set(key, kept)
  else current.conversations.delete(key)
  send((bridge) => bridge.saveCodeConversation(key, kept.length > 0 ? kept : null))
}

export function forgetConversation(rawKey: string): void {
  const key = normalizeCodeConversationKey(rawKey)
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
