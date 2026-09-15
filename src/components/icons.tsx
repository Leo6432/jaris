/**
 * Icônes partagées par plusieurs panneaux (étape 96). Des SVG inline qui héritent de `currentColor` : aucune
 * dépendance, aucun emoji — même parti pris que l'icône de pièce jointe du composeur.
 *
 * Extraites ici dès le DEUXIÈME usage plutôt que recopiées : la corbeille est la même dans le mode Code (une
 * application générée) et dans le Chat (une conversation). Deux copies auraient fini par diverger, comme le
 * composeur l'avait fait avant l'étape 92.
 */
/**
 * Corbeille. Redessinée à l'étape 100 ("les icones poubelle sont un peu mal faite", Léo) : le premier tracé
 * avait trois vrais défauts, invisibles à 15px mais bien réels une fois agrandi —
 *  - la poignée (`M10 4h4`) était un simple trait flottant AU-DESSUS du couvercle, sans montants pour l'y
 *    rattacher : elle se lisait comme une barre détachée, pas comme une anse ;
 *  - les deux stries intérieures partaient exactement SUR la ligne du couvercle et descendaient jusqu'au
 *    fond, donc elles traversaient l'un et l'autre au lieu de tenir à l'intérieur du bac ;
 *  - aucun `strokeLinecap`/`strokeLinejoin`, donc des angles coupés net et des pointes sèches à chaque
 *    jonction, ce qui se voit d'autant plus à petite taille.
 * Le tracé ci-dessous rattache la poignée au couvercle, rentre les stries dans le bac (haut ET bas) et
 * arrondit les extrémités. Même famille que les autres icônes du projet : SVG inline, aucune dépendance,
 * `currentColor` hérité (donc rouge au survol via `.workspace__delete:hover`).
 */
export function DeleteIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
      <path d="M6.6 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7" />
      <path d="M10.2 11v5.4M13.8 11v5.4" />
    </svg>
  )
}
