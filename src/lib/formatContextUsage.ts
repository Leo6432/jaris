import { currentLocale } from '../../shared/i18n'

/**
 * Étape 299 : un nombre de tokens affiché court, comme ChatGPT ou Claude (« 461k/1m ») — même convention que la
 * mémoire réglée (formatContextLength) : le « k » vaut 1024, sinon « 32k » réglé s'afficherait « 33k » utilisé une
 * fois plein. Une décimale tant que c'est petit (« 5,1k »), où un chiffre rond cacherait l'évolution d'une réponse à
 * l'autre ; séparateur décimal de la langue de Jaris. Pure, testée à part.
 */
export function formatTokenCount(tokens: number, locale: string = currentLocale()): string {
  const value = Math.max(0, Math.round(tokens))
  const number = (amount: number, digits: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(amount)
  if (value < 1024) return String(value)
  if (value >= 1024 * 1024) return `${number(value / (1024 * 1024), 1)}m`
  const k = value / 1024
  return `${number(k, k < 10 ? 1 : 0)}k`
}

/** Part occupée, de 0 à 1 (bornée : la réflexion peut faire dépasser légèrement la fenêtre demandée). */
export function contextUsageRatio(used: number, max: number): number {
  if (!(max > 0)) return 0
  return Math.min(1, Math.max(0, used / max))
}
