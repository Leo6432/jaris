import { useState } from 'react'

interface GmailOnboardingProps {
  onDone: () => void
}

export default function GmailOnboarding({ onDone }: GmailOnboardingProps): JSX.Element {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const finish = (): void => {
    void window.jaris.markGmailOnboardingDone().then(onDone)
  }

  const handleConnect = (): void => {
    setError(null)
    setConnecting(true)
    window.jaris
      .connectGmail()
      .then(() => finish())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setConnecting(false))
  }

  return (
    <div className="app">
      <div className="app__onboarding">
        <h1>Connecter Gmail ?</h1>
        <p>
          Jaris peut envoyer des mails à ta place une fois ton compte Gmail connecté. Tu pourras te
          connecter ou te déconnecter à tout moment depuis le bouton "Options" en haut à gauche.
        </p>
        <button onClick={handleConnect} disabled={connecting}>
          {connecting ? 'Connexion...' : 'Se connecter à Gmail'}
        </button>
        <button className="app__onboarding-secondary" onClick={finish} disabled={connecting}>
          Ignorer pour l'instant
        </button>
        {error && <div className="options-menu__error">{error}</div>}
      </div>
    </div>
  )
}
