import { useCallback, useEffect, useRef, useState } from 'react'
import { EFFORT_STEPS, effortLabel, type EffortChoice } from '../../shared/effort'
import type { ModelChoiceInfo, ModelChoiceMode } from '../../shared/ipc'

/**
 * Étape 191 (Léo : « même présentation que ChatGPT, pas exactement… ajoute effort et modèle »). Remplace le menu
 * déroulant « MODÈLE Auto » de l'étape 141 : un bouton « Modèle · Effort », qui ouvre au-dessus un panneau avec
 * le curseur d'effort (5 crans) et le nom du modèle — cliquer dessus ouvre la liste « Par défaut » + les rôles.
 *
 * L'effort est une échelle COMMUNE ; le panneau dit ce qu'elle donnera sur le modèle réel (« qwen3.8:27b :
 * off · low · medium · xhigh → medium »), parce que chaque modèle a ses propres niveaux (shared/effort.ts).
 */
interface Props {
  mode: ModelChoiceMode
  disabled?: boolean
}

const AUTO = ''

function ChevronIcon({ direction = 'down' }: { direction?: 'down' | 'right' | 'left' }): JSX.Element {
  const d = direction === 'down' ? 'M6 9l6 6 6-6' : direction === 'right' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function ResetIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v4h4" />
    </svg>
  )
}

function BoltIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}

export default function ModelEffortPicker({ mode, disabled = false }: Props): JSX.Element {
  const [info, setInfo] = useState<ModelChoiceInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'effort' | 'model'>('effort')
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await window.jaris.getModelChoice(mode))
    } catch {
      // L'affichage précédent reste : Auto est de toute façon le comportement par défaut côté main.
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  // Fermeture au clic en dehors ou sur Échap, comme les menus de ChatGPT/Claude.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = info?.selected ?? AUTO
  const role = info?.roles?.find((r) => r.value === selected)
  const modelLabel = selected === AUTO ? 'Auto' : role?.label ?? 'Personnalisé'
  const effort = info?.effort ?? null
  const cannotThink = info?.effortLevels === 'ne réfléchit pas'

  const chooseModel = async (value: string): Promise<void> => {
    setError(null)
    setInfo((prev) => (prev ? { ...prev, selected: value === AUTO ? null : value } : prev))
    setView('effort')
    try {
      await window.jaris.setModelChoice(mode, value === AUTO ? null : value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    void load()
  }

  const chooseEffort = async (value: EffortChoice | null): Promise<void> => {
    setError(null)
    setInfo((prev) => (prev ? { ...prev, effort: value } : prev))
    try {
      await window.jaris.setEffortChoice(mode, value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    void load()
  }

  const index = effort === null ? -1 : EFFORT_STEPS.findIndex((step) => step.value === effort)
  const onSliderKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = index === -1 ? 2 : index
    const next = Math.max(0, Math.min(EFFORT_STEPS.length - 1, from + (event.key === 'ArrowRight' ? 1 : -1)))
    void chooseEffort(EFFORT_STEPS[next].value)
  }

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => {
          if (!open) {
            setView('effort')
            void load()
          }
          setOpen(!open)
        }}
        disabled={disabled || info?.installed === null}
        title={info?.installed === null ? "Ollama ne répond pas : impossible de lister les modèles." : 'Modèle et effort de réflexion'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="effort-picker__model">{modelLabel}</span>
        <span className="effort-picker__effort">{effortLabel(effort)}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div className="effort-picker__panel" role="dialog" aria-label="Modèle et effort">
          {view === 'effort' ? (
            <>
              <div className="effort-picker__head">
                <span className="effort-picker__head-icon" aria-hidden="true">
                  <BoltIcon />
                </span>
                <div className="effort-picker__head-text">
                  <span className="effort-picker__current">{cannotThink ? 'Pas de réflexion' : effortLabel(effort)}</span>
                  <button type="button" className="effort-picker__model-link" onClick={() => setView('model')}>
                    {modelLabel}
                    {role && <span className="effort-picker__model-name"> · {role.model}</span>}
                    <ChevronIcon direction="right" />
                  </button>
                </div>
                <button
                  type="button"
                  className="effort-picker__reset"
                  onClick={() => void chooseEffort(null)}
                  disabled={effort === null}
                  title="Effort automatique (celui que Jaris choisit)"
                  aria-label="Effort automatique"
                >
                  <ResetIcon />
                </button>
              </div>

              <div
                className={`effort-picker__slider${cannotThink ? ' effort-picker__slider--off' : ''}`}
                role="slider"
                tabIndex={cannotThink ? -1 : 0}
                aria-label="Effort de réflexion"
                aria-valuemin={0}
                aria-valuemax={EFFORT_STEPS.length - 1}
                aria-valuenow={index === -1 ? undefined : index}
                aria-valuetext={effortLabel(effort)}
                aria-disabled={cannotThink}
                onKeyDown={cannotThink ? undefined : onSliderKey}
              >
                {EFFORT_STEPS.map((step, i) => (
                  <button
                    key={step.value}
                    type="button"
                    tabIndex={-1}
                    className={`effort-picker__step${i === index ? ' effort-picker__step--active' : ''}`}
                    onClick={() => void chooseEffort(step.value)}
                    disabled={cannotThink}
                    title={step.label}
                    aria-label={step.label}
                  />
                ))}
              </div>
              <div className="effort-picker__scale" aria-hidden="true">
                <span>Aucune</span>
                <span>Maximale</span>
              </div>

              <p className="effort-picker__note">
                {info?.effortModel
                  ? cannotThink
                    ? `${info.effortModel} ne réfléchit pas : l'effort n'a pas d'effet.`
                    : `${info.effortModel} : ${info.effortLevels ?? 'niveaux inconnus'}${effort ? ` → ${info.effortApplied}` : ''}`
                  : effort
                    ? "Auto change de modèle selon la question : l'effort est adapté au modèle choisi à chaque fois."
                    : "Auto : Jaris règle lui-même l'effort selon la question."}
              </p>
            </>
          ) : (
            <>
              <div className="effort-picker__list-head">
                <button type="button" className="effort-picker__back" onClick={() => setView('effort')} aria-label="Retour à l'effort">
                  <ChevronIcon direction="left" />
                </button>
                <span>Sélectionner un modèle</span>
              </div>
              <ul className="effort-picker__list">
                <li>
                  <button type="button" className="effort-picker__option" onClick={() => void chooseModel(AUTO)}>
                    <span className="effort-picker__option-text">
                      <span className="effort-picker__option-title">Par défaut</span>
                      <span className="effort-picker__option-sub">Jaris choisit le bon modèle pour chaque demande</span>
                    </span>
                    {selected === AUTO && <CheckIcon />}
                  </button>
                </li>
                {(info?.roles ?? []).map((r) => (
                  <li key={r.value}>
                    <button
                      type="button"
                      className="effort-picker__option"
                      onClick={() => void chooseModel(r.value)}
                      disabled={!r.installed}
                      title={r.installed ? r.model : `${r.model} n'est pas installé`}
                    >
                      <span className="effort-picker__option-text">
                        <span className="effort-picker__option-title">{r.label}</span>
                        <span className="effort-picker__option-sub">{r.installed ? r.model : `${r.model} — pas installé`}</span>
                      </span>
                      {selected === r.value && <CheckIcon />}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p className="effort-picker__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
