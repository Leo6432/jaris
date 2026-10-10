/**
 * Petits réglages d'affichage retenus d'une ouverture à l'autre (durée d'une vidéo, taille de l'aperçu du mode
 * Code…). Extrait de VideoPanel au deuxième usage (étape 283). Le stockage peut être indisponible : on retombe
 * alors sur la valeur par défaut, sans jamais faire planter l'écran.
 */
export function readSaved(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSaved(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Pas de stockage : le choix reste valable jusqu'à la fermeture de Jaris.
  }
}
