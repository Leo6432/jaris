import { app, shell } from 'electron'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { t } from '../../shared/i18n'
import { getDataRoot } from './dataLocation'

/**
 * Étape 508 (Léo : « oui tout », pour les outils qui manquaient à Jaris) : trouver, ouvrir et lire des fichiers de
 * Léo. Trois verrous, parce que le chemin vient du modèle (donc, en amont, de n'importe quel texte qu'il a lu) :
 * 1. seulement dans les dossiers personnels de Léo (Documents, Bureau, Téléchargements, Images, Musique, Vidéos), revérifié
 *    sur le VRAI chemin (realpath) : un raccourci ou une jonction ne fait jamais sortir de ces dossiers ;
 * 2. ouvrir : seulement des documents, images, sons, vidéos et dossiers — jamais un programme, un script ni un raccourci ;
 * 3. lire : seulement du texte, et pas un fichier énorme.
 */

export type FileRootsSource = () => string[]

/** Les dossiers personnels de Léo, tels que Windows les donne (déplacés dans OneDrive compris). */
export const defaultRoots: FileRootsSource = () => {
  const names = ['documents', 'desktop', 'downloads', 'pictures', 'music', 'videos'] as const
  const roots: string[] = []
  for (const name of names) {
    try {
      roots.push(app.getPath(name))
    } catch {
      // Dossier inconnu de ce Windows : simplement absent de la liste.
    }
  }
  return [...new Set(roots)]
}

/** Ce qui s'ouvre avec son application habituelle : documents, images, sons, vidéos, archives. */
export const OPEN_EXTENSIONS = new Set([
  '.pdf', '.txt', '.md', '.rtf', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.csv', '.ppt', '.pptx', '.odp', '.epub',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.zip', '.7z', '.rar'
])

/**
 * Ce qui se lit comme du texte. Relecture adverse (étape 508) : jamais .json, .ini, .log, .yaml… — ces fichiers gardent
 * souvent des mots de passe et des jetons (réglages d'applications), et un texte lu peut ensuite être renvoyé ailleurs.
 */
export const READ_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.srt'])

const READ_MAX_BYTES = 2_000_000
const READ_MAX_CHARS = 8000
const FIND_MAX_RESULTS = 15
const FIND_MAX_ENTRIES = 20_000
const FIND_MAX_DEPTH = 5
const SKIPPED_DIRS = new Set(['node_modules', 'appdata', '$recycle.bin', 'system volume information'])

function plain(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Le vrai chemin de `path` s'il est DANS un des dossiers de Léo, sinon `null`. Comparé après realpath des deux côtés :
 * « Documents\lien » qui pointe vers C:\Windows est refusé.
 */
export async function insideRoots(path: string, roots: readonly string[], excluded: readonly string[] = excludedDirs()): Promise<string | null> {
  if (!path || !isAbsolute(path)) return null
  // Relecture adverse (étape 508) : jamais un chemin réseau ou de périphérique (\\serveur\…, \\?\…, \\.\…). Le simple fait de
  // le résoudre (realpath) ouvre une connexion — Windows y enverrait l'identifiant de Léo — avant même le refus.
  if (/^[\\/]{2}/.test(path)) return null
  // D'abord un contrôle sur le texte du chemin, AVANT tout accès au disque : déjà dans un des dossiers de Léo.
  const lexical = resolve(path)
  if (!roots.some((root) => within(resolve(root), lexical))) return null
  let real: string
  try {
    real = await realpath(resolve(path))
  } catch {
    return null
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      continue
    }
    if (!within(realRoot, real)) continue
    // Relecture adverse (étape 508) : jamais les données de Jaris (réglages, clés des outils MCP, conversations) — même
    // si Léo les a « Déplacées » dans ses Documents — ni un dossier AppData (jetons d'autres applications).
    if (real.split(/[\\/]/).some((part) => part.toLowerCase() === 'appdata')) return null
    if (excluded.some((dir) => within(dir, real))) return null
    return real
  }
  return null
}

/** Vrai si `path` est `dir` ou dedans (comparaison de Windows : sans tenir compte des majuscules). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep))
}

/** Les dossiers jamais lus ni ouverts, même s'ils sont dans ceux de Léo : les données de Jaris. */
function excludedDirs(): string[] {
  try {
    return [getDataRoot()]
  } catch {
    return []
  }
}

/** Cherche par nom (tous les mots demandés dans le nom), dossiers compris ; les plus récents d'abord. */
export async function findFiles(query: string, roots: readonly string[]): Promise<string> {
  const words = plain(query).split(' ').filter((w) => w.length >= 2)
  if (!words.length) return 'Dis le nom (ou une partie du nom) du fichier à chercher.'
  const found: { path: string; dir: boolean; mtime: number }[] = []
  let visited = 0
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length && visited < FIND_MAX_ENTRIES) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > FIND_MAX_ENTRIES) break
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      // Relecture adverse (étape 508) : sous Windows, les fichiers OneDrive « à la demande » se présentent comme des liens ;
      // les ignorer cachait les Documents et le Bureau de beaucoup de PC. Un lien n'est suivi que s'il reste chez Léo.
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        if (!(await insideRoots(full, roots))) continue
        isDir = (await stat(full).catch(() => null))?.isDirectory() ?? false
      }
      if (isDir && SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
      const name = plain(entry.name)
      if (words.every((w) => name.includes(w))) {
        const info = await stat(full).catch(() => null)
        found.push({ path: full, dir: isDir, mtime: info?.mtimeMs ?? 0 })
      }
      if (isDir && depth + 1 < FIND_MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
    }
  }
  if (!found.length) return `Aucun fichier ni dossier dont le nom contient « ${query} » dans les dossiers de l'utilisateur.`
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, FIND_MAX_RESULTS)
    .map((f) => `${f.dir ? '[dossier]' : '[fichier]'} ${f.path} (modifié le ${new Date(f.mtime).toLocaleDateString('fr-FR')})`)
    .join('\n')
}

/** Ouvre un document (avec son application habituelle) ou un dossier (dans l'Explorateur). */
export async function openFile(path: string, roots: readonly string[], open: (p: string) => Promise<string> = shell.openPath): Promise<string> {
  const real = await insideRoots(path, roots)
  if (!real) return t('files.outside')
  const info = await stat(real).catch(() => null)
  if (!info) return t('files.notFound', { path })
  if (!info.isDirectory() && !OPEN_EXTENSIONS.has(extname(real).toLowerCase())) return t('files.notOpenable', { ext: extname(real) || '?' })
  const error = await open(real)
  return error ? t('files.openFailed', { error }) : `Ouvert : ${real}`
}

/** Lit un fichier texte (les premiers caractères s'il est long). */
export async function readTextFile(path: string, roots: readonly string[]): Promise<string> {
  const real = await insideRoots(path, roots)
  if (!real) return t('files.outside')
  const info = await stat(real).catch(() => null)
  if (!info || !info.isFile()) return t('files.notFound', { path })
  if (!READ_EXTENSIONS.has(extname(real).toLowerCase())) return t('files.notReadable', { ext: extname(real) || '?' })
  if (info.size > READ_MAX_BYTES) return t('files.tooBig')
  const text = (await readFile(real, 'utf8')).replace(/^\uFEFF/, '')
  return text.length > READ_MAX_CHARS ? `${text.slice(0, READ_MAX_CHARS)}\n[… fichier coupé : ${text.length} caractères en tout]` : text
}

/** L'outil `files` : trouver, ouvrir ou lire. */
export async function filesTool(action: string, args: { name?: unknown; path?: unknown }, roots: FileRootsSource = defaultRoots): Promise<string> {
  const list = roots()
  switch (action) {
    case 'find':
      return findFiles(String(args.name ?? ''), list)
    case 'open':
      return openFile(String(args.path ?? ''), list)
    case 'read':
      return readTextFile(String(args.path ?? ''), list)
    default:
      return `Action "${action}" inconnue : find, open ou read.`
  }
}
