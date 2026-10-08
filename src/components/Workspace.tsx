import { useState } from 'react'
import { createPortal } from 'react-dom'
import { DeleteIcon } from '@/components/icons'
import { useScreenActive, useShellSlots } from '@/lib/shellContext'

/**
 * Liste d'éléments + zone de travail, façon Claude/ChatGPT (étape 97, demande de Léo : "les conversation
 * et code fait comme claude ou chatgpt la meme présentation").
 *
 * UN SEUL composant pour le Chat, le Code, l'Image et la Vidéo, pas quatre mises en page qui se ressemblent :
 * ces écrans font exactement la même chose (une liste d'éléments, un bouton pour en créer un nouveau, le
 * contenu courant). C'est la leçon déjà tirée du composeur à l'étape 92 — deux copies finissent toujours par
 * diverger, et elles avaient effectivement divergé.
 *
 * Refonte « design sobre » (maquette Jaris.dc.html) : la liste n'est plus une deuxième colonne à côté de la
 * barre latérale, elle EST la section « Récents » de cette barre, et le bouton « Nouveau… » son premier
 * bouton — exactement comme ChatGPT. Les deux sont rendus par portail dans les emplacements que la barre
 * prête à l'écran affiché (shellContext.ts) ; l'élément ouvert devient aussi le titre de l'en-tête.
 */
export interface WorkspaceItem {
  id: string
  title: string
  /** Deuxième information, plus discrète (bulle au survol) : la date du dernier échange / de la génération. */
  meta?: string
}

interface WorkspaceProps {
  /** Libellé du bouton de création ("Nouvelle conversation", "Nouvelle application"). */
  newLabel: string
  onNew: () => void
  /** Titre de l'en-tête quand aucun élément n'est ouvert ("Chat", "Code"...). */
  label: string
  items: WorkspaceItem[]
  /** Élément en cours, mis en évidence dans la liste. `null` en mode Code tant que rien n'est chargé. */
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** Phrase affichée à la place de la liste quand il n'y a encore rien. */
  emptyLabel: string
  children: React.ReactNode
}

/** Crayon « nouveau », comme le bouton de ChatGPT (SVG inline, aucune dépendance). */
function NewIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

export default function Workspace({
  newLabel,
  onNew,
  label,
  items,
  activeId,
  onSelect,
  onDelete,
  emptyLabel,
  children
}: WorkspaceProps): JSX.Element {
  const { newSlot, recentsSlot, titleSlot } = useShellSlots()
  const active = useScreenActive()
  /** Élément dont la ligne demande confirmation avant suppression (une seule à la fois). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const activeItem = items.find((item) => item.id === activeId)

  const newButton = (
    <button className="workspace__new" onClick={onNew}>
      <NewIcon />
      {newLabel}
    </button>
  )

  const recents = (
    <div className="workspace__rail">
      <div className="workspace__rail-label">Récents</div>
      {items.length === 0 ? (
        <p className="workspace__empty">{emptyLabel}</p>
      ) : (
        <ul className="workspace__list">
          {items.map((item) => (
            <li key={item.id}>
              {/* Confirmation DANS la ligne, jamais un dialogue natif : celui-ci ferait perdre le focus
                  à la fenêtre, et Jaris se replierait en widget en plein milieu (piège de l'étape 93). */}
              {pendingDelete === item.id ? (
                <div className="workspace__confirm">
                  <span>Supprimer « {item.title} » ?</span>
                  <button
                    className="workspace__confirm-yes"
                    onClick={() => {
                      setPendingDelete(null)
                      onDelete(item.id)
                    }}
                  >
                    Supprimer
                  </button>
                  <button className="workspace__confirm-no" onClick={() => setPendingDelete(null)}>
                    Annuler
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className={`workspace__item${item.id === activeId ? ' workspace__item--active' : ''}`}
                    onClick={() => onSelect(item.id)}
                    title={item.meta ? `${item.title} · ${item.meta}` : item.title}
                  >
                    <span className="workspace__item-title">{item.title}</span>
                    {/* Masquée dans la barre latérale (comme ChatGPT), visible dans la colonne autonome. */}
                    {item.meta && <span className="workspace__item-meta">{item.meta}</span>}
                  </button>
                  <button
                    className="workspace__delete"
                    onClick={() => setPendingDelete(item.id)}
                    title={`Supprimer ${item.title}`}
                    aria-label={`Supprimer ${item.title}`}
                  >
                    <DeleteIcon />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  // Hors de la coque (écran rendu seul, sans barre latérale pour l'accueillir) : la liste reste affichée en
  // colonne à gauche, comme avant la refonte, plutôt que de disparaître.
  const inline = !newSlot || !recentsSlot

  return (
    <div className={`workspace${inline ? ' workspace--inline' : ''}`}>
      {inline ? (
        <div className="workspace__side">
          {newButton}
          {recents}
        </div>
      ) : (
        <>
          {active && createPortal(newButton, newSlot)}
          {active && createPortal(recents, recentsSlot)}
        </>
      )}
      {active && titleSlot && createPortal(activeItem?.title ?? label, titleSlot)}
      <div className="workspace__main">{children}</div>
    </div>
  )
}
