/**
 * Date d'une application déjà générée, telle qu'affichée dans "Tes applications" (mode Code).
 *
 * Avant l'étape 94, la liste affichait `toLocaleString('fr-FR')` brut, soit "14/09/2026 15:11:52" : la
 * seconde près pour un fichier qu'on relit des jours plus tard, et une ligne de chiffres plus longue que le
 * nom de l'application elle-même. Ici, une seule information utile — est-ce d'aujourd'hui, d'hier, ou d'un
 * autre jour.
 *
 * Fonction PURE (l'instant courant est un paramètre, jamais `new Date()` caché à l'intérieur) pour être
 * testable directement — scripts/test-format-recent-date.mjs, même principe que computeScaledSize.
 */
export function formatRecentDate(timestamp: number, now: Date = new Date()): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const days = calendarDaysBetween(date, now)

  if (days === 0) return `Aujourd'hui, ${time}`
  if (days === 1) return `Hier, ${time}`

  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/**
 * Nombre de jours de CALENDRIER qui séparent deux instants, pas un nombre d'heures divisé par 24 : hier
 * 23h50 et aujourd'hui 00h10 sont séparés de 20 minutes mais bien de un jour — les afficher tous les deux
 * comme "Aujourd'hui" (ce que ferait une soustraction de millisecondes) serait faux.
 */
function calendarDaysBetween(date: Date, now: Date): number {
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
}
