import { randomUUID } from 'crypto'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import type { ConversationEntry, ConversationSummary } from '../../shared/ipc'
import {
  UNTITLED_CONVERSATION,
  conversationIdFromFileName,
  mergeConversationsIndex,
  parseConversationEntries,
  parseConversationsIndex,
  titleFromMessage,
  type ConversationsIndex
} from '../../shared/conversationsData'
import { UNREADABLE_DATA_DIR, isTemporaryDataName, readFileWithRetries, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { t } from '../../shared/i18n'

// Le format sur le disque est partagé avec la racine de stockage, qui réunit les conversations de deux disques au
// démarrage (shared/conversationsData.ts) : le titre et le marqueur « sans titre » viennent de là.
export { UNTITLED_CONVERSATION, titleFromMessage }

/**
 * Jaris n'avait qu'UNE seule conversation continue, à dessein depuis l'étape 47 (voix et chat unifiés).
 * Léo a demandé l'inverse à l'étape 96 ("avoir plusieurs conversation sur chat") : les échanges vivent
 * maintenant dans un dossier `conversations/`, un fichier par conversation, plus un index qui retient
 * laquelle est active.
 *
 * Le canal VOCAL écrit dans la conversation ACTIVE, jamais dans un fil à part : c'est ce qui préserve la
 * propriété acquise à l'étape 47 (demander quelque chose à l'oral puis enchaîner par écrit continue la même
 * discussion). Changer de conversation dans le Chat change donc aussi celle que la voix continue.
 */
const legacyHistoryPath = join(getDataRoot(), 'conversation-history.json')

function conversationsDir(): string {
  return join(getDataRoot(), 'conversations')
}

function indexPath(): string {
  return join(conversationsDir(), 'index.json')
}

function entriesPath(id: string): string {
  return join(conversationsDir(), `${id}.json`)
}

/**
 * Étape 325 : un fichier de conversation (ou l'index) abîmé n'est plus jamais remplacé en silence par un fichier neuf :
 * il est d'abord rangé ici sous un nom daté (atomicFile.ts), et suit « Déplacer » avec le reste.
 */
function unreadableDir(): string {
  return join(getDataRoot(), UNREADABLE_DATA_DIR)
}

/**
 * Chaque échange réécrit tout le fichier de SA conversation (pas un flux d'ajout) : sans plafond, un fichier
 * grossirait indéfiniment avec l'usage, rendant chaque échange de plus en plus lent à journaliser. Le
 * plafond est maintenant PAR conversation — avant, il était global, donc discuter dans un nouveau fil aurait
 * fini par ronger les messages d'un ancien fil auquel on n'a pas touché.
 */
const MAX_HISTORY_ENTRIES = 300

/**
 * Étape 328 : les écritures de l'index se font une par une. Chacune relit l'index, le change puis le réécrit : deux en
 * même temps (la voix et le Chat qui répondent ensemble, un changement de fil pendant qu'une réponse s'enregistre)
 * auraient chacune réécrit l'index lu AVANT l'autre, et la dernière effaçait le changement de la première.
 */
let writeChain: Promise<unknown> = Promise.resolve()
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

/** Un identifiant de conversation tel que Jaris les crée (randomUUID) : jamais un chemin, jamais « .. ». */
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * Échanges d'une conversation. Étape 325 : avant, toute erreur de lecture rendait une liste VIDE, et l'échange suivant
 * réécrivait le fichier avec ce seul échange — tout le fil était perdu sur un fichier tronqué ou momentanément verrouillé
 * (antivirus). Désormais : abîmé, il est rangé de côté puis la conversation repart vide ; illisible, l'action en cours
 * échoue (DataFileUnreadableError) sans rien écrire.
 */
async function readEntries(id: string): Promise<ConversationEntry[]> {
  const read = await readJsonDataFile(entriesPath(id), parseConversationEntries, unreadableDir(), `conversation-${id}`)
  return read.status === 'ok' ? read.value : []
}

/** Écriture d'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancienne version intacte. */
async function writeEntries(id: string, entries: ConversationEntry[]): Promise<void> {
  await writeFileAtomic(entriesPath(id), JSON.stringify(entries, null, 2))
}

function newConversation(title = UNTITLED_CONVERSATION): ConversationSummary {
  const now = new Date().toISOString()
  return { id: randomUUID(), title, createdAt: now, updatedAt: now, messageCount: 0 }
}

/**
 * Lit l'index, en le créant au besoin — et surtout : RÉCUPÈRE l'ancien `conversation-history.json` comme
 * première conversation au tout premier lancement après la mise à jour. Sans ça, Léo perdrait d'un coup
 * tout ce qui a été dit jusqu'ici (il s'en est inquiété explicitement : "j'ai peur que plus on avance plus
 * tu vas perdre des données"). L'ancien fichier n'est jamais supprimé : il reste sur le disque comme filet,
 * même si plus rien ne le lit.
 */
async function readIndex(): Promise<ConversationsIndex> {
  // Étape 325 : un index illisible était reconstruit avec UNE conversation neuve, qui cachait toutes les autres (leurs
  // fichiers restaient sur le disque, mais plus rien ne les listait). Abîmé, il est rangé de côté ; momentanément
  // verrouillé, la lecture échoue sans rien réécrire (DataFileUnreadableError).
  const read = await readJsonDataFile(indexPath(), parseConversationsIndex, unreadableDir(), 'conversations-index')
  if (read.status === 'ok' && read.value.conversations.length) return read.value

  // Index absent, vide ou abîmé : les conversations dont le fichier est encore là sont retrouvées, plutôt que cachées.
  const recovered = await recoverIndexFromFiles()
  if (recovered.conversations.length) {
    await writeIndex(recovered)
    return recovered
  }

  const legacy = await readLegacyHistory()
  const first = newConversation(legacy.length ? titleFromMessage(legacy[0].transcript) : UNTITLED_CONVERSATION)
  first.messageCount = legacy.length
  if (legacy.length) {
    first.createdAt = legacy[0].timestamp
    first.updatedAt = legacy[legacy.length - 1].timestamp
    await writeEntries(first.id, legacy)
  }

  const index: ConversationsIndex = { activeId: first.id, conversations: [first] }
  await writeIndex(index)
  return index
}

/** L'index recalculé depuis les fichiers des conversations encore présents (chacun relu, les abîmés rangés de côté). */
async function recoverIndexFromFiles(): Promise<ConversationsIndex> {
  let names: string[] = []
  try {
    names = await readdir(conversationsDir())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const entriesById = new Map<string, ConversationEntry[]>()
  for (const name of [...names].sort()) {
    const id = isTemporaryDataName(name) ? null : conversationIdFromFileName(name)
    if (!id) continue
    const entries = await readEntries(id)
    if (entries.length) entriesById.set(id, entries)
  }
  return mergeConversationsIndex(null, null, [...entriesById.keys()], (id) => entriesById.get(id) ?? null)
}

/**
 * L'ancien fichier d'avant l'étape 96, relu seulement pour la migration. Abîmé : ignoré (et jamais réécrit, il reste
 * comme filet). Momentanément verrouillé : la lecture échoue, plutôt que de migrer « rien » et de ne plus y revenir.
 */
async function readLegacyHistory(): Promise<ConversationEntry[]> {
  const raw = await readFileWithRetries(legacyHistoryPath)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as ConversationEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeIndex(index: ConversationsIndex): Promise<void> {
  await writeFileAtomic(indexPath(), JSON.stringify(index, null, 2))
}

/** Conversations existantes, la plus récemment utilisée en premier, et laquelle est active. */
export async function listConversations(): Promise<{ activeId: string; conversations: ConversationSummary[] }> {
  const index = await readIndex()
  return {
    activeId: index.activeId,
    conversations: [...index.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => (c.title === UNTITLED_CONVERSATION ? { ...c, title: t('conv.untitled') } : c))
  }
}

export async function getActiveConversationId(): Promise<string> {
  return (await readIndex()).activeId
}

/**
 * Crée une conversation vide et la rend active. Si la conversation active est DÉJÀ vide et sans titre, elle
 * est réutilisée telle quelle : sans ça, cliquer deux fois sur "Nouvelle conversation" laisserait une traînée
 * de fils vides identiques dans la liste.
 */
export function createConversation(): Promise<string> {
  return exclusive(async () => {
    const index = await readIndex()
    const active = index.conversations.find((conversation) => conversation.id === index.activeId)
    if (active && active.messageCount === 0) return active.id

    const created = newConversation()
    index.conversations.push(created)
    index.activeId = created.id
    await writeIndex(index)
    return created.id
  })
}

/** Change la conversation active (Chat ET voix, voir le commentaire en tête de fichier). */
export function setActiveConversation(id: string): Promise<void> {
  return exclusive(async () => {
    const index = await readIndex()
    if (!index.conversations.some((conversation) => conversation.id === id)) return
    index.activeId = id
    await writeIndex(index)
  })
}

/**
 * Supprime une conversation et ses messages. Supprimer la dernière (ou l'active) laisse toujours une
 * conversation utilisable derrière : le Chat ne doit jamais se retrouver sans fil courant.
 */
export function deleteConversation(id: string): Promise<void> {
  return exclusive(async () => {
    // Étape 328 : l'identifiant vient de l'écran. Sans ce contrôle, « ../profile » effaçait le profil (rm de
    // `<dossier>/../profile.json`) ; seule une conversation réellement listée peut être supprimée.
    if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) return
    const index = await readIndex()
    if (!index.conversations.some((conversation) => conversation.id === id)) return
    index.conversations = index.conversations.filter((conversation) => conversation.id !== id)
    await rm(entriesPath(id), { force: true })

    if (!index.conversations.length) index.conversations.push(newConversation())
    if (index.activeId === id) {
      const mostRecent = [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      index.activeId = mostRecent.id
    }
    await writeIndex(index)
  })
}

/**
 * Ajoute un échange à une conversation et met à jour son titre/sa date dans l'index. Étape 328 : `conversationId` est
 * la conversation où la question a été POSÉE — sans lui, une réponse arrivée après un changement de fil s'écrivait dans
 * le nouveau fil. Sans identifiant (la voix), la conversation active. Supprimée entre-temps : rien n'est écrit.
 */
export function appendConversationEntry(entry: ConversationEntry, conversationId?: string): Promise<void> {
  return exclusive(async () => {
    const index = await readIndex()
    const targetId = conversationId ?? index.activeId
    const active = index.conversations.find((conversation) => conversation.id === targetId)
    if (!active) return

    const entries = await readEntries(active.id)
    entries.push(entry)
    const trimmed = entries.length > MAX_HISTORY_ENTRIES ? entries.slice(-MAX_HISTORY_ENTRIES) : entries
    await writeEntries(active.id, trimmed)

    // Le titre se fige sur le premier message : le renommer à chaque échange ferait danser la liste sous les
    // yeux de Léo, et le premier message est déjà le meilleur résumé de ce qu'on cherchait dans ce fil.
    if (active.title === UNTITLED_CONVERSATION) active.title = titleFromMessage(entry.transcript)
    active.messageCount = trimmed.length
    active.updatedAt = entry.timestamp
    await writeIndex(index)
  })
}

/** Échanges de la conversation ACTIVE (contexte du modèle et fil affiché dans le Chat). */
export async function getConversationHistory(limit = 50): Promise<ConversationEntry[]> {
  const index = await readIndex()
  return (await readEntries(index.activeId)).slice(-limit)
}

/** Échanges d'une conversation précise, pour l'afficher après un changement de fil. */
export async function getConversationEntries(id: string, limit = 50): Promise<ConversationEntry[]> {
  return (await readEntries(id)).slice(-limit)
}

/**
 * TOUTES les conversations mélangées, du plus ancien au plus récent — l'onglet "Historique" des Options est
 * le journal de tout ce qui a été dit (voix comprise), pas la vue d'un fil en particulier.
 */
export async function getAllConversationEntries(limit = 300): Promise<ConversationEntry[]> {
  const index = await readIndex()
  const all: ConversationEntry[] = []
  for (const conversation of index.conversations) all.push(...(await readEntries(conversation.id)))
  return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit)
}

/** Efface définitivement TOUTES les conversations (onglet "Historique" du menu Options). */
export function clearConversationHistory(): Promise<void> {
  return exclusive(async () => {
    const dir = conversationsDir()
    try {
      for (const name of await readdir(dir)) await rm(join(dir, name), { force: true })
    } catch {
      // Dossier pas encore créé : rien à effacer.
    }
    // Les copies de secours de conversations abîmées (étape 325) aussi : « tout supprimer » ne laisse aucun message.
    try {
      for (const name of await readdir(unreadableDir())) {
        if (name.startsWith('conversation-') || name.startsWith('conversations-index-')) await rm(join(unreadableDir(), name), { force: true })
      }
    } catch {
      // Aucune copie de secours : rien à effacer.
    }
    // L'ancien fichier d'avant l'étape 96 est effacé lui aussi : le garder ferait "revenir" tout l'historique
    // à la prochaine migration, juste après que Léo a demandé de tout supprimer.
    await writeFileAtomic(legacyHistoryPath, '[]')

    const fresh = newConversation()
    await writeIndex({ activeId: fresh.id, conversations: [fresh] })
  })
}

/** Dossier des conversations, révélé par le bouton "Ouvrir le dossier" (Options → Historique). */
export function getConversationHistoryPath(): string {
  return conversationsDir()
}

/** Crée le dossier s'il n'existe pas encore, pour pouvoir le révéler même avant le premier échange. */
export async function ensureConversationHistoryFile(): Promise<void> {
  await readIndex()
}
