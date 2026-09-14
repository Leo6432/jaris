import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const run = promisify(execFile)

/** Une commande précise ; la suite est du texte littéral, jamais du code à exécuter. */
export function requestedNotepadText(prompt: string): string | undefined {
  const match = prompt.trim().match(/^ouvre\s+(?:(?:l[’']application|le)\s+)?(?:bloc[\s‐‑–-]*notes?|notepad)\s+(?:et|puis)\s+(?:écris|écrit|ecris|ecrit|tape)\s*(?::\s*|\s+)([\s\S]+)$/iu)
  const text = match?.[1].trim()
  if (!text) return undefined
  const quoted = text.match(/^[«“"]([\s\S]+)[»”"][.!]?$/u)
  return quoted ? quoted[1].trim() : text
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
  if (!stdout.includes('JARIS_NOTE_VISIBLE')) throw new Error('Windows n’a pas confirmé la fenêtre du document.')
  return 'Le Bloc-notes est ouvert avec le texte demandé dans un nouveau document.'
}
