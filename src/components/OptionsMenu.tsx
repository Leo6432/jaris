import { useEffect, useState } from 'react'
import type { GmailStatus } from '../../shared/ipc'

export default function OptionsMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.jaris.getGmailStatus().then(setStatus)
  }, [])

  const handleConnect = (): void => {
    setError(null)
    setConnecting(true)
    window.jaris
      .connectGmail()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setConnecting(false))
  }

  const handleDisconnect = (): void => {
    setError(null)
    void window.jaris.disconnectGmail().then(() => setStatus({ connected: false, email: null }))
  }

  return (
    <div className="options-menu">
      <button className="options-menu__trigger" onClick={() => setOpen((v) => !v)}>
        Options
      </button>

      {open && (
        <div className="options-menu__panel">
          <div className="options-menu__section-title">Compte Gmail</div>
          {status?.connected ? (
            <>
              <div className="options-menu__account">{status.email}</div>
              <button className="options-menu__action" onClick={handleDisconnect}>
                Déconnecter
              </button>
            </>
          ) : (
            <button className="options-menu__action" onClick={handleConnect} disabled={connecting}>
              {connecting ? 'Connexion...' : 'Connecter Gmail'}
            </button>
          )}
          {error && <div className="options-menu__error">{error}</div>}
        </div>
      )}
    </div>
  )
}
