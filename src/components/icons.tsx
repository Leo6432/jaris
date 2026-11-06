import type { ReactNode } from 'react'

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

/** Télécharger (étape 185) : une flèche vers un bac, même tracé arrondi que la corbeille. */
export function DownloadIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 17v1.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V17" />
    </svg>
  )
}

/** Étape 426 : « Copier » sous une réponse du Chat (deux feuilles, comme ChatGPT). */
export function CopyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" />
    </svg>
  )
}

/** Étape 426 : « Copié » — la coche qui remplace un instant l'icône de copie. */
export function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}

/** Étape 428 : entrées du menu « + » du Chat (même famille : SVG en traits, couleur héritée). */
function MenuIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** « Créer une image » : un pinceau et une étincelle. */
export function DrawIcon(): JSX.Element {
  return (
    <MenuIcon>
      <path d="M14.5 4.5 19.5 9.5 10 19H5v-5Z" />
      <path d="m12.5 6.5 5 5" />
      <path d="M5 3v4M3 5h4" />
    </MenuIcon>
  )
}

/** « Recherche sur le web » : un globe. */
export function GlobeIcon(): JSX.Element {
  return (
    <MenuIcon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z" />
    </MenuIcon>
  )
}

/** « Regarder mon écran » : un moniteur. */
export function ScreenIcon(): JSX.Element {
  return (
    <MenuIcon>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </MenuIcon>
  )
}

/** « Rappel » : une cloche. */
export function BellIcon(): JSX.Element {
  return (
    <MenuIcon>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </MenuIcon>
  )
}
