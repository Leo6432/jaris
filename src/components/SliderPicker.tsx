import { useState, type ReactNode } from 'react'
import { usePickerPanel } from '@/lib/usePickerPanel'

/**
 * Un bouton du champ de saisie qui ouvre une barre à crans, présentée comme le sélecteur de réflexion (mêmes
 * classes `effort-picker__*`, même placement via usePickerPanel). Étape 205 : partagé par la durée et la qualité
 * du mode Vidéo — deux copies de ce panneau auraient fini par ne plus se ressembler.
 */
export interface SliderStep<T> {
  value: T
  label: string
}

interface Props<T> {
  /** Classe propre à ce sélecteur (ex. `duration-picker`), pour le distinguer de ses voisins. */
  className: string
  icon: ReactNode
  triggerLabel: string
  /** Infobulle du bouton, et nom du panneau pour les lecteurs d'écran. */
  name: string
  title: string
  steps: SliderStep<T>[]
  value: T
  onChange: (value: T) => void
  scale: [string, string]
  /** Sous la barre : une action liée au cran choisi (ex. télécharger une qualité). */
  footer?: ReactNode
  disabled?: boolean
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export default function SliderPicker<T extends string | number>({
  className,
  icon,
  triggerLabel,
  name,
  title,
  steps,
  value,
  onChange,
  scale,
  footer,
  disabled = false
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const { rootRef, panelRef, panelStyle } = usePickerPanel(open, setOpen, [steps.length, footer])
  const index = steps.findIndex((step) => step.value === value)

  const onSliderKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = Math.max(0, Math.min(steps.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
    onChange(steps[next].value)
  }

  return (
    <div className={`effort-picker ${className}`} ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {icon}
        <span className="effort-picker__model">{triggerLabel}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div ref={panelRef} className="effort-picker__panel" role="dialog" aria-label={name} style={panelStyle}>
          <div className="effort-picker__head">
            <span className="effort-picker__head-icon" aria-hidden="true">
              {icon}
            </span>
            <div className="effort-picker__head-text">
              <span className="effort-picker__current">{title}</span>
            </div>
            <span />
          </div>
          <div
            className="effort-picker__slider effort-picker__slider--filled"
            // Un seul cran possible (machine modeste) : la barre est pleine, il n'y a rien d'autre à choisir.
            style={{ '--fill': steps.length > 1 ? Math.max(index, 0) / (steps.length - 1) : 0 } as React.CSSProperties}
            role="slider"
            tabIndex={0}
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={steps.length - 1}
            aria-valuenow={index}
            aria-valuetext={title}
            onKeyDown={onSliderKey}
          >
            {steps.map((step, i) => (
              <button
                key={String(step.value)}
                type="button"
                tabIndex={-1}
                className={`effort-picker__step${i === index ? ' effort-picker__step--active' : i < index ? ' effort-picker__step--filled' : ''}`}
                onClick={() => onChange(step.value)}
                title={step.label}
                aria-label={step.label}
              />
            ))}
          </div>
          <div className="effort-picker__scale" aria-hidden="true">
            <span>{scale[0]}</span>
            <span>{scale[1]}</span>
          </div>
          {footer}
        </div>
      )}
    </div>
  )
}
