import type { WebActivity } from '../../shared/ipc'

/**
 * Étape 273 (Léo : « quand il recherche sur le web, tu peux pas faire comme Claude, une petite flèche pour voir ce
 * qu'il recherche ? ») : la ligne résumée du bloc dépliable, au-dessus de la réponse du Chat.
 * Une recherche en cours (la dernière, `pending`) : ce qui est cherché ; sinon, ce qui a été fait.
 */
export function webActivityLabel(items: WebActivity[]): string {
  const last = items[items.length - 1]
  if (last?.pending) return last.kind === 'search' ? `Recherche : « ${last.query} »` : `Lecture de ${sourceDomain(last.url)}`
  const done = items.filter((item) => !item.pending)
  const searches = done.filter((item) => item.kind === 'search')
  const reads = done.filter((item) => item.kind === 'read')
  const parts: string[] = []
  if (searches.length === 1) parts.push('A cherché sur le web')
  else if (searches.length > 1) parts.push(`A fait ${searches.length} recherches sur le web`)
  if (reads.length) parts.push(`${parts.length ? 'lu' : 'A lu'} ${reads.length} page${reads.length > 1 ? 's' : ''}`)
  return parts.join(' et ')
}

/**
 * Étape 274 : une recherche est signalée deux fois — au début (`pending`, la question seule), puis terminée avec
 * ses résultats. La version terminée REMPLACE celle en cours, au lieu de s'ajouter à côté.
 */
export function mergeWebActivity(items: WebActivity[], incoming: WebActivity): WebActivity[] {
  if (!incoming.pending) {
    const key = (item: WebActivity): string => (item.kind === 'search' ? `s:${item.query}` : `r:${item.url}`)
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].pending && key(items[i]) === key(incoming)) return [...items.slice(0, i), incoming, ...items.slice(i + 1)]
    }
  }
  return [...items, incoming]
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
