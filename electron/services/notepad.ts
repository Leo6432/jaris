import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { t } from '../../shared/i18n'

const run = promisify(execFile)

/**
 * Ce que demande « ouvre le Bloc-notes et écris … » : un texte à recopier tel quel, ou un texte à RÉDIGER
 * (« un poème sur la mer ») — étape 346 : avant, « un poème sur la mer » était recopié mot pour mot.
 */
export type NotepadRequest = { kind: 'literal'; text: string } | { kind: 'compose'; request: string }

const OPEN = String.raw`(?:ouvre|ouvrir|lance|lancer|démarre|demarre)(?:[-\s]moi)?`
const ARTICLE = String.raw`(?:(?:l[’']application|l[’']appli|le|un|une|mon|un\s+nouveau|une\s+nouvelle)\s+)?`
// Étape 346 : « bloc note », « blocknote », « bloque-note » (graphies réelles de la transcription), « notepad ».
const NAME = String.raw`(?:bloc?k?[\s‐‑–-]*notes?|bloque[\s‐‑–-]*notes?|notepad)`
// Ponctuation facultative : « ouvre le bloc-notes, écris bonjour », « ouvre le bloc-notes. Écris bonjour ».
const SEPARATOR = String.raw`\s*(?:[,.;!]\s*)?(?:(?:et|puis|ensuite)\s+)?`
const WRITE = String.raw`(?:écris|écrit|ecris|ecrit|écrire|ecrire|tape|taper|note|marque)(?:[-\s]moi)?(?:[-\s](?:y|dedans))?`
const OPEN_THEN_WRITE = new RegExp(String.raw`^${OPEN}\s+${ARTICLE}${NAME}${SEPARATOR}${WRITE}\s*(:\s*|\s+)([\s\S]+)$`, 'iu')
// « Écris bonjour dans le bloc-notes » : la même demande, dans l'autre ordre.
const WRITE_IN = new RegExp(String.raw`^${WRITE}\s*(:\s*|\s+)([\s\S]+?)\s+dans\s+${ARTICLE}${NAME}[.!]?$`, 'iu')
// Une autre action après le texte (« … puis enregistre ») : la demande entière reste au modèle.
const MORE_ACTIONS = /\s(?:puis|ensuite)\s+\S|\s+et\s+(?:enregistre|sauvegarde|ferme|imprime|envoie|copie|colle|ouvre|lance)\b/iu
// Un texte à rédiger : un article puis un genre de texte (« un poème », « une lettre à ma mère »).
const COMPOSE =
  /^(?:moi\s+)?(?:un|une|des|quelques|mon|ma|mes|le|la|les)\s+(?:(?:petite?s?|courte?s?|jolie?s?|belle?s?|longue?s?|nouvelle?s?|vraie?s?)\s+)?(?:po[èe]mes?|lettres?|recettes?|listes?|résumés?|resumes?|histoires?|textes?|mails?|e-?mails?|messages?|blagues?|chansons?|discours|paragraphes?|comptes?\s+rendus?|rédactions?|redactions?|haïkus?|haikus?|dissertations?|invitations?|contes?|courriers?|annonces?|articles?|plans?|menus?|citations?|slogans?|devinettes?)\b/iu

export function notepadRequest(prompt: string): NotepadRequest | undefined {
  const trimmed = prompt.trim()
  const match = trimmed.match(OPEN_THEN_WRITE) ?? trimmed.match(WRITE_IN)
  const afterColon = Boolean(match?.[1].includes(':'))
  const text = match?.[2].trim()
  if (!text) return undefined
  const quoted = text.match(/^[«“"]([\s\S]+)[»”"][.!]?$/u)
  if (quoted) return { kind: 'literal', text: quoted[1].trim() }
  // Après « : », c'est une dictée, recopiée telle quelle, même si elle commence par « une liste ».
  if (afterColon) return { kind: 'literal', text }
  if (MORE_ACTIONS.test(` ${text}`)) return undefined
  if (COMPOSE.test(text)) return { kind: 'compose', request: text.replace(/[.!]+$/u, '') }
  return { kind: 'literal', text }
}

/** Le texte à recopier tel quel, ou `undefined` (rien à écrire, ou un texte à rédiger d'abord). */
export function requestedNotepadText(prompt: string): string | undefined {
  const request = notepadRequest(prompt)
  return request?.kind === 'literal' ? request.text : undefined
}

/** Nouveau fichier indépendant : aucune frappe envoyée à une fenêtre au focus incertain. */
export async function openNotepadText(text: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const directory = join(tmpdir(), 'jaris-notes')
  await mkdir(directory, { recursive: true })
  const stem = `Note-Jaris-${randomUUID()}`
  const path = join(directory, `${stem}.txt`)
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
  signal?.throwIfAborted()
  // Les seules valeurs interpolées sont le nom UUID et le chemin encodé, jamais le texte dicté.
  const encodedPath = Buffer.from(path, 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); Start-Process -FilePath notepad.exe -ArgumentList ('"'+$file+'"') -WindowStyle Normal; for($i=0;$i -lt 40;$i++){ $w=Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${stem}*'}; if($w){ Write-Output 'JARIS_NOTE_VISIBLE'; exit 0 }; Start-Sleep -Milliseconds 250 }; throw 'Fenetre du nouveau document Bloc-notes non detectee.'`
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, signal })
  if (!stdout.includes('JARIS_NOTE_VISIBLE')) throw new Error(t('notepad.notConfirmed'))
  return t('notepad.opened')
}
