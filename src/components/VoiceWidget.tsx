import type { RefObject } from 'react'
import JarisOrb from './JarisOrb'
import type { JarisEmotion } from '@/store/useJarisStore'
import { t } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'

/**
 * Étape 432 (Léo : « je veux changer le widget vocal, on ne voit pas le texte… je vois beaucoup d'applis faire ça »,
 * puis « parfait, fais-le ») : une capsule NOIRE collée en haut au centre, façon encoche, au lieu d'un grand orbe et
 * d'un texte posés directement sur le fond d'écran (illisibles sur un fond clair). Une seule capsule qui change de
 * forme : petite au repos, élargie pendant l'écoute et la réflexion, ouverte en carte pour la réponse — texte blanc sur
 * noir, lisible sur n'importe quel fond. L'orbe garde l'identité de Jaris (sa forme et ses couleurs par émotion).
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
            <span className="voice-island__bars">
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
