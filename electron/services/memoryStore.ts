import { app } from 'electron'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { MemoryGraph, MemoryGraphLink } from '../../shared/ipc'

const memoryDir = join(app.getPath('userData'), 'memory')

function sanitizeTitle(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'note'
}

function notePath(title: string): string {
  return join(memoryDir, `${sanitizeTitle(title)}.md`)
}

export async function ensureMemoryDir(): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
}

export function getMemoryDir(): string {
  return memoryDir
}

/** Titres des notes existantes, pour donner à Jaris un aperçu de sa mémoire sans en charger tout le contenu. */
export async function listMemoryTitles(): Promise<string[]> {
  await ensureMemoryDir()
  const files = await readdir(memoryDir)
  return files.filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''))
}

/**
 * Crée ou complète une note markdown. Les liens vers d'autres notes s'écrivent en [[Titre]].
 *
 * Étape 47 (partie 2) : `replace` sert une CORRECTION explicite ("mon adresse a changé", "en fait c'est...")
 * — sans ça, rememberNote ajoutait TOUJOURS un nouvel horodatage à la suite de l'existant, donc une note
 * "corrigée" contenait quand même encore l'ancienne valeur juste au-dessus de la nouvelle : recallNote (et
 * donc le modèle, qui relit la note entière) ne pouvait jamais savoir laquelle des deux était encore valable.
 * `replace: true` réécrit le fichier avec UNIQUEMENT le fait actuel, sans trace de l'ancien. Par défaut
 * (`replace` absent/false), le comportement d'origine est inchangé : une info vraiment nouvelle s'ajoute à la
 * suite de la précédente, jamais à sa place.
 */
export async function rememberNote(title: string, content: string, replace = false): Promise<string> {
  await ensureMemoryDir()
  const path = notePath(title)
  const timestamp = new Date().toLocaleString('fr-FR')

  let existing = ''
  if (!replace) {
    try {
      existing = await readFile(path, 'utf-8')
    } catch {
      // Nouvelle note.
    }
  }

  const entry = `\n\n_${timestamp}_\n${content}`
  await writeFile(path, existing ? existing + entry : `# ${sanitizeTitle(title)}${entry}`, 'utf-8')
  return `Noté dans la mémoire ("${title}").`
}

/** Relit le contenu d'une note existante, par correspondance exacte ou approximative du titre. */
export async function recallNote(title: string): Promise<string> {
  const titles = await listMemoryTitles()
  const wanted = title.trim().toLowerCase()
  const match = titles.find((t) => t.toLowerCase() === wanted) ?? titles.find((t) => t.toLowerCase().includes(wanted))
  if (!match) return `Aucune note trouvée pour "${title}".`
  return readFile(notePath(match), 'utf-8')
}

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g

/** Notes existantes et liens [[Titre]] entre elles, pour la vue graphe 3D du "cerveau" de Jaris. */
export async function getMemoryGraph(): Promise<MemoryGraph> {
  const titles = await listMemoryTitles()
  const titleSet = new Set(titles)
  const links: MemoryGraphLink[] = []

  for (const title of titles) {
    const content = await readFile(notePath(title), 'utf-8')
    for (const match of content.matchAll(LINK_PATTERN)) {
      const target = match[1].trim()
      if (target !== title && titleSet.has(target)) links.push({ source: title, target })
    }
  }

  return { nodes: titles.map((id) => ({ id })), links }
}
