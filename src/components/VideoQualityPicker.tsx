import SliderPicker from './SliderPicker'
import { t } from '@/lib/i18n'

/**
 * Qualité du modèle vidéo (étape 205, Léo : « une barre d'effort Q4, Q6 ou Q8, et si une personne ne peut que Q6
 * elle n'a que Q4 et Q6 »). Seuls les crans que la machine peut faire tourner sont proposés (calculés côté main,
 * availableVideoQualities). Une qualité pas encore téléchargée se télécharge depuis ce même panneau.
 *
 * Étape 494 : le même bouton sert aux niveaux du modèle d'image (Q2…Q8, availableImageQualities) — `name` dit lequel.
 */
interface QualityOption<Q extends string> {
  id: Q
  label: string
  installed: boolean
  downloadLabel: string
}

interface Props<Q extends string> {
  qualities: QualityOption<Q>[]
  value: Q
  onChange: (quality: Q) => void
  /** Absent sur l'écran d'installation, qui a déjà son propre bouton « Installer ». */
  onDownload?: (quality: Q) => void
  disabled?: boolean
  /** Nom lu par les lecteurs d'écran et affiché en tête du sélecteur (par défaut : qualité de la vidéo). */
  name?: string
}

export default function VideoQualityPicker<Q extends string>({ qualities, value, onChange, onDownload, disabled = false, name }: Props<Q>): JSX.Element {
  const current = qualities.find((q) => q.id === value) ?? qualities[0]
  return (
    <SliderPicker
      className="quality-picker"
      icon={null}
      triggerLabel={current?.label ?? ''}
      name={name ?? t('video.quality.name')}
      title={t('video.quality.title', { quality: current?.label ?? '' })}
      steps={qualities.map((q) => ({ value: q.id, label: q.label }))}
      value={value}
      onChange={onChange}
      scale={[qualities[0]?.label ?? '', qualities[qualities.length - 1]?.label ?? '']}
      disabled={disabled}
      footer={
        current && !current.installed && onDownload ? (
          <button type="button" className="quality-picker__download" onClick={() => onDownload(current.id)}>
            {t('video.quality.download', { size: current.downloadLabel })}
          </button>
        ) : null
      }
    />
  )
}
