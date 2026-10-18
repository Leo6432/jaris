/**
 * Étape 328 : ce qu'une fenêtre de Jaris a le droit d'ouvrir ou de charger (branché sur chaque fenêtre par main.ts,
 * `web-contents-created`).
 *
 * Deux défauts réels. Un fichier glissé par erreur sur la fenêtre (un PDF, une image) REMPLAÇAIT toute l'interface de
 * Jaris par ce fichier, sans bouton pour revenir. Et un lien ouvert depuis une page (réponse du Chat, page de GitHub)
 * était passé tel quel au système : un lien `file:` ou d'un autre protocole pouvait lancer un programme de la machine.
 * Désormais, une fenêtre ne quitte jamais sa propre page, et seules les adresses web s'ouvrent dans le navigateur.
 */

/** Adresses qu'un lien peut ouvrir dans le navigateur de Windows : http et https seulement. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Même page, seule l'ancre change (ou rechargement, en développement) : la navigation est laissée faire. */
export function isSameDocument(next: string, current: string): boolean {
  try {
    const a = new URL(next)
    const b = new URL(current)
    a.hash = ''
    b.hash = ''
    return a.href === b.href
  } catch {
    return false
  }
}
