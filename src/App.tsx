import { useEffect, useRef } from 'react'
import JarisFace from '@/components/JarisFace'
import { useJarisStore, type JarisEmotion } from '@/store/useJarisStore'

const EMOTION_BUTTONS: { emotion: JarisEmotion; label: string }[] = [
  { emotion: 'idle', label: 'Veille' },
  { emotion: 'listening', label: 'Écoute' },
  { emotion: 'thinking', label: 'Réflexion' },
  { emotion: 'happy', label: 'Content' },
  { emotion: 'surprised', label: 'Surpris' }
]

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
          Voir le README pour les étapes d'installation. En attendant, teste les émotions ci-dessous.
        </div>
      )}

      <div className="app__controls">
        {EMOTION_BUTTONS.map((btn) => (
          <button
            key={btn.emotion}
            data-active={emotion === btn.emotion}
            onClick={() => setEmotion(btn.emotion)}
          >
            {btn.label}
          </button>
        ))}
      </div>

      <audio ref={audioRef} hidden />
    </div>
  )
}
