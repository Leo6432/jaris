import type { ReactNode } from 'react'
import {
  fileToImageAttachment,
  findImageInDataTransfer,
  pickedFileToImageAttachment,
  type ImageAttachment
} from '@/lib/imageAttachment'

/**
 * Champ de saisie commun au Chat et au mode Code (étape 92).
 *
 * Avant, chaque panneau avait son propre composeur : même textarea, même bouton de pièce jointe, même
 * gestion du collage et du glisser-déposer, écrits DEUX fois. Les deux ont donc divergé visuellement dès le
 * premier ajout (le bouton "Image" était rendu plus visible que l'action principale en mode Code) — un seul
 * composant garantit que les deux écrans se ressemblent par construction, pas seulement par discipline.
 *
 * Le bouton de pièce jointe est une ICÔNE, pas un bouton "Image" en toutes lettres : à la demande de Léo, et
 * parce qu'un bouton texte secondaire a exactement le même poids visuel que l'action principale à côté — ce
 * que montrait la capture avant/après (voir HISTORIQUE). L'icône est un SVG inline (aucune dépendance, aucun
 * emoji) qui hérite de `currentColor`, donc suit l'état normal/survol/désactivé sans code couleur en double.
 */
interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  submitLabel: string
  /** Libellé pendant le traitement (génération/réponse en cours). */
  busyLabel: string
  busy: boolean
  attachment: ImageAttachment | null
  onAttachmentChange: (attachment: ImageAttachment | null) => void
  onError: (message: string) => void
  /** Entrée envoie (Chat). En mode Code, la description est souvent multi-lignes : Entrée va à la ligne. */
  submitOnEnter?: boolean
  rows?: number
  /** Rappel discret des raccourcis, sous le champ — plus lisible que dans le placeholder, qui débordait. */
  hint?: string
  /** Contrôle secondaire posé à côté de la pièce jointe (sélecteur de modèle, étape 141). */
  extraActions?: ReactNode
}

function AttachIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M3.5 17l4.8-4.8a2 2 0 0 1 2.8 0l3.2 3.2m0 0l2-2a2 2 0 0 1 2.8 0l2.2 2.2m-7 -0.2l2.2 2.2" />
    </svg>
  )
}

export default function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  busyLabel,
  busy,
  attachment,
  onAttachmentChange,
  onError,
  submitOnEnter = false,
  rows = 2,
  hint,
  extraActions
}: ComposerProps): JSX.Element {
  const attach = async (file: File | Blob, name = ''): Promise<void> => {
    try {
      onAttachmentChange(await fileToImageAttachment(file, name))
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Le sélecteur de fichier est ouvert par le MAIN process (étape 93), plus par un `<input type="file">`
   * caché : le dialogue natif que Chromium ouvrait pour cet input prenait le focus OS, ce qui repliait Jaris
   * en widget en plein milieu du choix de l'image ("quand je clique sur image ça met jaris en widget et
   * m'ouvre bien mes fichier", Léo en usage réel). Seul le main process peut encadrer ce dialogue du garde
   * qui existe déjà pour ce cas exact (`dialogOpen`, voir main.ts).
   *
   * Les octets reviennent bruts : la réduction reste ici, par exactement le même chemin que le collage et le
   * glisser-déposer ci-dessus.
   */
  const pick = async (): Promise<void> => {
    try {
      const picked = await window.jaris.pickImageFile()
      // null = dialogue annulé : ne touche pas à la pièce jointe déjà choisie, et surtout aucune erreur.
      if (picked) onAttachmentChange(await pickedFileToImageAttachment(picked))
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  // Coller (Ctrl+V) une capture d'écran est le geste le plus courant pour envoyer une image : sans ça, il
  // faudrait d'abord l'enregistrer dans un fichier juste pour pouvoir la choisir. Le glisser-déposer passe
  // par le même chemin, pour la même raison.
  const handlePaste = (event: React.ClipboardEvent): void => {
    const file = findImageInDataTransfer(event.clipboardData.items)
    if (!file) return
    event.preventDefault()
    void attach(file)
  }

  const handleDrop = (event: React.DragEvent): void => {
    const file = findImageInDataTransfer(event.dataTransfer.items)
    if (!file) return
    event.preventDefault()
    void attach(file, file.name)
  }

  // Une image seule ("regarde ça", "reproduis cette maquette") est un envoi parfaitement légitime : le
  // bouton ne dépend donc pas que du texte.
  const canSubmit = !busy && (value.trim().length > 0 || attachment !== null)

  return (
    <div
      className={`composer${busy ? ' composer--busy' : ''}`}
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      {attachment && (
        <div className="composer__attachment">
          <img src={attachment.dataUrl} alt="Aperçu de l'image jointe" />
          <span className="composer__attachment-name">{attachment.name || 'Image collée'}</span>
          <button
            type="button"
            className="composer__attachment-remove"
            onClick={() => onAttachmentChange(null)}
            disabled={busy}
            title="Retirer l'image"
            aria-label="Retirer l'image"
          >
            ✕
          </button>
        </div>
      )}

      <textarea
        className="composer__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (!submitOnEnter) return
          // Entrée envoie, Maj+Entrée passe à la ligne : convention attendue dans une fenêtre de chat.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={rows}
        disabled={busy}
      />

      <div className="composer__actions">
        <button
          type="button"
          className="composer__attach"
          onClick={() => void pick()}
          disabled={busy}
          title="Joindre une image (ou Ctrl+V pour coller)"
          aria-label="Joindre une image"
        >
          <AttachIcon />
        </button>

        {extraActions}

        {hint && <span className="composer__hint">{hint}</span>}

        <button type="button" className="composer__send" onClick={onSubmit} disabled={!canSubmit}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  )
}
