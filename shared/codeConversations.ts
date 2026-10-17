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
  /** Clé « app:<chemin> » ou « repo:<propriétaire/nom> » -> messages de la conversation (validés par l'écran). */
  conversations: Record<string, unknown[]>
}

export const isCodeRepoEntry = (value: unknown): value is CodeRepoEntry =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as CodeRepoEntry).fullName === 'string' &&
  (value as CodeRepoEntry).fullName.length > 0 &&
  typeof (value as CodeRepoEntry).at === 'number' &&
  Number.isFinite((value as CodeRepoEntry).at)

/** Seules ces deux familles de clés existent : rien d'autre n'entre dans le fichier (ni « __proto__ »). */
export const isCodeConversationKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 2000 && /^(app|repo):./.test(key)

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/**
 * Garde ce qui a la bonne forme, sans jamais inventer : `null` si l'objet entier n'est pas une liste de conversations
 * (fichier abîmé). Une conversation vide n'est pas gardée — elle n'a rien à retrouver.
 */
export function sanitizeCodeConversations(value: unknown): CodeConversationsData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { repos, conversations } = value as Record<string, unknown>
  if (!Array.isArray(repos) || !conversations || typeof conversations !== 'object' || Array.isArray(conversations)) return null
  const kept: Record<string, unknown[]> = {}
  for (const [key, turns] of Object.entries(conversations)) {
    if (isCodeConversationKey(key) && Array.isArray(turns) && turns.length > 0) kept[key] = turns.slice(-MAX_CODE_TURNS)
  }
  return { repos: repos.filter(isCodeRepoEntry).slice(0, MAX_CODE_REPOS), conversations: kept }
}

/**
 * Reprend `extra` (l'ancien localStorage) dans `base` (le fichier) SANS jamais rien écraser : une conversation déjà
 * présente garde sa version ; les dépôts sont réunis (même nom, majuscules comprises = un seul), le plus récent en tête.
 * Pure : renvoie un nouvel objet.
 */
export function mergeCodeConversations(base: CodeConversationsData, extra: CodeConversationsData): CodeConversationsData {
  const conversations: Record<string, unknown[]> = { ...base.conversations }
  for (const [key, turns] of Object.entries(extra.conversations)) {
    if (!hasOwn(conversations, key)) conversations[key] = turns
  }
  const byName = new Map<string, CodeRepoEntry>()
  for (const repo of [...base.repos, ...extra.repos]) {
    const id = repo.fullName.toLowerCase()
    const known = byName.get(id)
    if (!known || repo.at > known.at) byName.set(id, repo)
  }
  const repos = [...byName.values()].sort((a, b) => b.at - a.at).slice(0, MAX_CODE_REPOS)
  return { repos, conversations }
}
