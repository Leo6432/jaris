import type { VideoQualityStatus } from '../../shared/ipc'
import type { VideoQuality } from '../../shared/videoModel'
import SliderPicker from './SliderPicker'

/**
 * Qualité du modèle vidéo (étape 205, Léo : « une barre d'effort Q4, Q6 ou Q8, et si une personne ne peut que Q6
 * elle n'a que Q4 et Q6 »). Seuls les crans que la machine peut faire tourner sont proposés (calculés côté main,
 * availableVideoQualities). Une qualité pas encore téléchargée se télécharge depuis ce même panneau.
 */
interface Props {
  qualities: VideoQualityStatus[]
  value: VideoQuality
  onChange: (quality: VideoQuality) => void
  /** Absent sur l'écran d'installation, qui a déjà son propre bouton « Installer ». */
  onDownload?: (quality: VideoQuality) => void
  disabled?: boolean
}

function QualityIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />
    </svg>
  )
}

export default function VideoQualityPicker({ qualities, value, onChange, onDownload, disabled = false }: Props): JSX.Element {
  const current = qualities.find((q) => q.id === value) ?? qualities[0]
  return (
    <SliderPicker
      className="quality-picker"
      icon={<QualityIcon />}
      triggerLabel={current?.label ?? ''}
      name="Qualité de la vidéo"
      title={`Qualité ${current?.label ?? ''}`}
      steps={qualities.map((q) => ({ value: q.id, label: q.label }))}
      value={value}
      onChange={onChange}
      scale={[qualities[0]?.label ?? '', qualities[qualities.length - 1]?.label ?? '']}
      disabled={disabled}
      footer={
        current && !current.installed && onDownload ? (
          <button type="button" className="quality-picker__download" onClick={() => onDownload(current.id)}>
            Télécharger ({current.downloadLabel})
          </button>
        ) : null
      }
    />
  )
}
