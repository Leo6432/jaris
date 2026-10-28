import { useEffect, useMemo, useRef, useState } from 'react'
import { ipcErrorMessage } from '@/lib/ipcError'
import { t } from '@/lib/i18n'
import type { RepoFileContent } from '../../shared/ipc'

/**
 * Vue « Code » du mode Code (étape 327, Léo, capture d'un autre outil à l'appui : « avoir aperçu et code dans
 * code ») : la liste des fichiers à gauche, avec une recherche, et le fichier ouvert à droite, avec ses numéros de
 * ligne et un onglet par fichier ouvert. En lecture seule : c'est Jaris qui modifie les fichiers, à la demande.
 *
 * Le même composant sert à un dépôt GitHub (tous ses fichiers, lus à la demande) et à une application générée (son
 * unique index.html) : les deux vues se ressemblent par construction.
 */

/** Ce qui a changé dans un fichier depuis GitHub, pour le signaler dans la liste. */
export type FileChangeKind = 'added' | 'modified'

interface Props {
  /** Les fichiers, chemins relatifs avec « / ». `null` : la liste arrive. */
  files: string[] | null
  /** Les fichiers ajoutés ou modifiés par Jaris et pas encore sur GitHub. */
  changes?: ReadonlyMap<string, FileChangeKind>
  /** Le fichier ouvert d'abord. */
  initialPath: string | null
  /** Lit un fichier. */
  load: (path: string) => Promise<RepoFileContent>
  /** Change à chaque nouvel état des fichiers : ce qui avait déjà été lu est relu. */
  version: unknown
  /** Le message quand il n'y a encore aucun fichier. */
  emptyMessage: string
}

type Content = { status: 'loading' } | { status: 'done'; file: RepoFileContent } | { status: 'error'; message: string }

interface FolderNode {
  name: string
  path: string
  folders: FolderNode[]
  files: string[]
}

/** Au-delà, une recherche affiche les premiers résultats et invite à préciser : une liste de milliers de lignes ne sert à rien. */
const MAX_SEARCH_RESULTS = 200

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** Les dossiers qui contiennent ce fichier : « src/a/b.ts » → « src », « src/a ». */
function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** L'arbre des dossiers, dossiers d'abord puis fichiers, chacun par ordre alphabétique — comme un explorateur. */
export function buildFileTree(paths: string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [] }
  const folders = new Map<string, FolderNode>([['', root]])
  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path)
    if (existing) return existing
    const parent = folderFor(dirName(path))
    const node: FolderNode = { name: baseName(path), path, folders: [], files: [] }
    parent.folders.push(node)
    folders.set(path, node)
    return node
  }
  for (const path of paths) folderFor(dirName(path)).files.push(path)
  const compare = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })
  for (const node of folders.values()) {
    node.folders.sort((a, b) => compare(a.name, b.name))
    node.files.sort((a, b) => compare(baseName(a), baseName(b)))
  }
  return root
}

/** Les lignes d'un fichier : un fichier terminé par un retour à la ligne n'a pas de ligne vide en plus. */
export function lineCount(text: string): number {
  if (text === '') return 1
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Un fichier en lecture seule, numéros de ligne à gauche. Partagé par cette vue et par le Duel (étape 364) pour que
 * le code s'affiche partout de la même façon.
 */
export function CodeSource({ text, label }: { text: string; label: string }): JSX.Element {
  const gutter = useMemo(() => Array.from({ length: lineCount(text) }, (_, index) => index + 1).join('\n'), [text])
  return (
    <div className="code-browser__source">
      <pre className="code-browser__gutter" aria-hidden="true">
        {gutter}
      </pre>
      <pre className="code-browser__code" tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1.5M3 7.5h17.2a1 1 0 0 1 1 1.2l-1.4 8.6a2 2 0 0 1-2 1.7H5.2a2 2 0 0 1-2-1.8Z" />
      ) : (
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
      )}
    </svg>
  )
}

function FileIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={`code-browser__chevron${open ? ' code-browser__chevron--open' : ''}`}
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

function CollapseAllIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export default function CodeBrowser({ files, changes, initialPath, load, version, emptyMessage }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialPath ? ancestors(initialPath) : []))
  const [tabs, setTabs] = useState<string[]>(() => (initialPath ? [initialPath] : []))
  const [active, setActive] = useState<string | null>(initialPath)
  const [contents, setContents] = useState<Map<string, Content>>(() => new Map())
  /** Pour ignorer une lecture arrivée après un nouvel état des fichiers. */
  const versionRef = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const tree = useMemo(() => buildFileTree(files ?? []), [files])
  const fileSet = useMemo(() => new Set(files ?? []), [files])

  // Un nouvel état des fichiers (travail de Jaris, annulation, enregistrement) : tout ce qui avait été lu est relu,
  // et un onglet dont le fichier n'existe plus se ferme.
  useEffect(() => {
    versionRef.current++
    setContents(new Map())
  }, [version])

  useEffect(() => {
    if (!files) return
    // Rien de changé : le même tableau, pour que React n'affiche rien de nouveau.
    setTabs((current) => {
      const kept = current.filter((path) => fileSet.has(path))
      return kept.length === current.length ? current : kept
    })
    setActive((current) => (current && fileSet.has(current) ? current : null))
  }, [files, fileSet])

  // Le premier fichier à ouvrir arrive parfois après la liste (un dépôt dont on vient de recevoir les fichiers).
  useEffect(() => {
    if (!initialPath || active || !fileSet.has(initialPath)) return
    openFile(initialPath)
  }, [initialPath, fileSet])

  // Le fichier affiché est lu s'il ne l'a pas encore été.
  useEffect(() => {
    if (!active || contents.has(active) || !fileSet.has(active)) return
    const path = active
    const request = versionRef.current
    setContents((current) => new Map(current).set(path, { status: 'loading' }))
    loadRef.current(path).then(
      (file) => {
        if (versionRef.current === request) setContents((current) => new Map(current).set(path, { status: 'done', file }))
      },
      (err: unknown) => {
        if (versionRef.current === request) setContents((current) => new Map(current).set(path, { status: 'error', message: ipcErrorMessage(err) }))
      }
    )
  }, [active, contents, fileSet])

  function openFile(path: string): void {
    setTabs((current) => (current.includes(path) ? current : [...current, path]))
    setActive(path)
    setExpanded((current) => {
      const next = new Set(current)
      for (const folder of ancestors(path)) next.add(folder)
      return next
    })
  }

  function closeTab(path: string): void {
    const index = tabs.indexOf(path)
    const next = tabs.filter((tab) => tab !== path)
    setTabs(next)
    if (active === path) setActive(next[Math.min(index, next.length - 1)] ?? null)
  }

  function toggleFolder(path: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const needle = query.trim().toLowerCase()
  const matches = needle ? (files ?? []).filter((path) => path.toLowerCase().includes(needle)) : []

  const changeBadge = (path: string): JSX.Element | null => {
    const kind = changes?.get(path)
    if (!kind) return null
    return (
      <span
        className={`code-browser__badge code-browser__badge--${kind}`}
        title={t(kind === 'added' ? 'code.browser.added' : 'code.browser.modified')}
      >
        {kind === 'added' ? 'A' : 'M'}
      </span>
    )
  }

  // Dans l'arbre, l'icône d'un fichier s'aligne sur celle des dossiers voisins, qui ont un chevron devant (13 + 6 px).
  const fileRow = (path: string, depth: number, label: string, inTree: boolean): JSX.Element => (
    <li key={path}>
      <button
        type="button"
        className={`code-browser__row code-browser__file${path === active ? ' code-browser__row--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 + (inTree ? 19 : 0) }}
        title={path}
        aria-current={path === active ? 'true' : undefined}
        onClick={() => openFile(path)}
      >
        <span className="code-browser__icon">
          <FileIcon />
        </span>
        <span className="code-browser__name">{label}</span>
        {changeBadge(path)}
      </button>
    </li>
  )

  const folderRows = (node: FolderNode, depth: number): JSX.Element[] => [
    ...node.folders.map((folder) => {
      const open = expanded.has(folder.path)
      return (
        <li key={`dir:${folder.path}`}>
          <button
            type="button"
            className="code-browser__row code-browser__folder"
            style={{ paddingLeft: 8 + depth * 14 }}
            title={folder.path}
            aria-expanded={open}
            onClick={() => toggleFolder(folder.path)}
          >
            <ChevronIcon open={open} />
            <span className="code-browser__icon">
              <FolderIcon open={open} />
            </span>
            <span className="code-browser__name">{folder.name}</span>
          </button>
          {open && <ul className="code-browser__list">{folderRows(folder, depth + 1)}</ul>}
        </li>
      )
    }),
    ...node.files.map((path) => fileRow(path, depth, baseName(path), true))
  ]

  const current = active ? contents.get(active) : undefined
  const text = current?.status === 'done' ? current.file.text : null

  return (
    <div className="code-browser">
      <nav className="code-browser__side" aria-label={t('code.browser.files')}>
        <div className="code-browser__search">
          <span className="code-browser__search-icon">
            <SearchIcon />
          </span>
          <input
            className="code-browser__search-input"
            type="search"
            value={query}
            placeholder={t('code.browser.search')}
            aria-label={t('code.browser.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="panel__icon-button code-browser__collapse"
            title={t('code.browser.collapseAll')}
            aria-label={t('code.browser.collapseAll')}
            disabled={expanded.size === 0}
            onClick={() => setExpanded(new Set())}
          >
            <CollapseAllIcon />
          </button>
        </div>
        <div className="code-browser__tree">
          {files === null ? (
            <p className="code-browser__note">{t('common.loading')}</p>
          ) : files.length === 0 ? (
            <p className="code-browser__note">{emptyMessage}</p>
          ) : needle ? (
            matches.length === 0 ? (
              <p className="code-browser__note">{t('code.browser.noMatch')}</p>
            ) : (
              <>
                <ul className="code-browser__list">
                  {matches.slice(0, MAX_SEARCH_RESULTS).map((path) => fileRow(path, 0, path, false))}
                </ul>
                {matches.length > MAX_SEARCH_RESULTS && <p className="code-browser__note">{t('code.browser.narrow')}</p>}
              </>
            )
          ) : (
            <ul className="code-browser__list">{folderRows(tree, 0)}</ul>
          )}
        </div>
      </nav>

      <div className="code-browser__main">
        {tabs.length > 0 && (
          <div className="code-browser__tabs" role="tablist" aria-label={t('code.browser.openFiles')}>
            {tabs.map((path) => (
              <div key={path} className={`code-browser__tab${path === active ? ' code-browser__tab--active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={path === active}
                  className="code-browser__tab-name"
                  title={path}
                  onClick={() => setActive(path)}
                >
                  {baseName(path)}
                </button>
                <button
                  type="button"
                  className="code-browser__tab-close"
                  title={t('code.browser.close', { name: baseName(path) })}
                  aria-label={t('code.browser.close', { name: baseName(path) })}
                  onClick={() => closeTab(path)}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="code-browser__viewer">
          {!active ? (
            <p className="code-browser__message">{files && files.length > 0 ? t('code.browser.pick') : ''}</p>
          ) : !current || current.status === 'loading' ? (
            <p className="code-browser__message">{t('common.loading')}</p>
          ) : current.status === 'error' ? (
            <p className="code-browser__message code-browser__message--error">{current.message}</p>
          ) : current.file.missing ? (
            <p className="code-browser__message">{t('code.browser.missing')}</p>
          ) : text === null ? (
            <p className="code-browser__message">{t('code.browser.binary')}</p>
          ) : (
            <CodeSource text={text} label={active ?? ''} />
          )}
        </div>
      </div>
    </div>
  )
}
