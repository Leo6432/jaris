import type { ModelPullProgress } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { formatBytes } from '../../shared/formatBytes'
import { t } from '@/lib/i18n'

interface ModelPullBarProps {
  /** Le modèle en cours de téléchargement ; `null` entre deux téléchargements : la barre fait un va-et-vient. */
  pull: ModelPullProgress | null
  /** La ligne affichée quand rien ne se télécharge (dernière étape annoncée : détection, modèle d'image…). */
  line: string
  /** Nom de la barre pour les lecteurs d'écran. */
  label: string
}

/**
 * Avancement du téléchargement d'un modèle : l'étape, une vraie barre et la taille (« 1,9 Go sur 5,4 Go »), plutôt
 * qu'un rond qui tourne — un modèle pèse plusieurs Go, on doit voir que ça avance et combien il en reste. Partagée
 * par les DEUX chemins qui lancent runQuickSetup (écran « Configuration de Jaris » et Options → Modèles →
 * « Retester la configuration ») : deux copies auraient divergé, comme les deux composeurs avant l'étape 92.
 * Le pourcentage vient du processus principal (createPullPercent, ollama.ts) : il ne recule jamais quand Ollama
 * découvre un fichier de plus du modèle en route ; la taille, elle, reste la vraie (le total grandit alors).
 * Rendue sans conteneur : c'est l'écran qui l'insère et la met en page.
 */
export default function ModelPullBar({ pull, line, label }: ModelPullBarProps): JSX.Element {
  const model = pull ? formatModelName(pull.model) : ''
  return (
    <>
      <p className="capacity-scan__status capacity-scan__progress-step">
        {pull ? (pull.nextFile ? t('ollama.pull.nextFile', { model }) : t('ollama.pull.progress', { model, percent: pull.percent })) : line}
      </p>
      <div
        className="runtime-setup__bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pull ? pull.percent : undefined}
      >
        <div
          className={`runtime-setup__bar-fill${pull ? '' : ' runtime-setup__bar-fill--pulse'}`}
          style={pull ? { width: `${pull.percent}%` } : undefined}
        />
      </div>
      {pull && (
        <p className="capacity-scan__status capacity-scan__progress-size">
          {t('setup.downloadSize', { received: formatBytes(pull.completed), total: formatBytes(pull.total) })}
        </p>
      )}
    </>
  )
}
