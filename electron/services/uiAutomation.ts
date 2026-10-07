/**
 * Étape 32 — clics fiables via l'API d'accessibilité Windows (UI Automation).
 *
 * Le pilotage d'écran (computerUse.ts, étape 34) demandait jusqu'ici au modèle de vision de DEVINER des
 * coordonnées en pixels sur une capture : la moindre erreur de quelques pixels, un défilement, une fenêtre
 * déplacée entre la capture et le clic, et le clic atterrit à côté. UI Automation expose au contraire les
 * VRAIS éléments cliquables d'une fenêtre (nom, type, position exacte) — cliquer devient une certitude au lieu
 * d'une estimation.
 *
 * Étape 256 : la LECTURE de ces éléments a déménagé dans screenMarks.ts/markedCapture.ts. L'ancienne lecture
 * prenait la fenêtre ACTIVE (GetForegroundWindow) — les boutons de Jaris lui-même quand Léo lui parlait depuis sa
 * fenêtre — et dans un processus de DPI différent de la capture. Restent ici les fonctions pures, testables sans
 * Windows : retrouver l'élément nommé par le modèle, et mettre la liste en forme pour lui.
 */

/** Un élément cliquable tel que Windows le décrit ; `id` = son numéro sur la capture (étape 256). */
export interface ClickableElement {
  name: string
  /** Type de contrôle sans son préfixe (`Button`, `Hyperlink`, `MenuItem`...). */
  type: string
  id?: number
}

/**
 * Normalise pour comparer : le modèle reprend rarement le nom au caractère près (casse, accents, espaces en
 * trop). Comparer sur une forme normalisée évite de rater "Rechercher" parce qu'il a écrit "rechercher".
 */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Retrouve l'élément visé par le modèle dans la liste renvoyée par Windows. Volontairement du TypeScript pur
 * (aucun PowerShell) : c'est la seule partie où une donnée venant du modèle est manipulée, donc la seule
 * qu'il fallait pouvoir tester sans Windows — voir scripts/test-ui-automation.mjs.
 *
 * Trois tours de plus en plus permissifs, dans cet ordre, pour préférer toujours la correspondance la plus
 * précise : égalité, puis début du nom, puis nom contenu. Sans cet ordre, un "Fermer" exact pourrait perdre
 * face à un "Fermer l'onglet" simplement placé plus haut dans la liste.
 */
export function findElementByName<T extends ClickableElement>(elements: T[], target: string): T | null {
  const wanted = normalize(target)
  if (!wanted) return null
  const named = elements.map((element) => ({ element, name: normalize(element.name) }))
  return (
    named.find((candidate) => candidate.name === wanted)?.element ??
    named.find((candidate) => candidate.name.startsWith(wanted))?.element ??
    named.find((candidate) => candidate.name.includes(wanted))?.element ??
    null
  )
}

/**
 * Rend la liste lisible pour le modèle, en gardant les lignes courtes (budget de contexte). Un élément numéroté sur
 * la capture (étape 256) porte son numéro en tête : « 12. [Button] Rechercher ».
 */
export function describeElements(elements: ClickableElement[]): string {
  if (!elements.length) return ''
  return elements
    .map((element) => `${element.id === undefined ? '-' : `${element.id}.`} [${element.type}] ${element.name.slice(0, 80)}`)
    .join('\n')
}
