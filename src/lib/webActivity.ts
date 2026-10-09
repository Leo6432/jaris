import type { WebActivity } from '../../shared/ipc'

/**
 * Étape 273 (Léo : « quand il recherche sur le web, tu peux pas faire comme Claude, une petite flèche pour voir ce
 * qu'il recherche ? ») : la ligne résumée du bloc dépliable, au-dessus de la réponse du Chat.
 * Pendant la réponse, elle dit la dernière recherche en cours de lecture ; après, ce qui a été fait.
 */
export function webActivityLabel(items: WebActivity[], running: boolean): string {
  const searches = items.filter((item) => item.kind === 'search')
  const reads = items.filter((item) => item.kind === 'read')
  if (running) {
    const last = items[items.length - 1]
    if (!last) return 'Recherche sur le web…'
    return last.kind === 'search' ? `Recherche : « ${last.query} »` : `Lecture de ${sourceDomain(last.url)}`
  }
  const parts: string[] = []
  if (searches.length === 1) parts.push('A cherché sur le web')
  else if (searches.length > 1) parts.push(`A fait ${searches.length} recherches sur le web`)
  if (reads.length) parts.push(`${parts.length ? 'lu' : 'A lu'} ${reads.length} page${reads.length > 1 ? 's' : ''}`)
  return parts.join(' et ')
}

/** « fr.wikipedia.org » pour une adresse complète ; l'adresse telle quelle si elle ne se lit pas. */
export function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Une page lue : son adresse sans « https:// » ni « www. » (le site seul se lit déjà à droite). */
export function pageAddress(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
}

/** Seules les adresses http(s) deviennent des liens (ouverts dans le navigateur de Windows). */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
