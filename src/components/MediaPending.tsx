import { formatDuration } from '@/lib/formatCodeGenProgress'

/**
 * L'attente d'une image ou d'une vidéo (étape 291, Léo, capture à l'appui : « image c'est une catastrophe le design,
 * pourquoi c'est tout en haut »). Le bandeau « Préparation du dessin… [Arrêter] » s'affichait en haut, le champ de
 * saisie juste dessous et tout le reste de l'écran vide. Comme ChatGPT : au centre, un cadre aux proportions de ce qui
 * se crée, qui se remplit au fil des étapes ; le champ reste en bas, et l'arrêt passe par son bouton.
 */
interface Props {
  /** Ce qui est en train de se faire : « Création de l'image… », « Téléchargement de la qualité Q8… ». */
  title: string
  /** La demande en cours, rappelée au-dessus du cadre (le champ est vidé dès l'envoi). */
  prompt?: string
  /** « Étape 2 sur 4 », ou la dernière ligne du journal. */
  detail?: string | null
  /** Avancement de 0 à 1 quand il est connu. */
  fraction?: number | null
  /** Temps écoulé : la preuve que ça avance, même entre deux étapes. */
  elapsedMs?: number
  shape: 'square' | 'wide'
}

export default function MediaPending({ title, prompt, detail, fraction, elapsedMs, shape }: Props): JSX.Element {
  const meta = [detail, elapsedMs !== undefined ? formatDuration(elapsedMs) : null].filter(Boolean).join(' · ')
  return (
    <div className="media-pending" role="status" aria-live="polite">
      {prompt && <p className="media-pending__prompt">{prompt}</p>}
      <div className={`media-pending__frame media-pending__frame--${shape}`}>
        <span className="media-pending__shimmer" aria-hidden="true" />
        <div className="media-pending__label">
          <strong>{title}</strong>
          {meta && <span>{meta}</span>}
        </div>
        {fraction !== undefined && fraction !== null && (
          <div className="media-pending__bar">
            <div className="media-pending__bar-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}
