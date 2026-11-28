import { readFileSync } from 'node:fs'

/**
 * Étape 531 : le vrai fichier de scores liste les 54 modèles « à remesurer » (test refait exactement comme Jaris). Les
 * tests qui portent sur autre chose (choix des modèles, rejeu, durées…) partent du fichier tel qu'il était avant :
 * section « À remesurer » vide. scripts/test-verified-scores.mjs vérifie, lui, la vraie liste.
 */
export function withoutRemeasure(text) {
  return text.replace(/(## À remesurer[^\n]*\n[\s\S]*?\|---\|---\|\r?\n)(?:\|[^\n]*\r?\n)*/, '$1')
}

export const REAL_SCORES_FILE = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')
export const SCORES_WITHOUT_REMEASURE = withoutRemeasure(REAL_SCORES_FILE)
