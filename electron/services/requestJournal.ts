import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ChatMetrics } from './ollama'
import { getDataRoot } from './dataLocation'

/**
 * Étape 245 : journal des demandes, dans un fichier texte que Léo peut envoyer tel quel.
 *
 * Pourquoi (Léo : « ouvre Firefox et cherche une recette de tiramisu » → 2 minutes avant que Firefox s'ouvre,
 * puis plus rien de visible) : sans mesure sur SA machine, on ne sait pas où partent ces minutes — réflexion
 * du modèle, chargement en mémoire vidéo, ou pilotage de l'écran. Chaque demande (voix ou Chat) y laisse les
 * étapes déjà annoncées à l'écran (onLog), chacune avec le temps écoulé depuis le début de la demande, plus la
 * durée de chaque appel au modèle. Rien d'autre : ni l'historique, ni la mémoire, ni le contenu des pages.
 */
export const JOURNAL_FILE_NAME = 'journal-demandes.txt'

/** Au-delà, on ne garde que la fin : le journal sert à diagnostiquer les dernières demandes, pas à tout archiver. */
export const JOURNAL_MAX_BYTES = 512 * 1024

/** Un résultat d'outil peut être long (page web, liste d'éléments) : seul le début aide à comprendre ce qui s'est passé. */
const MAX_LINE_CHARS = 600

export function getJournalPath(root: string = getDataRoot()): string {
  return join(root, JOURNAL_FILE_NAME)
}

/** « 1,2 s », « 2 min 05 s » : lisible par Léo, sans calcul à faire. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(Math.floor(seconds % 60)).padStart(2, '0')} s`
}

function clip(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ')
  return oneLine.length > MAX_LINE_CHARS ? `${oneLine.slice(0, MAX_LINE_CHARS)}… (${oneLine.length} caractères)` : oneLine
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// Les écritures sont enchaînées : deux lignes arrivées presque en même temps restent dans l'ordre, et jamais
// deux écritures concurrentes sur le même fichier.
let queue: Promise<void> = Promise.resolve()

/** Écrit des lignes à la fin du journal. N'échoue jamais : un journal illisible ne doit jamais casser une demande. */
export function appendJournal(lines: string[], path: string = getJournalPath()): Promise<void> {
  const text = lines.map((line) => `${line}\n`).join('')
  queue = queue
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, text, 'utf8')
      const size = (await stat(path)).size
      if (size > JOURNAL_MAX_BYTES) {
        // On coupe à une demande entière (ligne « ===== ») pour ne jamais garder une demande à moitié.
        const content = await readFile(path, 'utf8')
        const tail = content.slice(content.length - Math.floor(JOURNAL_MAX_BYTES / 2))
        const start = tail.indexOf('\n=====')
        await writeFile(path, start >= 0 ? tail.slice(start + 1) : tail, 'utf8')
      }
    })
    .catch((err) => console.error('[journal] écriture impossible :', err))
  return queue
}

export interface JournalEntry {
  /** Une étape, précédée du temps écoulé depuis le début de la demande. */
  line(message: string): void
  /** Durée d'une opération qui vient de se terminer (appel au modèle…). */
  timed(label: string, startedAt: number): void
  /** Fin de la demande : réponse donnée ou erreur. */
  end(outcome: string): Promise<void>
}

export function startJournalEntry(
  channel: string,
  prompt: string,
  now: () => number = Date.now,
  path?: string
): JournalEntry {
  const startedAt = now()
  const write = (lines: string[]): void => void appendJournal(lines, path)
  write(['', `===== ${stamp(new Date(startedAt))} — ${channel === 'voice' ? 'voix' : channel} =====`, `Demande : ${clip(prompt)}`])
  return {
    line(message) {
      write([`[+${formatElapsed(now() - startedAt)}] ${clip(message)}`])
    },
    timed(label, operationStart) {
      const t = now()
      write([`[+${formatElapsed(t - startedAt)}] ${clip(label)} — a pris ${formatElapsed(t - operationStart)}`])
    },
    end(outcome) {
      return appendJournal([`[+${formatElapsed(now() - startedAt)}] Fin : ${clip(outcome)}`], path)
    }
  }
}

/** Ce que le journal retient d'un appel au modèle : sa décision, et où le temps est passé selon Ollama. */
export function describeModelCall(
  model: string,
  message: { content?: string; tool_calls?: Array<{ function: { name: string } }> },
  metrics?: ChatMetrics
): string {
  const decision = message.tool_calls?.length
    ? `demande ${message.tool_calls.map((call) => call.function.name).join(', ')}`
    : `répond (${(message.content ?? '').trim().length} caractères)`
  const parts: string[] = []
  if (metrics?.loadMs !== undefined && metrics.loadMs >= 100) parts.push(`chargement du modèle ${formatElapsed(metrics.loadMs)}`)
  if (metrics?.promptMs !== undefined) parts.push(`lecture ${formatElapsed(metrics.promptMs)}${metrics.promptTokens !== undefined ? ` (${metrics.promptTokens} tokens)` : ''}`)
  if (metrics?.outputMs !== undefined) parts.push(`écriture ${formatElapsed(metrics.outputMs)}${metrics.outputTokens !== undefined ? ` (${metrics.outputTokens} tokens)` : ''}`)
  if (metrics?.thinkingChars) parts.push(`dont réflexion ${metrics.thinkingChars} caractères`)
  return `Modèle ${model} : ${decision}${parts.length ? ` — ${parts.join(', ')}` : ''}`
}
