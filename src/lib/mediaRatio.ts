import type { CSSProperties } from 'react'

/**
 * Étape 271 (Léo : « c'est mal présenté les vidéos ») : une image ou une vidéo créée prend toute la place
 * disponible à ses propres proportions. `max-width`/`max-height` seuls ne font que RÉDUIRE : une vidéo de 832 px
 * restait à 832 px au milieu d'un grand cadre vide sur un écran large. Les proportions réelles, connues une fois
 * le fichier chargé, passent au CSS (`--media-ratio`, index.css), qui calcule la plus grande taille qui tient.
 */
export function mediaRatio(width: number, height: number): number | null {
  return width > 0 && height > 0 ? width / height : null
}

/** Style à poser sur l'image ou la vidéo ; rien tant que les proportions ne sont pas connues. */
export function mediaRatioStyle(ratio: number | null): CSSProperties | undefined {
  return ratio ? ({ '--media-ratio': ratio } as CSSProperties) : undefined
}
