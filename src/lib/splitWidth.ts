/**
 * Largeur de la conversation du mode Code quand on fait glisser la séparation avec l'aperçu (étape 283, Léo :
 * « pouvoir régler la taille de l'aperçu »). Fonction pure, testée à part : aucune des deux colonnes ne doit
 * pouvoir disparaître sous la poignée.
 */
export const CHAT_MIN_WIDTH = 300
export const PREVIEW_MIN_WIDTH = 360

export function clampChatWidth(width: number, containerWidth: number): number {
  const max = Math.max(CHAT_MIN_WIDTH, containerWidth - PREVIEW_MIN_WIDTH)
  return Math.round(Math.max(CHAT_MIN_WIDTH, Math.min(width, max)))
}
