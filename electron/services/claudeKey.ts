import { safeStorage } from 'electron'
import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'

/**
 * Étape 399 (Léo : « mettre ma clé API Claude » pour que Claude juge les duels Conversation) : la clé, chiffrée par
 * Windows (DPAPI via safeStorage) comme le jeton GitHub, dans le dossier de données (elle suit « Déplacer »). Elle ne
 * quitte jamais le processus principal : l'écran ne reçoit que « une clé est enregistrée » et ses 4 derniers caractères.
 */
export const CLAUDE_KEY_FILE = 'claude-key.bin'

function keyPath(): string {
  return join(getDataRoot(), CLAUDE_KEY_FILE)
}

/** Gardée seulement en mémoire quand Windows ne sait pas chiffrer (rien n'est alors écrit en clair). */
let memoryKey: string | null = null

/** Forme d'une clé d'API Anthropic : rien d'autre n'est accepté (et une clé collée avec des espaces est nettoyée). */
export function cleanClaudeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key) ? key : null
}

/**
 * Enregistre la clé. Renvoie `false` quand Windows n'a pas pu la chiffrer : elle n'est alors gardée qu'en mémoire.
 * D'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancienne clé intacte, jamais une clé tronquée.
 */
export async function saveClaudeKey(key: string): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) {
    memoryKey = key
    return false
  }
  memoryKey = null
  await writeFileAtomic(keyPath(), safeStorage.encryptString(key))
  return true
}

export async function loadClaudeKey(): Promise<string | null> {
  if (memoryKey) return memoryKey
  let encrypted: Buffer
  try {
    encrypted = await readFile(keyPath())
  } catch {
    return null
  }
  try {
    return cleanClaudeKey(safeStorage.decryptString(encrypted))
  } catch {
    return null
  }
}

export async function clearClaudeKey(): Promise<void> {
  memoryKey = null
  await rm(keyPath(), { force: true })
}

/** Ce que l'écran a le droit de savoir : une clé est là, et sa fin pour la reconnaître. */
export async function claudeKeyStatus(): Promise<{ saved: boolean; last4: string | null }> {
  const key = await loadClaudeKey()
  return { saved: key !== null, last4: key ? key.slice(-4) : null }
}
