import { VIDEO_DURATIONS, type VideoSeconds } from '../../shared/videoModel'
import SliderPicker from './SliderPicker'
import { tn, t } from '@/lib/i18n'

/**
 * Durée d'une vidéo (étape 204, Léo : « on peut pas ajouter la possibilité de choisir la durée ? comme l'effort »).
 * Une barre de 1 à 5 secondes, même panneau que la réflexion (SliderPicker).
 */
interface Props {
  value: VideoSeconds
  onChange: (seconds: VideoSeconds) => void
  disabled?: boolean
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

const label = (seconds: number): string => tn('video.duration.seconds', seconds)

export default function VideoDurationPicker({ value, onChange, disabled = false }: Props): JSX.Element {
  return (
    <SliderPicker
      className="duration-picker"
      icon={<ClockIcon />}
      triggerLabel={t('duration.seconds', { s: value })}
      name={t('video.duration.name')}
      title={label(value)}
      steps={VIDEO_DURATIONS.map((seconds) => ({ value: seconds, label: label(seconds) }))}
      value={value}
      onChange={onChange}
      scale={[t('duration.seconds', { s: VIDEO_DURATIONS[0] }), t('duration.seconds', { s: VIDEO_DURATIONS[VIDEO_DURATIONS.length - 1] })]}
      disabled={disabled}
    />
  )
}
