import { useCallback, useEffect, useRef, useState } from 'react'
import { thinkLabel, type ThinkValue } from '../../shared/effort'
import type { ModelChoiceInfo, ModelChoiceMode } from '../../shared/ipc'
import { formatModelName } from '@/lib/formatModelName'

/**
 * Modèle et réflexion (« think »), présentés comme le panneau de ChatGPT — étapes 191 à 193.
 *
 * Étape 193 (Léo, capture de ChatGPT à l'appui) : le panneau affiche DÈS l'ouverture le modèle (clic → liste),
 * et en dessous seulement ce que CE modèle sait faire (shared/effort.ts, d'après `/api/show`) :
 *   - des niveaux (qwen3.8 : off · low · medium · xhigh) → l'icône de raisonnement et la barre, un cran par
 *     niveau réel du modèle ;
 *   - avec ou sans (qwen3.5, gemma4) → l'icône de raisonnement et un interrupteur ;
 *   - rien (qwen3-coder) → ni icône, ni barre : juste « ne réfléchit pas ».
 * En Chat/Vocal Auto, le modèle change selon la question : rien d'exact à proposer, il faut choisir un modèle.
 * L'éclair de l'étape 191 est retiré : il ne voulait rien dire.
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

/** Icône « raisonnement » (un cerveau) : affichée seulement pour un modèle qui sait réfléchir. */
function ReasoningIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M12 5v13" />
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
  const [view, setView] = useState<'think' | 'model'>('think')
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
  const thinking = info?.thinking ?? null
  const kind = thinking?.kind ?? null
  const canThink = kind === 'levels' || kind === 'toggle'
  const thinkSelected = thinking?.selected ?? null
  const options = thinking?.options ?? []

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    void load()
  }

  const chooseModel = (value: string): Promise<void> => {
    // Nouveau modèle : sa réflexion repart en Auto (le main fait pareil), en attendant ses vrais choix.
    setInfo((prev) => (prev ? { ...prev, selected: value === AUTO ? null : value, thinking: null } : prev))
    setView('think')
    return run(() => window.jaris.setModelChoice(mode, value === AUTO ? null : value))
  }

  const chooseThink = (value: ThinkValue | null): Promise<void> => {
    setInfo((prev) => (prev?.thinking ? { ...prev, thinking: { ...prev.thinking, selected: value } } : prev))
    return run(() => window.jaris.setThinkChoice(mode, value))
  }

  const index = thinkSelected === null ? -1 : options.findIndex((option) => option.value === thinkSelected)
  const onSliderKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = index === -1 ? Math.floor(options.length / 2) : index
    const next = Math.max(0, Math.min(options.length - 1, from + (event.key === 'ArrowRight' ? 1 : -1)))
    void chooseThink(options[next].value)
  }

  const title = !thinking
    ? 'Auto'
    : kind === 'none'
      ? 'Sans réflexion'
      : kind === 'unknown'
        ? 'Réflexion inconnue'
        : thinkSelected === null
          ? 'Auto'
          : thinkLabel(thinkSelected)

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => {
          if (!open) {
            setView('think')
            void load()
          }
          setOpen(!open)
        }}
        disabled={disabled || info?.installed === null}
        title={info?.installed === null ? "Ollama ne répond pas : impossible de lister les modèles." : 'Modèle et réflexion'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="effort-picker__model">{modelLabel}</span>
        {thinkSelected !== null && <span className="effort-picker__effort">{thinkLabel(thinkSelected)}</span>}
        <ChevronIcon />
      </button>

      {open && (
        <div className="effort-picker__panel" role="dialog" aria-label="Modèle et réflexion">
          {view === 'think' ? (
            <>
              <div className="effort-picker__head">
                {kind === 'toggle' ? (
                  // Modèle « avec ou sans » : on clique directement sur le cerveau (étape 194, Léo).
                  <button
                    type="button"
                    className={`effort-picker__head-icon effort-picker__brain${thinkSelected === true ? ' effort-picker__brain--on' : ''}`}
                    onClick={() => void chooseThink(thinkSelected !== true)}
                    aria-pressed={thinkSelected === true}
                    aria-label="Réfléchir avant de répondre"
                    title={thinkSelected === true ? 'Réflexion activée : cliquer pour la couper' : 'Cliquer pour activer la réflexion'}
                  >
                    <ReasoningIcon />
                  </button>
                ) : (
                  // Étape 195 (Léo) : le cerveau ne sert qu'à dire « réfléchit ou pas » ; un modèle à niveaux a
                  // déjà sa barre, un modèle sans réflexion n'a rien : place vide, le titre reste centré.
                  <span className="effort-picker__head-icon" aria-hidden="true" />
                )}
                <div className="effort-picker__head-text">
                  <span className="effort-picker__current">{title}</span>
                  <button type="button" className="effort-picker__model-link" onClick={() => setView('model')}>
                    <span className="effort-picker__model-role">{modelLabel}</span>
                    {thinking && (
                      <span className="effort-picker__model-name" title={thinking.model}>
                        · {formatModelName(thinking.model, { quant: false })}
                      </span>
                    )}
                    <ChevronIcon direction="right" />
                  </button>
                </div>
                {canThink ? (
                  <button
                    type="button"
                    className="effort-picker__reset"
                    onClick={() => void chooseThink(null)}
                    disabled={thinkSelected === null}
                    title="Réflexion automatique (celle que Jaris choisit)"
                    aria-label="Réflexion automatique"
                  >
                    <ResetIcon />
                  </button>
                ) : (
                  <span />
                )}
              </div>

              {kind === 'levels' && (
                <div
                  className={`effort-picker__slider${index >= 0 ? ' effort-picker__slider--filled' : ''}`}
                  // La barre se remplit jusqu'au cran choisi (étape 194, Léo : « ça doit remplir avant »).
                  style={{ '--fill': options.length > 1 && index >= 0 ? index / (options.length - 1) : 0 } as React.CSSProperties}
                  role="slider"
                  tabIndex={0}
                  aria-label="Niveau de réflexion"
                  aria-valuemin={0}
                  aria-valuemax={options.length - 1}
                  aria-valuenow={index === -1 ? undefined : index}
                  aria-valuetext={title}
                  onKeyDown={onSliderKey}
                >
                  {options.map((option, i) => (
                    <button
                      key={String(option.value)}
                      type="button"
                      tabIndex={-1}
                      className={`effort-picker__step${i === index ? ' effort-picker__step--active' : i < index ? ' effort-picker__step--filled' : ''}`}
                      onClick={() => void chooseThink(option.value)}
                      title={option.label}
                      aria-label={option.label}
                    />
                  ))}
                </div>
              )}
              {kind === 'levels' && (
                <div className="effort-picker__scale" aria-hidden="true">
                  <span>{options[0]?.label}</span>
                  <span>{options[options.length - 1]?.label}</span>
                </div>
              )}



              {/* Étape 196 (Léo) : pas de phrase pour un modèle qui ne réfléchit pas, le titre « Sans réflexion » suffit. */}
              {!canThink && kind !== 'none' && (
                <p className="effort-picker__note">
                  {!thinking
                    ? "En Auto, le modèle change selon la question : choisis un modèle pour régler sa réflexion."
                    : "Ollama n'a pas dit comment ce modèle réfléchit : Jaris garde son réglage."}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="effort-picker__list-head">
                <button type="button" className="effort-picker__back" onClick={() => setView('think')} aria-label="Retour">
                  <ChevronIcon direction="left" />
                </button>
                <span>Sélectionner un modèle</span>
              </div>
              <ul className="effort-picker__list">
                <li>
                  <button type="button" className="effort-picker__option" onClick={() => void chooseModel(AUTO)}>
                    <span className="effort-picker__option-text">
                      <span className="effort-picker__option-title">Auto</span>
                      <span className="effort-picker__option-sub">{info?.autoModel ? formatModelName(info.autoModel, { quant: false }) : 'Jaris choisit le bon modèle pour chaque demande'}</span>
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
                        <span className="effort-picker__option-sub">
                          {formatModelName(r.model, { quant: false })}
                          {r.installed ? '' : ' — pas installé'}
                        </span>
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
