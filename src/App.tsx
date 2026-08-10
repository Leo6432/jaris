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

  return (
    <div className="app">
      <JarisFace emotion={emotion} />
      <div className="app__status">{STATUS_LABEL[emotion]}</div>
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
    </div>
  )
}
