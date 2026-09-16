/**
 * Affichage court d'un nombre de tokens de contexte, exactement comme le curseur "Context length" d'Ollama
 * (capture envoyée par Léo) : "4k", "128k"... Le "k" désigne ici 1024 (convention universelle pour une
 * longueur de contexte : "128k" veut toujours dire 131072, jamais 128000) — diviser par 1000 aurait donné
 * "33k" pour 32768 au lieu du "32k" attendu. CONTEXT_LENGTH_STEPS (hardwareScan.ts) est toujours un multiple
 * exact de 1024, donc jamais de décimale en pratique ; l'arrondi protège seulement une valeur qui n'en
 * serait pas un multiple exact.
 */
export function formatContextLength(tokens: number): string {
  if (tokens < 1024) return String(tokens)
  const k = Math.round(tokens / 1024)
  return `${k}k`
}
