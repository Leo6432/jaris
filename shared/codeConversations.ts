/**
 * La liste et les conversations du mode Code (étape 288), rangées dans `code-conversations.json`, dans le dossier de
 * données de Jaris (getDataRoot()). Elles vivaient avant dans le stockage de la fenêtre (localStorage), qui appartient
 * au dossier interne de Chromium : un « Déplacer » change ce dossier et efface l'ancien, et toute la liste du mode
 * Code (applications et dépôts GitHub, avec leurs conversations) disparaissait. Le fichier, lui, suit les données.
 *
 * Partagé par le processus principal (qui lit et écrit le fichier) et l'écran (qui y reprend l'ancien localStorage).
 * Pur : aucun accès au disque ni à la fenêtre ici.
 */
export const CODE_CONVERSATIONS_FILE = 'code-conversations.json'
/**
 * Dossier (à côté du fichier) où un fichier abîmé est mis de côté au lieu d'être écrasé, sous un nom daté. Un nom
 * FIXE, pour pouvoir être emporté par « Déplacer » avec le reste des données (OWNED_ENTRIES, storageRoot.ts) : sans
 * ça, déplacer depuis un ancien dossier `jaris-data` effacerait cette dernière copie avec lui.
 */
export const CODE_CONVERSATIONS_ASIDE_DIR = 'code-conversations-illisibles'

/**
 * Nom d'une copie mise de côté dans CODE_CONVERSATIONS_ASIDE_DIR : `code-conversations-2026-10-17T09-30-00-000Z.json`.
 * Daté à la milliseconde, pour qu'un second incident n'écrase jamais le premier. Partagé par le store (fichier abîmé)
 * et par le démarrage (storageRoot.ts : fichier qui ne peut pas être réuni avec celui déjà à destination).
 */
export function codeConversationsAsideName(now: number): string {
  return `code-conversations-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`
}

/** Une conversation garde ses derniers messages : au-delà, les plus anciens partent. */
export const MAX_CODE_TURNS = 200
export const MAX_CODE_REPOS = 30

export interface CodeRepoEntry {
  fullName: string
  /** Dernière ouverture ou dernier travail de Jaris dessus (ms) : la liste est triée par là, comme le Chat. */
  at: number
}

export interface CodeConversationsData {
  repos: CodeRepoEntry[]
  /**
   * Clé « app:<nom du dossier de l'application> » (voir appConversationKey) ou « repo:<propriétaire/nom> » -> messages
   * de la conversation (validés par l'écran).
   */
  conversations: Record<string, unknown[]>
}

export const isCodeRepoEntry = (value: unknown): value is CodeRepoEntry =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as CodeRepoEntry).fullName === 'string' &&
  (value as CodeRepoEntry).fullName.length > 0 &&
  typeof (value as CodeRepoEntry).at === 'number' &&
  Number.isFinite((value as CodeRepoEntry).at)

/**
 * Le dernier élément d'un chemin, séparateurs Windows (« \ ») comme POSIX (« / ») acceptés : pour une application
 * générée, le nom de son dossier (`1760000000000-snake`, horodaté à la milliseconde par codeGenerator.ts : unique).
 * Sans le module `path` : l'écran s'en sert aussi, et une clé écrite sous Windows doit se relire pareil partout.
 */
export function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/**
 * Clé de la conversation d'une application générée : `app:<nom de son dossier>`, jamais son chemin complet. Le dossier
 * des données change à chaque « Déplacer » et au rapatriement du démarrage (storageRoot.ts) : une ancienne clé
 * « app:C:\…\generated-apps\1760000000000-snake » ne correspondait plus jamais ensuite, et la conversation de chaque
 * application disparaissait de l'écran, orpheline dans le fichier. Accepte le chemin, ou déjà le nom du dossier.
 */
export const appConversationKey = (pathOrFolder: string): string => `app:${lastPathSegment(pathOrFolder) || pathOrFolder}`

/**
 * Une ancienne clé « app:<chemin absolu> » devient « app:<nom du dossier> ». Les clés des dépôts (« repo:… ») et les
 * clés déjà au bon format ne changent pas.
 */
export function normalizeCodeConversationKey(key: string): string {
  if (!key.startsWith('app:')) return key
  const folder = lastPathSegment(key.slice('app:'.length))
  return folder ? `app:${folder}` : key
}

/** Seules ces deux familles de clés existent : rien d'autre n'entre dans le fichier (ni « __proto__ »). */
export const isCodeConversationKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 2000 && /^(app|repo):./.test(key)

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/** Un message comparé sans son numéro (`id`) : deux sessions numérotent chacune leurs messages à partir de 1. */
function turnSignature(turn: unknown): string {
  if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
    const rest: Record<string, unknown> = { ...(turn as Record<string, unknown>) }
    delete rest.id
    return JSON.stringify(rest)
  }
  return String(JSON.stringify(turn))
}

function turnId(turn: unknown): number | null {
  if (!turn || typeof turn !== 'object') return null
  const id = (turn as { id?: unknown }).id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/**
 * Deux versions d'une même conversation réunies sans rien perdre ni rien doubler : `older` d'abord, puis ce que
 * `newer` ajoute après leur début commun. L'une qui contient déjà l'autre (copie identique, ou suite de la même
 * conversation) l'emporte telle quelle. Les messages ajoutés sont renumérotés après ceux de `older` : l'écran repère
 * chaque message par son numéro, deux messages au même numéro se mélangeraient. Pure.
 *
 * Déjà réunies une fois, rien n'est recopié : la fin de `older` qui reprend le début de ce que `newer` ajoute (le plus
 * long recouvrement) n'est pas rajoutée, seule la suite l'est. Ça couvre le démarrage interrompu juste après la fusion
 * (`newer` entièrement déjà là), ET le cas où Jaris a ensuite tourné sur C (le démarrage abandonne la racine D sur
 * une erreur) et que la conversation y a continué : D = [d1, r1, c1, c-r1], C = [c1, c-r1, c2, c-r2] donne
 * [d1, r1, c1, c-r1, c2, c-r2], jamais c1 et c-r1 deux fois.
 */
export function combineCodeTurns(older: unknown[], newer: unknown[]): unknown[] {
  const a = older.map(turnSignature)
  const b = newer.map(turnSignature)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  if (common === b.length) return older
  if (common === a.length) return newer
  const rest = b.slice(common)
  // Le recouvrement ne remonte jamais dans le début commun : il est déjà compté.
  let overlap = Math.min(a.length - common, rest.length)
  while (overlap > 0 && !rest.slice(0, overlap).every((signature, index) => signature === a[a.length - overlap + index])) overlap--
  if (overlap === rest.length) return older
  const added = newer.slice(common + overlap)
  const olderIds = older.map(turnId).filter((id): id is number => id !== null)
  const addedIds = added.map(turnId).filter((id): id is number => id !== null)
  const shift = olderIds.length > 0 && addedIds.length > 0 ? Math.max(0, Math.max(...olderIds) - Math.min(...addedIds) + 1) : 0
  const renumbered = added.map((turn) => {
    const id = turnId(turn)
    return id === null || shift === 0 ? turn : { ...(turn as object), id: id + shift }
  })
  return [...older, ...renumbered].slice(-MAX_CODE_TURNS)
}

/**
 * Range une conversation sous sa clé au format actuel (normalizeCodeConversationKey). Deux anciennes clés devenues
 * identiques (le même dossier d'application, avant et après un « Déplacer ») sont réunies, celle déjà rangée d'abord.
 */
export function addCodeConversation(target: Record<string, unknown[]>, key: string, turns: unknown[]): void {
  const normalized = normalizeCodeConversationKey(key)
  target[normalized] = (hasOwn(target, normalized) ? combineCodeTurns(target[normalized], turns) : turns).slice(-MAX_CODE_TURNS)
}

/**
 * Garde ce qui a la bonne forme, sans jamais inventer : `null` si l'objet entier n'est pas une liste de conversations
 * (fichier abîmé). Une conversation vide n'est pas gardée — elle n'a rien à retrouver. Les anciennes clés
 * « app:<chemin absolu> » sont converties au passage (voir appConversationKey).
 */
export function sanitizeCodeConversations(value: unknown): CodeConversationsData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { repos, conversations } = value as Record<string, unknown>
  if (!Array.isArray(repos) || !conversations || typeof conversations !== 'object' || Array.isArray(conversations)) return null
  const kept: Record<string, unknown[]> = {}
  for (const [key, turns] of Object.entries(conversations)) {
    if (isCodeConversationKey(key) && Array.isArray(turns) && turns.length > 0) addCodeConversation(kept, key, turns)
  }
  return { repos: repos.filter(isCodeRepoEntry).slice(0, MAX_CODE_REPOS), conversations: kept }
}

/** Dépôts réunis : même nom (majuscules comprises) = un seul, le plus récent ; le plus récent en tête. */
function mergeRepos(first: CodeRepoEntry[], second: CodeRepoEntry[]): CodeRepoEntry[] {
  const byName = new Map<string, CodeRepoEntry>()
  for (const repo of [...first, ...second]) {
    const id = repo.fullName.toLowerCase()
    const known = byName.get(id)
    if (!known || repo.at > known.at) byName.set(id, repo)
  }
  return [...byName.values()].sort((a, b) => b.at - a.at).slice(0, MAX_CODE_REPOS)
}

/**
 * Reprend `extra` (l'ancien localStorage) dans `base` (le fichier) SANS jamais rien écraser : une conversation déjà
 * présente garde la version du fichier — celle-ci contient déjà ce que l'écran affichait de l'ancien stockage, la
 * réunir avec lui doublerait ses messages. Les dépôts sont réunis. Deux données déjà passées par
 * sanitizeCodeConversations (clés au format actuel). Pure : renvoie un nouvel objet.
 */
export function mergeCodeConversations(base: CodeConversationsData, extra: CodeConversationsData): CodeConversationsData {
  const conversations: Record<string, unknown[]> = { ...base.conversations }
  for (const [key, turns] of Object.entries(extra.conversations)) {
    if (!hasOwn(conversations, key)) conversations[key] = turns
  }
  return { repos: mergeRepos(base.repos, extra.repos), conversations }
}

/**
 * Deux fichiers écrits chacun de son côté (disque débranché : une session sur C pendant que D gardait l'historique)
 * réunis SANS rien perdre : chaque conversation des deux, et une conversation présente des deux côtés garde les
 * messages des deux (combineCodeTurns, `older` d'abord). Deux données déjà passées par sanitizeCodeConversations. Pure.
 */
export function combineCodeConversations(older: CodeConversationsData, newer: CodeConversationsData): CodeConversationsData {
  const conversations: Record<string, unknown[]> = { ...older.conversations }
  for (const [key, turns] of Object.entries(newer.conversations)) addCodeConversation(conversations, key, turns)
  return { repos: mergeRepos(older.repos, newer.repos), conversations }
}
