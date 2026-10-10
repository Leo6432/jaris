import { useState } from 'react'
import type { ChangedFile } from '@/lib/codeConversations'

/**
 * La fin d'un travail en mode Code, comme sur ChatGPT (étape 290, Léo, capture à l'appui : « à la fin ça doit faire
 * comme ChatGPT, pas comme ça » — à la place du bandeau vert « Terminé en 2 min 10 — 1 fichier changé : essaie dans
 * l'aperçu… ») : une carte qui dit combien de fichiers ont changé et de combien de lignes, fichier par fichier, avec
 * « Annuler » et « Afficher les modifications ».
 *
 * Les boutons n'existent que sur la carte du DERNIER travail, tant qu'ils ont un sens (`actions`) : une carte plus
 * ancienne reste dans la conversation comme simple trace de ce qui a été fait.
 */
interface Props {
  files: ChangedFile[]
  actions?: {
    /** Absent : rien à annuler (déjà annulé, déjà enregistré, ou une application générée). */
    onUndo?: () => void
    onShow: () => void
    showLabel: string
    busy?: boolean
  }
}

/** Comme ChatGPT : trois fichiers, le reste derrière « Afficher N autres fichiers ». */
const VISIBLE_FILES = 3

function DiffIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M12 7v6M9 10h6M9 17h6" />
    </svg>
  )
}

function UndoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

function FileRow({ file }: { file: ChangedFile }): JSX.Element {
  const slash = file.path.lastIndexOf('/')
  return (
    <>
      <span className="changes-card__path" title={file.path}>
        {slash >= 0 && <span className="changes-card__dir">{file.path.slice(0, slash + 1)}</span>}
        <span className="changes-card__name">{file.path.slice(slash + 1)}</span>
        {file.kind === 'deleted' && <span className="changes-card__deleted"> (supprimé)</span>}
      </span>
      <span className="changes-card__stats">
        {file.added > 0 && <span className="repo-change__added">+{file.added}</span>}
        {file.removed > 0 && <span className="repo-change__removed">−{file.removed}</span>}
      </span>
    </>
  )
}

export default function ChangesCard({ files, actions }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const shown = expanded ? files : files.slice(0, VISIBLE_FILES)
  const hidden = files.length - VISIBLE_FILES

  return (
    <section className="changes-card" aria-label="Fichiers modifiés">
      <header className="changes-card__head">
        <span className="changes-card__icon">
          <DiffIcon />
        </span>
        <span className="changes-card__summary">
          <strong>{files.length === 1 ? '1 fichier modifié' : `${files.length} fichiers modifiés`}</strong>
          <span className="changes-card__totals">
            <span className="repo-change__added">+{added}</span> <span className="repo-change__removed">−{removed}</span>
          </span>
        </span>
        {actions && (
          <span className="changes-card__actions">
            {actions.onUndo && (
              <button
                type="button"
                className="changes-card__undo"
                onClick={actions.onUndo}
                disabled={actions.busy}
                title="Annule ces changements : rien n'a encore été enregistré"
              >
                Annuler <UndoIcon />
              </button>
            )}
            <button type="button" className="changes-card__show" onClick={actions.onShow}>
              {actions.showLabel}
            </button>
          </span>
        )}
      </header>
      <ul className="changes-card__files">
        {shown.map((file) => (
          <li key={file.path}>
            {actions ? (
              <button type="button" className="changes-card__file" onClick={actions.onShow}>
                <FileRow file={file} />
              </button>
            ) : (
              <span className="changes-card__file">
                <FileRow file={file} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="changes-card__more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Afficher moins' : `Afficher ${hidden === 1 ? '1 autre fichier' : `${hidden} autres fichiers`}`} <ChevronIcon open={expanded} />
        </button>
      )}
    </section>
  )
}
