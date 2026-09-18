import { randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ConversationEntry, ConversationSummary } from '../../shared/ipc'
import { getDataRoot } from './dataLocation'

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
 * Chaque échange réécrit tout le fichier de SA conversation (pas un flux d'ajout) : sans plafond, un fichier
 * grossirait indéfiniment avec l'usage, rendant chaque échange de plus en plus lent à journaliser. Le
 * plafond est maintenant PAR conversation — avant, il était global, donc discuter dans un nouveau fil aurait
 * fini par ronger les messages d'un ancien fil auquel on n'a pas touché.
 */
const MAX_HISTORY_ENTRIES = 300

/** Nom par défaut d'une conversation tant qu'aucun message n'a été envoyé dedans. */
export const UNTITLED_CONVERSATION = 'Nouvelle conversation'

interface ConversationsIndex {
  activeId: string
  conversations: ConversationSummary[]
}

/**
 * Titre dérivé du PREMIER message de la conversation (comme ChatGPT/Claude) plutôt qu'un nom à saisir à la
 * main : Léo n'a rien à remplir, et une conversation sans titre n'existe pas — le seul cas restant est celle
 * qu'on vient de créer et où rien n'a encore été dit.
 *
 * Fonction pure, exportée pour être testable directement (scripts/test-conversations.mjs).
 */
export function titleFromMessage(message: string, maxLength = 48): string {
  const cleaned = message.replace(/\s+/g, ' ').trim()
  if (!cleaned) return UNTITLED_CONVERSATION
  if (cleaned.length <= maxLength) return cleaned
  // Coupe sur le dernier espace avant la limite plutôt qu'en plein milieu d'un mot.
  const cut = cleaned.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

async function readEntries(id: string): Promise<ConversationEntry[]> {
  try {
    return JSON.parse(await readFile(entriesPath(id), 'utf-8')) as ConversationEntry[]
  } catch {
    return []
  }
}

async function writeEntries(id: string, entries: ConversationEntry[]): Promise<void> {
  await mkdir(conversationsDir(), { recursive: true })
  await writeFile(entriesPath(id), JSON.stringify(entries, null, 2), 'utf-8')
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
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8')) as ConversationsIndex
    if (parsed.conversations?.length) return parsed
  } catch {
    // Index absent ou illisible : reconstruit juste en dessous.
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

async function readLegacyHistory(): Promise<ConversationEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(legacyHistoryPath, 'utf-8')) as ConversationEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeIndex(index: ConversationsIndex): Promise<void> {
  await mkdir(conversationsDir(), { recursive: true })
  await writeFile(indexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

/** Conversations existantes, la plus récemment utilisée en premier, et laquelle est active. */
export async function listConversations(): Promise<{ activeId: string; conversations: ConversationSummary[] }> {
  const index = await readIndex()
  return {
    activeId: index.activeId,
    conversations: [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
export async function createConversation(): Promise<string> {
  const index = await readIndex()
  const active = index.conversations.find((conversation) => conversation.id === index.activeId)
  if (active && active.messageCount === 0) return active.id

  const created = newConversation()
  index.conversations.push(created)
  index.activeId = created.id
  await writeIndex(index)
  return created.id
}

/** Change la conversation active (Chat ET voix, voir le commentaire en tête de fichier). */
export async function setActiveConversation(id: string): Promise<void> {
  const index = await readIndex()
  if (!index.conversations.some((conversation) => conversation.id === id)) return
  index.activeId = id
  await writeIndex(index)
}

/**
 * Supprime une conversation et ses messages. Supprimer la dernière (ou l'active) laisse toujours une
 * conversation utilisable derrière : le Chat ne doit jamais se retrouver sans fil courant.
 */
export async function deleteConversation(id: string): Promise<void> {
  const index = await readIndex()
  index.conversations = index.conversations.filter((conversation) => conversation.id !== id)
  await rm(entriesPath(id), { force: true })

  if (!index.conversations.length) index.conversations.push(newConversation())
  if (index.activeId === id) {
    const mostRecent = [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    index.activeId = mostRecent.id
  }
  await writeIndex(index)
}

/** Ajoute un échange à la conversation ACTIVE et met à jour son titre/sa date dans l'index. */
export async function appendConversationEntry(entry: ConversationEntry): Promise<void> {
  const index = await readIndex()
  const active = index.conversations.find((conversation) => conversation.id === index.activeId)
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
export async function clearConversationHistory(): Promise<void> {
  const dir = conversationsDir()
  try {
    for (const name of await readdir(dir)) await rm(join(dir, name), { force: true })
  } catch {
    // Dossier pas encore créé : rien à effacer.
  }
  // L'ancien fichier d'avant l'étape 96 est effacé lui aussi : le garder ferait "revenir" tout l'historique
  // à la prochaine migration, juste après que Léo a demandé de tout supprimer.
  await mkdir(dirname(legacyHistoryPath), { recursive: true })
  await writeFile(legacyHistoryPath, '[]', 'utf-8')

  const fresh = newConversation()
  await writeIndex({ activeId: fresh.id, conversations: [fresh] })
}

