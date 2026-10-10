import { useCallback, useEffect, useState } from 'react'
import { ipcErrorMessage } from '@/lib/ipcError'
import { usePickerPanel } from '@/lib/usePickerPanel'
import type { GithubDeviceCode, GithubRepoSummary, GithubStatus, RepoView } from '../../shared/ipc'

/**
 * Le bouton GitHub du champ de saisie, en mode Code (étape 277) — comme le sélecteur de dépôt de Codex ou de
 * Claude Code : on choisit un dépôt, puis on décrit ce qu'il faut y changer.
 *
 * Connexion « la plus facile » (Léo) : un clic, la page GitHub s'ouvre avec le code déjà copié, il n'y a qu'à
 * le coller puis autoriser. Masqué entièrement tant que Jaris n'a pas d'application GitHub configurée.
 */
interface Props {
  repo: RepoView | null
  onOpenRepo: (fullName: string) => Promise<void>
  onCloseRepo: () => void
  disabled?: boolean
}

/** Branche de git (neutre, sans logo de marque). */
export function RepoIcon(): JSX.Element {
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

function shortName(fullName: string): string {
  return fullName.split('/')[1] ?? fullName
}

export default function GithubPicker({ repo, onOpenRepo, onCloseRepo, disabled = false }: Props): JSX.Element | null {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState<GithubDeviceCode | null>(null)
  const [repos, setRepos] = useState<GithubRepoSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const { rootRef, panelRef, panelStyle } = usePickerPanel(open, setOpen, [status, code, repos, error])

  useEffect(() => {
    void window.jaris.githubStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  const loadRepos = useCallback(async () => {
    setError(null)
    try {
      setRepos(await window.jaris.githubListRepos())
    } catch (err) {
      setError(ipcErrorMessage(err))
      // Connexion retirée sur github.com : le panneau repasse sur « Se connecter ».
      setStatus(await window.jaris.githubStatus())
    }
  }, [])

  useEffect(() => {
    if (open && status?.connected && repos === null) void loadRepos()
  }, [open, status, repos, loadRepos])

  if (!status?.available) return null

  const connect = async (): Promise<void> => {
    setError(null)
    try {
      setCode(await window.jaris.githubStartLogin())
      const next = await window.jaris.githubFinishLogin()
      setStatus(next)
      setRepos(null)
    } catch (err) {
      const message = ipcErrorMessage(err)
      if (message !== 'Connexion annulée.') setError(message)
    } finally {
      setCode(null)
    }
  }

  const logout = async (): Promise<void> => {
    await window.jaris.githubLogout()
    setStatus({ available: true, connected: false, login: null })
    setRepos(null)
    onCloseRepo()
  }

  const choose = async (fullName: string): Promise<void> => {
    setError(null)
    setOpening(fullName)
    try {
      await onOpenRepo(fullName)
      setOpen(false)
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setOpening(null)
    }
  }

  const needle = query.trim().toLowerCase()
  const shown = (repos ?? []).filter((item) => !needle || item.fullName.toLowerCase().includes(needle))

  return (
    <div className="effort-picker github-picker" ref={rootRef}>
      <button
        type="button"
        className={`effort-picker__trigger github-picker__trigger${open ? ' effort-picker__trigger--open' : ''}${repo ? ' github-picker__trigger--active' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={repo ? `Dépôt GitHub : ${repo.fullName} (${repo.branch})` : 'Travailler sur un dépôt GitHub'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <RepoIcon />
        <span className="effort-picker__model">{repo ? shortName(repo.fullName) : 'GitHub'}</span>
      </button>

      {open && (
        <div ref={panelRef} className="effort-picker__panel github-picker__panel" role="dialog" aria-label="Dépôt GitHub" style={panelStyle}>
          {!status.connected ? (
            code ? (
              <div className="github-picker__login">
                <p className="github-picker__text">Colle ce code sur la page GitHub qui vient de s'ouvrir, puis clique sur « Authorize ».</p>
                <div className="github-picker__code" aria-label="Code de connexion">
                  {code.userCode}
                </div>
                <p className="github-picker__hint">Code déjà copié. En attente de ta validation sur GitHub…</p>
                <div className="github-picker__row">
                  <a className="github-picker__link" href={code.verificationUri} target="_blank" rel="noreferrer">
                    Rouvrir la page
                  </a>
                  <button type="button" className="github-picker__secondary" onClick={() => window.jaris.githubCancelLogin()}>
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <div className="github-picker__login">
                <p className="github-picker__text">
                  Connecte ton compte GitHub : Jaris pourra lire tes dépôts et y préparer des changements. Tu les vérifies
                  avant qu'ils soient enregistrés.
                </p>
                <button type="button" className="github-picker__primary" onClick={() => void connect()}>
                  Se connecter à GitHub
                </button>
              </div>
            )
          ) : (
            <>
              <div className="github-picker__head">
                <span className="github-picker__account">{status.login ? `@${status.login}` : 'Compte GitHub connecté'}</span>
                <button type="button" className="github-picker__secondary" onClick={() => void logout()}>
                  Se déconnecter
                </button>
              </div>
              <input
                className="github-picker__search"
                type="search"
                placeholder="Rechercher un dépôt"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
              <ul className="github-picker__list">
                {repo && (
                  <li>
                    <button
                      type="button"
                      className="github-picker__repo"
                      onClick={() => {
                        onCloseRepo()
                        setOpen(false)
                      }}
                    >
                      <span className="github-picker__repo-name">Aucun dépôt</span>
                      <span className="github-picker__repo-meta">Nouvelle application</span>
                    </button>
                  </li>
                )}
                {repos === null ? (
                  <li className="github-picker__empty">Chargement des dépôts…</li>
                ) : shown.length === 0 ? (
                  <li className="github-picker__empty">Aucun dépôt trouvé.</li>
                ) : (
                  shown.map((item) => (
                    <li key={item.fullName}>
                      <button
                        type="button"
                        className={`github-picker__repo${repo?.fullName === item.fullName ? ' github-picker__repo--active' : ''}`}
                        onClick={() => void choose(item.fullName)}
                        disabled={opening !== null}
                        title={item.description ?? item.fullName}
                      >
                        <span className="github-picker__repo-name">{item.fullName}</span>
                        <span className="github-picker__repo-meta">
                          {opening === item.fullName ? 'Ouverture…' : item.private ? 'Privé' : 'Public'}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          )}
          {error && <p className="github-picker__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
