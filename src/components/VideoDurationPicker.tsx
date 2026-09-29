import { useState } from 'react'
import { VIDEO_DURATIONS, type VideoSeconds } from '../../shared/videoModel'
import { usePickerPanel } from '@/lib/usePickerPanel'

/**
 * Durée d'une vidéo (étape 204, Léo : « on peut pas ajouter la possibilité de choisir la durée ? comme l'effort »).
 * Même bouton et même panneau que le sélecteur de réflexion (mêmes classes `effort-picker__*`, même placement via
 * usePickerPanel) : une barre de 1 à 5 secondes qui se remplit jusqu'au cran choisi.
 */
interface Props {
  value: VideoSeconds
  onChange: (seconds: VideoSeconds) => void
  disabled?: boolean
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

const label = (seconds: number): string => `${seconds} seconde${seconds > 1 ? 's' : ''}`

export default function VideoDurationPicker({ value, onChange, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const { rootRef, panelRef, panelStyle } = usePickerPanel(open, setOpen)
  const index = VIDEO_DURATIONS.indexOf(value)

  const onSliderKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = Math.max(0, Math.min(VIDEO_DURATIONS.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
    onChange(VIDEO_DURATIONS[next])
  }

  return (
    <div className="effort-picker duration-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title="Durée de la vidéo"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <ClockIcon />
        <span className="effort-picker__model">{value} s</span>
        <ChevronIcon />
      </button>

      {open && (
        <div ref={panelRef} className="effort-picker__panel" role="dialog" aria-label="Durée de la vidéo" style={panelStyle}>
          <div className="effort-picker__head">
            <span className="effort-picker__head-icon" aria-hidden="true">
              <ClockIcon />
            </span>
            <div className="effort-picker__head-text">
              <span className="effort-picker__current">{label(value)}</span>
            </div>
            <span />
          </div>
          <div
            className="effort-picker__slider effort-picker__slider--filled"
            style={{ '--fill': index / (VIDEO_DURATIONS.length - 1) } as React.CSSProperties}
            role="slider"
            tabIndex={0}
            aria-label="Durée de la vidéo"
            aria-valuemin={VIDEO_DURATIONS[0]}
            aria-valuemax={VIDEO_DURATIONS[VIDEO_DURATIONS.length - 1]}
            aria-valuenow={value}
            aria-valuetext={label(value)}
            onKeyDown={onSliderKey}
          >
            {VIDEO_DURATIONS.map((seconds, i) => (
              <button
                key={seconds}
                type="button"
                tabIndex={-1}
                className={`effort-picker__step${i === index ? ' effort-picker__step--active' : i < index ? ' effort-picker__step--filled' : ''}`}
                onClick={() => onChange(seconds)}
                title={label(seconds)}
                aria-label={label(seconds)}
              />
            ))}
          </div>
          <div className="effort-picker__scale" aria-hidden="true">
            <span>{VIDEO_DURATIONS[0]} s</span>
            <span>{VIDEO_DURATIONS[VIDEO_DURATIONS.length - 1]} s</span>
          </div>
        </div>
      )}
    </div>
  )
}
