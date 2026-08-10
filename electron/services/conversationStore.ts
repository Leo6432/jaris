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
  await mkdir(dirname(historyPath), { recursive: true })
  await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8')
}

export async function getConversationHistory(limit = 50): Promise<ConversationEntry[]> {
  const history = await readHistory()
  return history.slice(-limit)
}
