import { useEffect, useMemo, useState } from 'react'
import { diffLines, type DiffHunk } from '../../shared/lineDiff'
import type { RepoChange, RepoView } from '../../shared/ipc'

/**
 * Un dépôt GitHub ouvert dans le mode Code (étape 277) : ce que Jaris a répondu, puis CHAQUE changement préparé,
 * ligne par ligne, avant le seul bouton qui écrit sur GitHub. Rien ne part sans ce clic : c'est la garantie
 * que Léo voit exactement ce qui sera enregistré.
 *
 * Étape 280 (Léo, capture à l'appui : « enlève dépôt vide et la branche mets pas en haut mais en bas comme le dépôt,
 * comme sur ChatGPT ») : plus d'en-tête en haut. Le dépôt ET la branche se choisissent dans le champ de saisie
 * (GithubPicker, BranchPicker).
 *
 * Étape 282 (Léo : « pour le code fais chat à gauche et aperçu à droite comme Claude et ChatGPT ») : ce panneau vit
 * dans la colonne d'aperçu ; la réponse de Jaris (son résumé) est passée dans la conversation, à gauche.
 */
interface Props {
  repo: RepoView
  busy: boolean
  committed: { url: string; sha: string } | null
  defaultMessage: string
  onCommit: (message: string) => Promise<void>
  onDiscard: (path?: string) => Promise<void>
}

/** Au-delà, la fin d'un très long diff est résumée : l'écran resterait figé sur un fichier réécrit en entier. */
const MAX_LINES_PER_FILE = 800

const KIND_LABEL: Record<RepoChange['kind'], string> = { added: 'Créé', modified: 'Modifié', deleted: 'Supprimé' }

function DiffView({ hunks }: { hunks: DiffHunk[] }): JSX.Element {
  let shown = 0
  let hidden = 0
  const blocks: JSX.Element[] = []
  hunks.forEach((hunk, index) => {
    const rows: JSX.Element[] = []
    for (const line of hunk.lines) {
      if (shown >= MAX_LINES_PER_FILE) {
        hidden += 1
        continue
      }
      shown += 1
      rows.push(
        <div key={rows.length} className={`repo-diff__line repo-diff__line--${line.kind}`}>
          <span className="repo-diff__num">{line.oldNo ?? ''}</span>
          <span className="repo-diff__num">{line.newNo ?? ''}</span>
          <span className="repo-diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
          <span className="repo-diff__text">{line.text}</span>
        </div>
      )
    }
    if (rows.length === 0) return
    if (index > 0) blocks.push(<div key={`sep-${index}`} className="repo-diff__gap" aria-hidden="true">⋯</div>)
    blocks.push(<div key={`hunk-${index}`}>{rows}</div>)
  })
  return (
    <div className="repo-diff">
      {blocks}
      {hidden > 0 && <p className="repo-diff__more">… {hidden} lignes de plus, non affichées.</p>}
    </div>
  )
}

function ChangeCard({ change, busy, onDiscard }: { change: RepoChange; busy: boolean; onDiscard: () => void }): JSX.Element {
  const [open, setOpen] = useState(true)
  const diff = useMemo(() => diffLines(change.before, change.after), [change.before, change.after])
  return (
    <section className="repo-change">
      <header className="repo-change__head">
        <button type="button" className="repo-change__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`repo-change__kind repo-change__kind--${change.kind}`}>{KIND_LABEL[change.kind]}</span>
          <span className="repo-change__path">{change.path}</span>
          <span className="repo-change__stats">
            <span className="repo-change__added">+{diff.added}</span> <span className="repo-change__removed">−{diff.removed}</span>
          </span>
        </button>
        <button type="button" className="repo-change__discard" onClick={onDiscard} disabled={busy} title={`Annuler le changement de ${change.path}`}>
          Annuler
        </button>
      </header>
      {open && <DiffView hunks={diff.hunks} />}
    </section>
  )
}

export default function RepoChanges({ repo, busy, committed, defaultMessage, onCommit, onDiscard }: Props): JSX.Element {
  const [message, setMessage] = useState(defaultMessage)

  // Le message proposé suit la dernière demande, tant que Léo ne l'a pas réécrit lui-même.
  useEffect(() => setMessage(defaultMessage), [defaultMessage])

  const totals = useMemo(
    () =>
      repo.changes.reduce(
        (sum, change) => {
          const diff = diffLines(change.before, change.after)
          return { added: sum.added + diff.added, removed: sum.removed + diff.removed }
        },
        { added: 0, removed: 0 }
      ),
    [repo.changes]
  )
  const hasChanges = repo.changes.length > 0

  return (
    <div className="repo-panel">
      {committed && (
        <p className="repo-panel__committed">
          Enregistré sur GitHub ({committed.sha.slice(0, 7)}) ·{' '}
          <a href={committed.url} target="_blank" rel="noreferrer">
            Voir le commit
          </a>
        </p>
      )}

      {hasChanges && (
        <>
          <div className="repo-panel__changes-head">
            <span>
              {repo.changes.length === 1 ? '1 fichier changé' : `${repo.changes.length} fichiers changés`} ·{' '}
              <span className="repo-change__added">+{totals.added}</span> <span className="repo-change__removed">−{totals.removed}</span>
            </span>
            <button type="button" className="repo-change__discard" onClick={() => void onDiscard()} disabled={busy}>
              Tout annuler
            </button>
          </div>
          {repo.changes.map((change) => (
            <ChangeCard key={change.path} change={change} busy={busy} onDiscard={() => void onDiscard(change.path)} />
          ))}
          <div className="repo-panel__commit">
            <input
              className="repo-panel__message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Description des changements"
              aria-label="Description des changements"
              disabled={busy}
            />
            <button type="button" className="repo-panel__save" onClick={() => void onCommit(message)} disabled={busy || !message.trim()}>
              Enregistrer sur GitHub
            </button>
          </div>
          <p className="repo-panel__note">
            Un seul enregistrement sur la branche {repo.branch}. Rien n'est envoyé à GitHub avant ce clic.
          </p>
        </>
      )}
    </div>
  )
}
