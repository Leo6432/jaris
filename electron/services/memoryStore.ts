import { mkdir, readFile, readdir } from 'fs/promises'
import { join } from 'path'
import type { MemoryGraph, MemoryGraphLink } from '../../shared/ipc'
import { readFileWithRetries, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'

const memoryDir = join(getDataRoot(), 'memory')

/** Noms que Windows refuse pour un fichier, quelle que soit l'extension (« Con.md » ne peut pas être créé). */
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Le nom de fichier d'une note, toujours le même pour un même titre (relancer la fonction sur son résultat ne le
 * change plus). Étape 328 : avant, les blancs étaient retirés AVANT les caractères interdits et la coupe à 80 : un titre
 * comme « "  Vacances » ou un titre long coupé juste après une espace donnait un fichier dont le nom commence ou finit
 * par une espace. Relu depuis le dossier, ce nom ne retombait plus sur le même fichier, et l'écran du Cerveau
 * plantait sur une note introuvable.
 */
function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .trim()
    .slice(0, 80)
    .replace(/[\s.]+$/, '')
  if (!cleaned) return 'note'
  return RESERVED_WINDOWS_NAMES.test(cleaned) ? `${cleaned}_` : cleaned
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

  // Étape 325 : seule une note ABSENTE est une nouvelle note. Avant, une note verrouillée un instant (antivirus) était
  // prise pour une nouvelle, et réécrite avec ce seul ajout : tout son contenu était perdu. Elle fait maintenant échouer
  // l'ajout (DataFileUnreadableError) sans rien écrire.
  let existing = ''
  if (!replace) existing = (await readFileWithRetries(path)) ?? ''

  const entry = `\n\n_${timestamp}_\n${content}`
  // D'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancienne note intacte.
  await writeFileAtomic(path, existing ? existing + entry : `# ${sanitizeTitle(title)}${entry}`)
  return `Noté dans la mémoire ("${title}").`
}

/** Le fichier d'une note listée dans le dossier, sous son nom RÉEL (pas recalculé : une ancienne note garde le sien). */
function listedNotePath(listedTitle: string): string {
  return join(memoryDir, `${listedTitle}.md`)
}

/** Relit le contenu d'une note existante, par correspondance exacte ou approximative du titre. */
export async function recallNote(title: string): Promise<string> {
  const titles = await listMemoryTitles()
  const wanted = title.trim().toLowerCase()
  const match = titles.find((t) => t.toLowerCase() === wanted) ?? titles.find((t) => t.toLowerCase().includes(wanted))
  if (!match) return `Aucune note trouvée pour "${title}".`
  return readFile(listedNotePath(match), 'utf-8')
}

/**
 * Étape 328 : le contenu d'une note pour l'écran du Cerveau — le titre EXACT (à la casse près), null si elle n'existe
 * pas. recallNote sert le modèle : il accepte un titre approché et répond par une phrase française. Cliquer sur son
 * propre prénom au centre du Cerveau affichait donc « Aucune note trouvée pour "Léo". » (en français, quelle que soit
 * la langue choisie), ou pire la première note dont le titre CONTENAIT ce prénom.
 */
export async function readNoteForDisplay(title: string): Promise<string | null> {
  const wanted = title.trim().toLowerCase()
  const match = (await listMemoryTitles()).find((listed) => listed.toLowerCase() === wanted)
  return match === undefined ? null : readFile(listedNotePath(match), 'utf-8')
}

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g

/** Notes existantes et liens [[Titre]] entre elles, pour la vue graphe 3D du "cerveau" de Jaris. */
export async function getMemoryGraph(): Promise<MemoryGraph> {
  const titles = await listMemoryTitles()
  const titleSet = new Set(titles)
  const links: MemoryGraphLink[] = []

  for (const title of titles) {
    // Une note illisible (verrouillée un instant, effacée entre-temps) n'empêche jamais d'afficher les autres.
    let content: string
    try {
      content = await readFile(listedNotePath(title), 'utf-8')
    } catch {
      continue
    }
    for (const match of content.matchAll(LINK_PATTERN)) {
      const target = match[1].trim()
      if (target !== title && titleSet.has(target)) links.push({ source: title, target })
    }
  }

  return { nodes: titles.map((id) => ({ id })), links }
}
