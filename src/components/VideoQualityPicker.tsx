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

export default function VideoQualityPicker({ qualities, value, onChange, onDownload, disabled = false }: Props): JSX.Element {
  const current = qualities.find((q) => q.id === value) ?? qualities[0]
  return (
    <SliderPicker
      className="quality-picker"
      icon={null}
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
