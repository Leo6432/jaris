import { formatModelName } from './formatModelName'

/** Minuscules, accents retirés, ponctuation en espaces : « Qwen3.5 » se trouve en tapant « qwen 3 5 ». */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Étape 226 (Léo : « ajoute une barre de recherche à côté des filtres dans tous les modèles ») : garde les
 * modèles dont le nom affiché OU le tag Ollama complet contient chaque mot tapé, dans n'importe quel ordre.
 * Les espaces et la ponctuation sont ignorés, pour que « qwen35 » trouve aussi « qwen3.5 ».
 */
export function filterModels<T extends { model: string }>(entries: T[], query: string): T[] {
  const words = normalize(query).split(' ').filter(Boolean)
  if (words.length === 0) return entries
  return entries.filter((entry) => {
    const haystack = `${normalize(formatModelName(entry.model))} ${normalize(entry.model)}`
    const compact = haystack.replace(/ /g, '')
    return words.every((word) => haystack.includes(word) || compact.includes(word))
  })
}
