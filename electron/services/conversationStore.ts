import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ConversationEntry } from '../../shared/ipc'

const historyPath = join(app.getPath('userData'), 'conversation-history.json')

/**
 * Chaque échange rouvre, réécrit et sauvegarde tout le fichier (pas un flux d'ajout) : sans plafond, ce
 * fichier grossirait indéfiniment avec l'usage (des mois, des années de conversations), rendant chaque
 * échange de plus en plus lent à journaliser au fil du temps. Largement plus que les ~6 échanges relus
 * au démarrage (voir voicePipeline.ts), mais borné une fois pour toutes.
 */
const MAX_HISTORY_ENTRIES = 300

async function readHistory(): Promise<ConversationEntry[]> {
  try {
    const raw = await readFile(historyPath, 'utf-8')
    return JSON.parse(raw) as ConversationEntry[]
  } catch {
    return []
  }
}

export async function appendConversationEntry(entry: ConversationEntry): Promise<void> {
  const history = await readHistory()
  history.push(entry)
  const trimmed = history.length > MAX_HISTORY_ENTRIES ? history.slice(-MAX_HISTORY_ENTRIES) : history
  await mkdir(dirname(historyPath), { recursive: true })
  await writeFile(historyPath, JSON.stringify(trimmed, null, 2), 'utf-8')
}

export async function getConversationHistory(limit = 50): Promise<ConversationEntry[]> {
  const history = await readHistory()
  return history.slice(-limit)
}

/** Efface définitivement l'historique des échanges (onglet "Historique" du menu Options). */
export async function clearConversationHistory(): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true })
  await writeFile(historyPath, '[]', 'utf-8')
}

export function getConversationHistoryPath(): string {
  return historyPath
}

/** Crée le fichier (vide) s'il n'existe pas encore, pour pouvoir le révéler dans l'explorateur de fichiers
 * même avant le tout premier échange enregistré. */
export async function ensureConversationHistoryFile(): Promise<void> {
  try {
    await readFile(historyPath, 'utf-8')
  } catch {
    await mkdir(dirname(historyPath), { recursive: true })
    await writeFile(historyPath, '[]', 'utf-8')
  }
}
