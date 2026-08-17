import { useEffect, useRef, useState } from 'react'
import type { GmailStatus, Profile } from '../../shared/ipc'

const TTS_VOICES: Array<{ id: string; label: string }> = [
  { id: 'M1', label: 'M1 — vive, énergique' },
  { id: 'M2', label: 'M2 — grave, sérieuse' },
  { id: 'M3', label: 'M3 — autoritaire, confiante' },
  { id: 'M4', label: 'M4 — douce, jeune' },
  { id: 'M5', label: 'M5 — chaleureuse, narrative' },
  { id: 'F1', label: 'F1 — calme, posée' },
  { id: 'F2', label: 'F2 — vive, enjouée' },
  { id: 'F3', label: 'F3 — professionnelle' },
  { id: 'F4', label: 'F4 — nette, confiante' },
  { id: 'F5', label: 'F5 — douce, bienveillante' }
]

export default function OptionsMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)

  useEffect(() => {
    window.jaris.getGmailStatus().then(setStatus)
    window.jaris.getProfile().then(setProfile)
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

  const handleChooseVoice = async (voiceId: string): Promise<void> => {
    setError(null)
    setPreviewingVoice(voiceId)
    try {
      const audio = await window.jaris.previewVoice(voiceId)
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const blob = new Blob([audio], { type: 'audio/wav' })
      audioUrlRef.current = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.src = audioUrlRef.current
        await audioRef.current.play()
      }

      if (profile) {
        const updated = { ...profile, ttsVoice: voiceId }
        setProfile(updated)
        await window.jaris.saveProfile(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewingVoice(null)
    }
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

          <div className="options-menu__section-title">Voix de Jaris</div>
          <div className="options-menu__voices">
            {TTS_VOICES.map((voice) => (
              <button
                key={voice.id}
                className={`options-menu__voice${profile?.ttsVoice === voice.id ? ' options-menu__voice--selected' : ''}`}
                onClick={() => void handleChooseVoice(voice.id)}
                disabled={previewingVoice !== null}
              >
                {previewingVoice === voice.id ? 'Lecture...' : voice.label}
              </button>
            ))}
          </div>
          <audio ref={audioRef} hidden />

          {error && <div className="options-menu__error">{error}</div>}
        </div>
      )}
    </div>
  )
}
