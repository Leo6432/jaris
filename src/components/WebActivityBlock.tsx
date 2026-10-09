import { useState } from 'react'
import type { WebActivity } from '../../shared/ipc'
import { isWebLink, pageAddress, sourceDomain, webActivityLabel } from '@/lib/webActivity'

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  )
}

function PageIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={`web-activity__chevron${open ? ' web-activity__chevron--open' : ''}`}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function Source({ url, title }: { url: string; title: string }): JSX.Element {
  // Ouvert dans le navigateur de Windows (setWindowOpenHandler, main.ts) ; jamais un lien qui ne serait pas web.
  return isWebLink(url) ? (
    <a className="web-activity__source" href={url} target="_blank" rel="noreferrer" title={url}>
      <span className="web-activity__source-title">{title}</span>
      <span className="web-activity__source-domain">{sourceDomain(url)}</span>
    </a>
  ) : (
    <span className="web-activity__source">
      <span className="web-activity__source-title">{title}</span>
    </span>
  )
}

/**
 * Étape 273, façon Claude : une ligne repliée (« A cherché sur le web ») avec une petite flèche ; dépliée, chaque
 * recherche avec ses résultats, et chaque page lue. Repliée par défaut : la réponse reste la première chose lue.
 */
export default function WebActivityBlock({ items, running = false }: { items: WebActivity[]; running?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className={`web-activity${running ? ' web-activity--running' : ''}`}>
      <button type="button" className="web-activity__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <SearchIcon />
        <span className="web-activity__label">{webActivityLabel(items, running)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <ol className="web-activity__steps">
          {items.map((item, index) =>
            item.kind === 'search' ? (
              <li key={index} className="web-activity__step">
                <div className="web-activity__step-head">
                  <SearchIcon />
                  <span className="web-activity__query">{item.query}</span>
                  <span className="web-activity__count">
                    {item.failed ? 'échec' : item.results.length === 0 ? 'aucun résultat' : `${item.results.length} résultat${item.results.length > 1 ? 's' : ''}`}
                  </span>
                </div>
                {item.results.length > 0 && (
                  <div className="web-activity__sources">
                    {item.results.map((result, i) => (
                      <Source key={i} url={result.url} title={result.title} />
                    ))}
                  </div>
                )}
              </li>
            ) : (
              <li key={index} className="web-activity__step">
                <div className="web-activity__step-head">
                  <PageIcon />
                  <span className="web-activity__query">Page lue</span>
                  {item.failed && <span className="web-activity__count">échec</span>}
                </div>
                <div className="web-activity__sources">
                  <Source url={item.url} title={pageAddress(item.url)} />
                </div>
              </li>
            )
          )}
        </ol>
      )}
    </div>
  )
}
