import type { WebActivity } from '../../shared/ipc'
import { t, tn } from '../../shared/i18n'

/**
 * Étape 273 (Léo : « quand il recherche sur le web, tu peux pas faire comme Claude, une petite flèche pour voir ce
 * qu'il recherche ? ») : la ligne résumée du bloc dépliable, au-dessus de la réponse du Chat.
 * Une recherche en cours (la dernière, `pending`) : ce qui est cherché ; sinon, ce qui a été fait.
 */
export function webActivityLabel(items: WebActivity[]): string {
  const last = items[items.length - 1]
  if (last?.pending) return last.kind === 'search' ? t('web.searching', { query: last.query }) : t('web.reading', { site: sourceDomain(last.url) })
  const done = items.filter((item) => !item.pending)
  const searches = done.filter((item) => item.kind === 'search')
  const reads = done.filter((item) => item.kind === 'read')
  const parts: string[] = []
  if (searches.length === 1) parts.push(t('web.searchedOnce'))
  else if (searches.length > 1) parts.push(tn('web.searchedMany', searches.length))
  if (reads.length) parts.push(tn(parts.length ? 'web.andRead' : 'web.read', reads.length))
  return parts.join(t('web.and'))
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
