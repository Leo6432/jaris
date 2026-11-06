/**
 * Étape 426 : copier un texte dans le presse-papiers (bouton « Copier » sous une réponse du Chat). L'API moderne
 * d'abord ; si la fenêtre la refuse (contexte non sûr, permission), l'ancienne méthode par une zone de texte cachée.
 * Renvoie vrai si le texte a été copié.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // On tente l'ancienne méthode ci-dessous.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
