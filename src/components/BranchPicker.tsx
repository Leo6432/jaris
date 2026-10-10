import { useEffect, useState } from 'react'
import { ipcErrorMessage } from '@/lib/ipcError'
import { usePickerPanel } from '@/lib/usePickerPanel'
import type { RepoView } from '../../shared/ipc'

/**
 * La branche du dépôt ouvert, dans le champ de saisie à côté du dépôt (étape 280, Léo : « la branche mets pas en
 * haut mais en bas comme le dépôt, comme sur ChatGPT »). Même famille que les autres boutons du champ.
 *
 * Tant que des changements attendent, le panneau EXPLIQUE pourquoi on ne peut pas changer de branche au lieu
 * d'être un bouton grisé muet : changer de branche abandonnerait ce qui n'est pas encore enregistré.
 */
interface Props {
  repo: RepoView
  onChange: (branch: string) => Promise<void>
  disabled?: boolean
}

/** Branche de git (neutre, sans logo de marque). */
export function BranchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 9.2c0 4.3-6 3.8-11 7.4" />
    </svg>
  )
}

export default function BranchPicker({ repo, onChange, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { rootRef, panelRef, panelStyle } = usePickerPanel(open, setOpen, [branches, error])
  const locked = repo.changes.length > 0

  // Liste relue à chaque ouverture : une branche créée sur github.com entre-temps doit apparaître.
  useEffect(() => {
    if (!open || locked) return
    setBranches(null)
    window.jaris
      .githubListBranches(repo.fullName)
      .then(setBranches)
      .catch((err) => {
        setError(ipcErrorMessage(err))
        setBranches([])
      })
  }, [open, locked, repo.fullName])

  const choose = async (branch: string): Promise<void> => {
    setOpen(false)
    if (branch === repo.branch) return
    try {
      await onChange(branch)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  // Dépôt vide : GitHub ne connaît encore aucune branche, la principale apparaît quand même.
  const shown = branches === null ? [] : branches.includes(repo.branch) ? branches : [repo.branch, ...branches]

  return (
    <div className="effort-picker github-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger github-picker__trigger branch-picker__trigger${open ? ' effort-picker__trigger--open' : ''}`}
        onClick={() => {
          setError(null)
          setOpen(!open)
        }}
        disabled={disabled}
        title={`Branche : ${repo.branch}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <BranchIcon />
        <span className="effort-picker__model branch-picker__name">{repo.branch}</span>
      </button>

      {open && (
        <div ref={panelRef} className="effort-picker__panel github-picker__panel" role="dialog" aria-label="Branche" style={panelStyle}>
          {locked ? (
            <p className="github-picker__text">
              Enregistre ou annule tes changements avant de changer de branche : ils seraient perdus.
            </p>
          ) : (
            <ul className="github-picker__list">
              {branches === null ? (
                <li className="github-picker__empty">Chargement des branches…</li>
              ) : (
                shown.map((branch) => (
                  <li key={branch}>
                    <button
                      type="button"
                      className={`github-picker__repo${branch === repo.branch ? ' github-picker__repo--active' : ''}`}
                      onClick={() => void choose(branch)}
                    >
                      <span className="github-picker__repo-name">{branch}</span>
                      {branch === repo.defaultBranch && <span className="github-picker__repo-meta">Principale</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          {error && <p className="github-picker__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
