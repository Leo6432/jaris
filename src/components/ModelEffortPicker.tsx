import { useCallback, useEffect, useRef, useState } from 'react'
import { thinkLabel, type ThinkValue } from '../../shared/effort'
import type { ModelChoiceInfo, ModelChoiceMode } from '../../shared/ipc'

/**
 * Choix du modèle, puis de SA réflexion (« think ») — étapes 191 et 192.
 *
 * Étape 191 : un curseur commun à cinq crans. Léo (étape 192) : « faut d'abord choisir le modèle… on peut
 * choisir un modèle qui a rien et choisir max ». Le panneau montre donc d'abord la liste des modèles, puis une
 * section « Think » qui ne propose QUE ce que ce modèle annonce (shared/effort.ts) :
 *   - des niveaux (qwen3.8) → Auto · off · low · medium · xhigh ;
 *   - avec ou sans (qwen3.5) → Auto · off · on ;
 *   - rien (qwen3-coder) → une phrase, aucun bouton.
 * En Chat/Vocal Auto, le modèle change selon la question : on demande de choisir un modèle d'abord.
 */
interface Props {
  mode: ModelChoiceMode
  disabled?: boolean
}

const AUTO = ''

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
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
  const thinkSelected = thinking?.selected ?? null

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
    return run(() => window.jaris.setModelChoice(mode, value === AUTO ? null : value))
  }

  const chooseThink = (value: ThinkValue | null): Promise<void> => {
    setInfo((prev) => (prev?.thinking ? { ...prev, thinking: { ...prev.thinking, selected: value } } : prev))
    return run(() => window.jaris.setThinkChoice(mode, value))
  }

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => {
          if (!open) void load()
          setOpen(!open)
        }}
        disabled={disabled || info?.installed === null}
        title={info?.installed === null ? "Ollama ne répond pas : impossible de lister les modèles." : 'Modèle et réflexion'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="effort-picker__model">{modelLabel}</span>
        {thinkSelected !== null && <span className="effort-picker__effort">think {thinkLabel(thinkSelected)}</span>}
        <ChevronIcon />
      </button>

      {open && (
        <div className="effort-picker__panel" role="dialog" aria-label="Modèle et réflexion">
          <div className="effort-picker__section-title">Modèle</div>
          <ul className="effort-picker__list">
            <li>
              <button type="button" className="effort-picker__option" onClick={() => void chooseModel(AUTO)}>
                <span className="effort-picker__option-text">
                  <span className="effort-picker__option-title">Auto</span>
                  <span className="effort-picker__option-sub">
                    {info?.autoModel ?? 'Jaris choisit le bon modèle pour chaque demande'}
                  </span>
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

          <div className="effort-picker__think">
            <div className="effort-picker__section-title">
              Think{thinking && <span className="effort-picker__think-model"> · {thinking.model}</span>}
            </div>
            {!thinking ? (
              <p className="effort-picker__note">Choisis d'abord un modèle : en Auto, il change selon la question.</p>
            ) : thinking.kind === 'none' ? (
              <p className="effort-picker__note">Ce modèle ne réfléchit pas : rien à régler.</p>
            ) : thinking.kind === 'unknown' || thinking.options.length === 0 ? (
              <p className="effort-picker__note">Ollama n'a pas dit comment ce modèle réfléchit : Jaris garde son réglage.</p>
            ) : (
              <div className="effort-picker__chips" role="radiogroup" aria-label="Réflexion">
                {[{ value: null as ThinkValue | null, label: 'Auto' }, ...thinking.options].map((option) => {
                  const active = option.value === thinkSelected
                  return (
                    <button
                      key={String(option.value)}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`effort-picker__chip${active ? ' effort-picker__chip--active' : ''}`}
                      onClick={() => void chooseThink(option.value)}
                      title={option.value === null ? 'Jaris règle lui-même la réflexion' : undefined}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {error && <p className="effort-picker__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
