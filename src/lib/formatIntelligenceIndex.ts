import { formatDecimal } from '../../shared/i18n'

/**
 * Intelligence Index d'Artificial Analysis, avec sa décimale (étape 220 : les scores sont relevés à une décimale,
 * comme dans les données du site), écrite à la façon de la langue de Jaris : « 13,1 » en français, « 13.1 » en
 * anglais. Jusqu'à la version 0.34.31, la locale était figée en 'fr-FR' : la virgule française dans toutes les
 * langues.
 */
export function formatIntelligenceIndex(value: number): string {
  return formatDecimal(value, 1)
}
