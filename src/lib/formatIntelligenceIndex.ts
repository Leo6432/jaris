/**
 * Intelligence Index d'Artificial Analysis, avec sa décimale et une virgule à la française (« 13,1 ») :
 * étape 220, les scores sont relevés à une décimale, comme dans les données du site.
 */
export function formatIntelligenceIndex(value: number): string {
  return value.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
