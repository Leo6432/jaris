import { Children, cloneElement, isValidElement, useId } from 'react'

/**
 * Briques communes des pages de réglages (Options), sorties d'OptionsMenu.tsx à l'étape 214 pour que
 * l'onglet Téléphone (PhoneAccessSettings.tsx) se présente exactement comme les autres, sans les recopier.
 */
/**
 * Une ligne de réglage uniforme (étape 116, Léo : "tu voit sur claude chatgpt tout se ressemble mais dans
 * les option rien ne se ressemble micro comment se déclencher") : intitulé + description à gauche, le
 * contrôle (case à cocher, menu déroulant, bouton, valeur en lecture seule...) aligné à droite. Avant cette
 * refonte, chaque type de réglage avait sa propre mise en forme ad hoc (`.options-menu__field` pour un menu
 * déroulant, `.options-menu__checkbox` en ligne isolée pour une case à cocher, un bouton nu pour une action)
 * — Léo comparait "Micro utilisé" (un menu) et "Comment se déclencher" (des cases) et n'y voyait aucun point
 * commun. `stacked` réserve le cas où le contrôle a besoin de toute la largeur (le curseur de longueur de
 * contexte, un visualiseur de micro) plutôt que de rester coincé à droite d'une ligne étroite.
 *
 * L'intitulé NOMME le contrôle (aria-labelledby) et la description le décrit (aria-describedby) : sans ce lien, un
 * menu déroulant (micro, haut-parleur) n'avait aucun nom pour un lecteur d'écran. Seuls les champs natifs sans nom
 * à eux le reçoivent : un bouton garde son propre texte, un interrupteur (`Toggle`) son `label`.
 */
const NAMED_BY_ROW = new Set(['select', 'input', 'textarea'])

export function SettingRow({
  label,
  description,
  stacked = false,
  className,
  children
}: {
  label: string
  description?: React.ReactNode
  stacked?: boolean
  className?: string
  children: React.ReactNode
}): JSX.Element {
  const labelId = useId()
  const descriptionId = useId()
  const control = Children.map(children, (child) => {
    if (!isValidElement<Record<string, unknown>>(child) || typeof child.type !== 'string' || !NAMED_BY_ROW.has(child.type)) return child
    if (child.props['aria-label'] || child.props['aria-labelledby']) return child
    return cloneElement(child, {
      'aria-labelledby': labelId,
      'aria-describedby': description ? descriptionId : undefined
    })
  })
  return (
    <div className={`options-menu__row${stacked ? ' options-menu__row--stacked' : ''}${className ? ` ${className}` : ''}`}>
      <div className="options-menu__row-text">
        <span className="options-menu__row-label" id={labelId}>
          {label}
        </span>
        {description && (
          <p className="options-menu__row-description" id={descriptionId}>
            {description}
          </p>
        )}
      </div>
      <div className="options-menu__row-control">{control}</div>
    </div>
  )
}

/**
 * Interrupteur à coins coupés (refonte visuelle Options, étape 119 — maquette `Options Jaris.dc.html`),
 * remplace la case à cocher native utilisée jusqu'ici dans `SettingRow` : une case de formulaire par défaut
 * est la seule commande de tout l'écran qui ne suivait pas la famille de boutons HUD (coins coupés en
 * `clip-path`, pas de coins arrondis). Un `<button role="switch">` plutôt qu'un vrai `<input type="checkbox">`
 * stylé : impossible d'obtenir un rail + curseur en `clip-path` sur une case native (son apparence est
 * remplacée en bloc par `accent-color`/`appearance`, pas composée de deux calques indépendants) — `aria-checked`
 * garde la même sémantique d'accessibilité qu'une case à cocher pour qui utilise un lecteur d'écran.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`options-menu__switch${checked ? ' options-menu__switch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="options-menu__switch-knob" />
    </button>
  )
}

/** Regroupe plusieurs `SettingRow` dans une même carte (fond + bordure), avec un titre au-dessus — le
 *  "groupe de réglages" façon Claude/ChatGPT, plutôt que des lignes qui flottent seules dans la page. */
export function SettingGroup({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="options-menu__group">
      <div className="options-menu__section-title">{title}</div>
      {description && <p className="options-menu__group-description">{description}</p>}
      <div className="options-menu__group-rows">{children}</div>
    </div>
  )
}
