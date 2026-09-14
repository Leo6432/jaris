/**
 * Icônes partagées par plusieurs panneaux (étape 96). Des SVG inline qui héritent de `currentColor` : aucune
 * dépendance, aucun emoji — même parti pris que l'icône de pièce jointe du composeur.
 *
 * Extraites ici dès le DEUXIÈME usage plutôt que recopiées : la corbeille est la même dans le mode Code (une
 * application générée) et dans le Chat (une conversation). Deux copies auraient fini par diverger, comme le
 * composeur l'avait fait avant l'étape 92.
 */
export function DeleteIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13h10l1-13" />
    </svg>
  )
}
