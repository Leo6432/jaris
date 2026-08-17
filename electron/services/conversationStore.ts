import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

export interface ConversationEntry {
  id: string
  timestamp: string
  transcript: string
  reply: string
}

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
