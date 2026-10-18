import type { ConversationEntry, ConversationSummary } from './ipc'

/**
 * Le format des conversations du Chat sur le disque (dossier `conversations/` : un fichier par conversation, plus
 * `index.json`), en fonctions PURES : relu par le magasin des conversations (conversationStore.ts) et par la racine de
 * stockage, qui réunit les conversations de deux disques au démarrage (storageRoot.ts, disque rebranché). Aucune
 * dépendance à Electron ni au disque : testable directement, et utilisable avant que l'application soit prête.
 */

export const CONVERSATIONS_INDEX_FILE = 'index.json'

/**
 * Nom par défaut d'une conversation tant qu'aucun message n'a été envoyé dedans. C'est un MARQUEUR enregistré tel
 * quel sur le disque (toujours ce texte français) : l'étape 293 le traduit à la lecture (listConversations), pour que
 * changer de langue renomme aussi les conversations vides déjà créées.
 */
export const UNTITLED_CONVERSATION = 'Nouvelle conversation'

export interface ConversationsIndex {
  activeId: string
  conversations: ConversationSummary[]
}

/**
 * Titre dérivé du PREMIER message de la conversation (comme ChatGPT/Claude) plutôt qu'un nom à saisir à la
 * main : Léo n'a rien à remplir, et une conversation sans titre n'existe pas — le seul cas restant est celle
 * qu'on vient de créer et où rien n'a encore été dit.
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Les échanges d'une conversation, ou `null` si le fichier n'a pas la forme attendue (abîmé). */
export function parseConversationEntries(value: unknown): ConversationEntry[] | null {
  if (!Array.isArray(value) || !value.every(isRecord)) return null
  return value as unknown as ConversationEntry[]
}

const isSummary = (value: unknown): value is ConversationSummary =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id !== '' &&
  typeof value.title === 'string' &&
  typeof value.createdAt === 'string' &&
  typeof value.updatedAt === 'string' &&
  typeof value.messageCount === 'number'

/** L'index des conversations, ou `null` s'il n'a pas la forme attendue (abîmé). */
export function parseConversationsIndex(value: unknown): ConversationsIndex | null {
  if (!isRecord(value) || !Array.isArray(value.conversations) || !value.conversations.every(isSummary)) return null
  return { activeId: typeof value.activeId === 'string' ? value.activeId : '', conversations: value.conversations }
}

/** Le nom de fichier d'une conversation (`<id>.json`) → son identifiant ; `null` pour tout autre fichier du dossier. */
export function conversationIdFromFileName(name: string): string | null {
  if (!name.endsWith('.json') || name === CONVERSATIONS_INDEX_FILE) return null
  const id = name.slice(0, -'.json'.length)
  return id ? id : null
}

/** Ce que l'index retient d'une conversation, recalculé depuis ses échanges (index perdu ou abîmé). */
export function summaryFromEntries(id: string, entries: ConversationEntry[]): ConversationSummary {
  const first = entries[0]
  const last = entries[entries.length - 1]
  return {
    id,
    title: titleFromMessage(String(first?.transcript ?? '')),
    createdAt: String(first?.timestamp ?? ''),
    updatedAt: String(last?.timestamp ?? ''),
    messageCount: entries.length
  }
}

/** Ce qui identifie un échange : son identifiant (randomUUID), sinon son contenu et son heure. */
function entryKey(entry: ConversationEntry): string {
  return typeof entry.id === 'string' && entry.id ? `id:${entry.id}` : `at:${entry.timestamp}\u0000${entry.transcript}\u0000${entry.reply}`
}

/**
 * Les échanges d'une même conversation présente des deux côtés, réunis sans doublon : ceux de `older` d'abord, puis
 * ceux de `newer` qui n'y sont pas encore, dans leur ordre. Réunir deux fois de suite ne change plus rien.
 */
export function mergeConversationEntries(older: ConversationEntry[], newer: ConversationEntry[]): ConversationEntry[] {
  const seen = new Set(older.map(entryKey))
  const merged = [...older]
  for (const entry of newer) {
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged
}

const later = (a: string, b: string): string => (b.localeCompare(a) > 0 ? b : a)
const earlier = (a: string, b: string): string => (b && b.localeCompare(a) < 0 ? b : a)

/**
 * L'index réuni de deux disques (disque rebranché) : celui de destination d'abord — sa conversation active reste
 * active —, puis les conversations de l'autre côté qu'il n'a pas encore, puis toute conversation dont le fichier est là
 * sans figurer dans aucun index (index perdu ou abîmé : retrouvée plutôt que cachée).
 *
 * `threadIds` : les conversations qui ont un fichier à destination, déjà réuni ; `entriesFor` lit ce fichier (`null`
 * s'il est abîmé). Une conversation vide de l'autre côté (aucun fichier) n'est pas ajoutée : rien n'y a été dit.
 */
export function mergeConversationsIndex(
  destination: ConversationsIndex | null,
  source: ConversationsIndex | null,
  threadIds: string[],
  entriesFor: (id: string) => ConversationEntry[] | null
): ConversationsIndex {
  const conversations: ConversationSummary[] = []
  const seen = new Set<string>()
  const fromSource = new Map((source?.conversations ?? []).map((summary) => [summary.id, summary]))
  const files = new Set(threadIds)

  for (const summary of destination?.conversations ?? []) {
    if (seen.has(summary.id)) continue
    seen.add(summary.id)
    const other = fromSource.get(summary.id)
    if (!other) {
      conversations.push(summary)
      continue
    }
    const entries = files.has(summary.id) ? entriesFor(summary.id) : null
    conversations.push({
      ...summary,
      title: summary.title === UNTITLED_CONVERSATION && other.title !== UNTITLED_CONVERSATION ? other.title : summary.title,
      createdAt: earlier(summary.createdAt, other.createdAt),
      updatedAt: later(summary.updatedAt, other.updatedAt),
      messageCount: entries ? entries.length : Math.max(summary.messageCount, other.messageCount)
    })
  }
  for (const summary of source?.conversations ?? []) {
    if (seen.has(summary.id) || !files.has(summary.id)) continue
    const entries = entriesFor(summary.id)
    if (!entries?.length) continue
    seen.add(summary.id)
    conversations.push({ ...summary, messageCount: entries.length })
  }
  for (const id of threadIds) {
    if (seen.has(id)) continue
    const entries = entriesFor(id)
    if (!entries?.length) continue
    seen.add(id)
    conversations.push(summaryFromEntries(id, entries))
  }

  const known = (id: string | undefined): boolean => !!id && conversations.some((summary) => summary.id === id)
  const mostRecent = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const activeId = known(destination?.activeId) ? destination!.activeId : known(source?.activeId) ? source!.activeId : mostRecent?.id ?? ''
  return { activeId, conversations }
}
