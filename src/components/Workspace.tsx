import { useState } from 'react'
import { DeleteIcon } from '@/components/icons'

/**
 * Colonne de gauche + zone de travail, façon Claude/ChatGPT (étape 97, demande de Léo : "les conversation
 * et code fait comme claude ou chatgpt la meme présentation").
 *
 * UN SEUL composant pour le Chat ET le mode Code, pas deux mises en page qui se ressemblent : les deux
 * écrans font exactement la même chose (une liste d'éléments à gauche, un bouton pour en créer un nouveau,
 * le contenu courant à droite). C'est la leçon déjà tirée du composeur à l'étape 92 — deux copies finissent
 * toujours par diverger, et elles avaient effectivement divergé.
 *
 * Remplace côté Chat le menu déroulant de l'étape 96 (la liste ne s'ouvrait qu'à la demande) et côté Code le
 * panneau "Tes applications" de l'étape 94 (posé sous le champ, visible seulement tant qu'aucune application
 * n'était chargée) : dans les deux cas, la liste est maintenant toujours là, au même endroit.
 */
export interface WorkspaceItem {
  id: string
  title: string
  /** Deuxième ligne, plus discrète : la date du dernier échange / de la génération. */
  meta?: string
}

interface WorkspaceProps {
  /** Libellé du bouton de création ("Nouvelle conversation", "Nouvelle application"). */
  newLabel: string
  onNew: () => void
  items: WorkspaceItem[]
  /** Élément en cours, mis en évidence dans la liste. `null` en mode Code tant que rien n'est chargé. */
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** Phrase affichée à la place de la liste quand il n'y a encore rien. */
  emptyLabel: string
  children: React.ReactNode
}

/** Chevrons de repli de la colonne (SVG inline, comme les autres icônes : aucune dépendance). */
function RailToggleIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      {!open && <path d="M13 9l3 3-3 3" />}
    </svg>
  )
}

export default function Workspace({
  newLabel,
  onNew,
  items,
  activeId,
  onSelect,
  onDelete,
  emptyLabel,
  children
}: WorkspaceProps): JSX.Element {
  /**
   * Repliée d'office sur une fenêtre étroite : la colonne des modes prend déjà 200px, donc en dessous de
   * ~700px il ne resterait presque rien pour la discussion elle-même. Lue une seule fois au montage (un
   * état React, pas une media query CSS, parce que le repli doit aussi pouvoir se faire à la main).
   */
  const [railOpen, setRailOpen] = useState(
    () => !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches)
  )
  /** Élément dont la ligne demande confirmation avant suppression (une seule à la fois). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  return (
    <div className="workspace">
      {railOpen && (
        <div className="workspace__rail">
          <button className="workspace__new" onClick={onNew}>
            {newLabel}
          </button>

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
                      <span>Supprimer « {item.title} » définitivement ?</span>
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
                        title={item.title}
                      >
                        <span className="workspace__item-title">{item.title}</span>
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
      )}

      <div className="workspace__main">
        <button
          className="workspace__rail-toggle"
          onClick={() => setRailOpen((open) => !open)}
          title={railOpen ? 'Masquer la liste' : 'Afficher la liste'}
          aria-label={railOpen ? 'Masquer la liste' : 'Afficher la liste'}
          aria-expanded={railOpen}
        >
          <RailToggleIcon open={railOpen} />
        </button>
        {children}
      </div>
    </div>
  )
}
