/**
 * Permissions que les fenêtres de Jaris accordent sans demander (session.setPermissionRequestHandler, main.ts) ;
 * tout le reste est refusé.
 *
 * - `media` : enumerateDevices() ne révèle les vrais noms des micros et haut-parleurs qu'une fois cette
 *   permission accordée (Options → Voix). Sans réponse ici, Chromium afficherait sa propre fenêtre de
 *   permission, déroutante dans une appli de bureau.
 * - `fullscreen` (étape 271, Léo : « on peut pas cliquer sur agrandir ») : le bouton plein écran du lecteur
 *   vidéo passe par cette permission dans Electron. Refusée — seul `media` était listé —, le clic ne faisait
 *   rien, sans la moindre erreur. Vérifié avec le vrai Electron : refus avec l'ancienne règle, plein écran
 *   avec celle-ci. Il faut toujours un clic de l'utilisateur, et Échap le quitte.
 */
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen'])

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}
