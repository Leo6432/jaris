import { useEffect, useMemo, useRef, useState } from 'react'
import type { GmailStatus, Profile } from '../../shared/ipc'

interface VoiceOption {
  id: string
  description: string
  gradient: string
}

const TTS_VOICES: VoiceOption[] = [
  { id: 'M1', description: 'Vive, énergique', gradient: 'linear-gradient(135deg, #37e2ff, #2b6cff)' },
  { id: 'M2', description: 'Grave, sérieuse', gradient: 'linear-gradient(135deg, #2b6cff, #1c3f99)' },
  { id: 'M3', description: 'Autoritaire, confiante', gradient: 'linear-gradient(135deg, #6c5ce7, #341f97)' },
  { id: 'M4', description: 'Douce, jeune', gradient: 'linear-gradient(135deg, #55e6c1, #10ac84)' },
  { id: 'M5', description: 'Chaleureuse, narrative', gradient: 'linear-gradient(135deg, #feca57, #ff9f43)' },
  { id: 'F1', description: 'Calme, posée', gradient: 'linear-gradient(135deg, #ff9ff3, #f368e0)' },
  { id: 'F2', description: 'Vive, enjouée', gradient: 'linear-gradient(135deg, #ff6b81, #ee5253)' },
  { id: 'F3', description: 'Professionnelle', gradient: 'linear-gradient(135deg, #48dbfb, #0abde3)' },
  { id: 'F4', description: 'Nette, confiante', gradient: 'linear-gradient(135deg, #c8d6e5, #8395a7)' },
  { id: 'F5', description: 'Douce, bienveillante', gradient: 'linear-gradient(135deg, #ffdfba, #ffb8b8)' }
]

const DEFAULT_VOICE_INDEX = TTS_VOICES.findIndex((v) => v.id === 'M3')

type Tab = 'connexions' | 'voix'

export default function OptionsMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('connexions')
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [voiceIndex, setVoiceIndex] = useState(DEFAULT_VOICE_INDEX)
  const [previewing, setPreviewing] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)

  useEffect(() => {
    window.jaris.getGmailStatus().then(setStatus)
    window.jaris.getProfile().then((p) => {
      setProfile(p)
      const savedIndex = TTS_VOICES.findIndex((v) => v.id === p?.ttsVoice)
      if (savedIndex !== -1) setVoiceIndex(savedIndex)
    })
  }, [])

  const voice = useMemo(() => TTS_VOICES[voiceIndex], [voiceIndex])

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

  const chooseVoice = async (index: number): Promise<void> => {
    const nextIndex = (index + TTS_VOICES.length) % TTS_VOICES.length
    setVoiceIndex(nextIndex)
    setError(null)
    setPreviewing(true)
    try {
      const nextVoice = TTS_VOICES[nextIndex]
      const audio = await window.jaris.previewVoice(nextVoice.id)
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const blob = new Blob([audio], { type: 'audio/wav' })
      audioUrlRef.current = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.src = audioUrlRef.current
        await audioRef.current.play()
      }

      if (profile) {
        const updated = { ...profile, ttsVoice: nextVoice.id }
        setProfile(updated)
        await window.jaris.saveProfile(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="options-menu">
      <button className="options-menu__trigger" onClick={() => setOpen((v) => !v)}>
        Options
      </button>

      {open && (
        <div className="options-menu__panel">
          <div className="options-menu__tabs">
            <button
              className={`options-menu__tab${tab === 'connexions' ? ' options-menu__tab--active' : ''}`}
              onClick={() => setTab('connexions')}
            >
              Connexions
            </button>
            <button
              className={`options-menu__tab${tab === 'voix' ? ' options-menu__tab--active' : ''}`}
              onClick={() => setTab('voix')}
            >
              Voix
            </button>
          </div>

          {tab === 'connexions' && (
            <div className="options-menu__section">
              <div className="options-menu__section-title">Mail</div>
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
            </div>
          )}

          {tab === 'voix' && (
            <div className="options-menu__voice-picker">
              <div className="options-menu__voice-nav">
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex - 1)} disabled={previewing}>
                  ‹
                </button>
                <div className="options-menu__voice-orb" style={{ background: voice.gradient }} />
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex + 1)} disabled={previewing}>
                  ›
                </button>
              </div>
              <div className="options-menu__voice-name">{previewing ? 'Lecture...' : voice.id}</div>
              <div className="options-menu__voice-description">{voice.description}</div>
              <div className="options-menu__voice-dots">
                {TTS_VOICES.map((v, i) => (
                  <button
                    key={v.id}
                    className={`options-menu__dot${i === voiceIndex ? ' options-menu__dot--active' : ''}`}
                    onClick={() => void chooseVoice(i)}
                    disabled={previewing}
                    aria-label={v.id}
                  />
                ))}
              </div>
            </div>
          )}

          <audio ref={audioRef} hidden />
          {error && <div className="options-menu__error">{error}</div>}
        </div>
      )}
    </div>
  )
}
