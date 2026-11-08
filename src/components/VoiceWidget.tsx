import { useEffect, useRef, type RefObject } from 'react'
import JarisOrb, { playingAudioLevel } from './JarisOrb'
import type { JarisEmotion } from '@/store/useJarisStore'
import { t } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'

/**
 * Étape 432 (Léo : « je veux changer le widget vocal, on ne voit pas le texte… je vois beaucoup d'applis faire ça »,
 * puis « parfait, fais-le ») : une capsule collée en haut au centre, façon encoche, au lieu d'un grand orbe et d'un
 * texte posés directement sur le fond d'écran (illisibles sur un fond clair). Une seule capsule qui change de forme :
 * petite au repos, élargie pendant l'écoute et la réflexion, ouverte en carte pour la réponse — lisible sur n'importe
 * quel fond. Elle suit le thème de Windows (variables --island-*, fin d'index.css) : noire au texte blanc en sombre,
 * blanche au texte foncé en clair (Léo : « les widgets en clair, pas en noir, quand le thème est clair »). L'orbe garde
 * l'identité de Jaris (sa forme et ses couleurs par émotion).
 *
 * Un seul orbe, toujours monté : c'est lui qui reçoit le son de la réponse (`audioElRef`, un seul AudioContext par
 * lecteur, voir JarisOrb).
 */
const STATUS_LABEL: Record<JarisEmotion, MessageKey> = {
  idle: 'app.status.idle',
  listening: 'app.status.listening',
  thinking: 'app.status.thinking',
  happy: 'app.status.happy',
  surprised: 'app.status.surprised'
}

export const VOICE_WIDGET_ORB_SIZE = 26

/** Hauteur relative de chaque barre : une forme de voix, pas six barres identiques. */
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.75, 0.95, 0.6]
/** Barre au repos (silence) : un trait, pas une barre vide. */
export const BAR_REST_SCALE = 0.18
/** Sans nouveau niveau depuis ce délai, la voix est retombée dans le silence. */
const CAPTURE_LEVEL_STALE_MS = 250

/**
 * Étape 434 (Léo : « ça bouge aléatoirement, mais ça doit bouger s'il parle ») : les barres suivent le VRAI son —
 * ta voix pendant l'écoute (niveau du micro envoyé par le programme d'écoute), celle de Jaris pendant la réponse
 * (le lecteur audio du widget). Immobiles dans le silence. Mises à jour hors de React (une image par frame).
 */
function useVoiceBars(emotion: JarisEmotion, audioElRef: RefObject<HTMLAudioElement>): RefObject<HTMLSpanElement> {
  const barsRef = useRef<HTMLSpanElement>(null)
  const captured = useRef({ level: 0, at: 0 })
  useEffect(() => window.jaris.onCaptureLevel((level) => (captured.current = { level, at: performance.now() })), [])
  useEffect(() => {
    const bars = barsRef.current ? Array.from(barsRef.current.children) as HTMLElement[] : []
    const setScale = (level: number, time: number): void => {
      bars.forEach((bar, i) => {
        // Un léger mouvement propre à chaque barre, seulement quand il y a du son (multiplié par le niveau).
        const wobble = 0.8 + 0.2 * Math.sin(time / 90 + i * 1.7)
        bar.style.transform = `scaleY(${Math.min(1, BAR_REST_SCALE + level * BAR_WEIGHTS[i % BAR_WEIGHTS.length] * wobble).toFixed(3)})`
      })
    }
    if (emotion !== 'listening' && emotion !== 'happy') {
      setScale(0, 0)
      return undefined
    }
    let shown = 0
    let frame = 0
    const tick = (time: number): void => {
      const target =
        emotion === 'listening'
          ? time - captured.current.at < CAPTURE_LEVEL_STALE_MS
            ? captured.current.level
            : 0
          : Math.min(1, playingAudioLevel(audioElRef.current) * 3)
      shown += (Math.min(1, target * 1.6) - shown) * 0.35
      if (shown < 0.01) shown = 0
      setScale(shown, time)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [emotion, audioElRef])
  return barsRef
}

interface VoiceWidgetProps {
  emotion: JarisEmotion
  transcript: string
  reply: string
  activity: string | null
  audioElRef: RefObject<HTMLAudioElement>
  onOpen: () => void
}

export default function VoiceWidget({ emotion, transcript, reply, activity, audioElRef, onOpen }: VoiceWidgetProps): JSX.Element {
  const resting = emotion === 'idle'
  // Ce qui s'écrit dans la capsule : pendant l'écoute, les mots entendus en direct ; pendant la réflexion, ce que
  // Jaris fait (recherche, outil) ; sinon son état.
  const headline =
    emotion === 'listening' && transcript
      ? transcript
      : emotion === 'thinking' && activity
        ? activity
        : t(STATUS_LABEL[emotion])
  // La carte s'ouvre dès qu'il y a une question à rappeler sous la capsule (réflexion) ou une réponse à lire.
  const question = emotion !== 'listening' && transcript ? transcript : ''
  const answer = emotion === 'happy' || emotion === 'surprised' ? reply : ''
  const open = !resting && Boolean(question || answer)
  const barsRef = useVoiceBars(emotion, audioElRef)
  return (
    <div
      className={`voice-island voice-island--${emotion}${open ? ' voice-island--open' : ''}`}
      data-emotion={emotion}
    >
      <div className="voice-island__head">
        <JarisOrb emotion={emotion} audioElRef={audioElRef} size={VOICE_WIDGET_ORB_SIZE} onClick={onOpen} label={t('widget.chat.idle')} />
        <span className="voice-island__headline" aria-hidden={resting}>
          {headline}
        </span>
        <span className="voice-island__signal" aria-hidden="true">
          {emotion === 'thinking' ? (
            <span className="voice-island__dots">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="voice-island__bars" ref={barsRef}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <i key={i} />
              ))}
            </span>
          )}
        </span>
      </div>
      <div className="voice-island__body" aria-hidden={!open}>
        {question && <p className="voice-island__question">{t('common.quoted', { text: question })}</p>}
        {answer && <p className="voice-island__reply">{answer}</p>}
      </div>
    </div>
  )
}
