const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * Étapes 425-426 : une recherche tapée par Léo (services MCP de « Découvrir », conversations de la barre latérale)
 * correspond-elle à ces textes affichés ? Chaque mot tapé doit se trouver dans l'un d'eux, sans tenir compte des
 * accents ni des majuscules. Rien de tapé : tout correspond.
 */
export function matchesSearch(query: string, texts: readonly string[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = fold(texts.join(' \n '))
  return words.every((word) => haystack.includes(word))
}
