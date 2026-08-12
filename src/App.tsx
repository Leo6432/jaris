import { useEffect, useRef, useState } from 'react'
import JarisFace from '@/components/JarisFace'
import { useJarisStore, type JarisEmotion } from '@/store/useJarisStore'

const STATUS_LABEL: Record<JarisEmotion, string> = {
  idle: 'Jaris dort...',
  listening: "Jaris t'écoute",
  thinking: 'Jaris réfléchit...',
  happy: 'Tâche accomplie',
  surprised: 'Oups !'
}

export default function App(): JSX.Element {
  const emotion = useJarisStore((state) => state.emotion)
  const setEmotion = useJarisStore((state) => state.setEmotion)
  const transcript = useJarisStore((state) => state.transcript)
  const reply = useJarisStore((state) => state.reply)
  const setupStatus = useJarisStore((state) => state.setupStatus)
  const setTranscript = useJarisStore((state) => state.setTranscript)
  const setReply = useJarisStore((state) => state.setReply)
  const setSetupStatus = useJarisStore((state) => state.setSetupStatus)

  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)

  // undefined = pas encore chargé, null = pas de profil (premier lancement)
  const [profileName, setProfileName] = useState<string | null | undefined>(undefined)
  const [nameInput, setNameInput] = useState('')

  useEffect(() => {
    window.jaris.getProfile().then((profile) => setProfileName(profile?.name ?? null))
  }, [])

  const handleOnboardingSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    void window.jaris.saveProfile({ name }).then(() => setProfileName(name))
  }

  useEffect(() => {
    window.jaris.getSetupStatus().then(setSetupStatus)

    const unsubscribers = [
      window.jaris.onEmotion(setEmotion),
      window.jaris.onTranscript(setTranscript),
      window.jaris.onSetupStatus(setSetupStatus),
      window.jaris.onReply(({ reply: replyText, audio }) => {
        setReply(replyText)

        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
        const blob = new Blob([audio], { type: 'audio/wav' })
        audioUrlRef.current = URL.createObjectURL(blob)
        if (audioRef.current) {
          audioRef.current.src = audioUrlRef.current
          void audioRef.current.play()
        }
      })
    ]

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '+' && !event.repeat) {
        window.jaris.triggerWake()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  if (profileName === undefined) {
    return <div className="app" />
  }

  if (profileName === null) {
    return (
      <div className="app">
        <form className="app__onboarding" onSubmit={handleOnboardingSubmit}>
          <h1>Bonjour !</h1>
          <p>Comment dois-je t'appeler ?</p>
          <input
            autoFocus
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            placeholder="Ton prénom"
          />
          <button type="submit">Valider</button>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <JarisFace emotion={emotion} />
      <div className="app__status">{STATUS_LABEL[emotion]}</div>
      <div className="app__hint">Astuce : dis « Hey Jarvis » ou appuie sur + pour activer l'écoute</div>

      {(transcript || reply) && (
        <div className="app__conversation">
          {transcript && <p className="app__transcript">« {transcript} »</p>}
          {reply && <p className="app__reply">{reply}</p>}
        </div>
      )}

      {setupStatus && !setupStatus.ready && (
        <div className="app__setup-warning">
          Pipeline vocal pas encore configuré :
          <ul>
            {setupStatus.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          Voir le README pour les étapes d'installation.
        </div>
      )}

      <audio ref={audioRef} hidden />
    </div>
  )
}
