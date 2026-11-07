import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { ipcErrorMessage } from '@/lib/ipcError'
import { Toggle } from './SettingsLayout'
import { MCP_MAX_TOOLS_PER_REQUEST, type McpServerView } from '../../shared/mcp'
import { MCP_CATALOG, MCP_CATEGORIES, catalogEntry, catalogMatches, type McpCatalogEntry } from '../../shared/mcpCatalog'
import { MCP_LOGOS } from '@/assets/mcp-logos'
import type { MessageKey } from '../../shared/i18n'

/**
 * Étape 418, puis 419 (Léo, captures des « Connecteurs » de Claude : « mets les MCP actifs ou désactivés, et mets
 * Ajouter avec une base de MCP que tu vas mettre, où ils peuvent ajouter eux-mêmes leur propre MCP ») : Options →
 * Outils MCP, en deux onglets.
 * - « Les vôtres » : chaque serveur avec son type (sur ce PC / en ligne) et un interrupteur actif/désactivé ; ses
 *   outils (décochables), Relancer et Supprimer dans « Détails ».
 * - « Découvrir » : la base de serveurs choisie par Jaris (shared/mcpCatalog.ts), ajoutée d'un clic (+), avec la seule
 *   chose à demander (un dossier, une clé).
 * - « + Ajouter » : son propre serveur, en collant ce que donne sa page.
 * Le main revérifie tout (mcpHub.ts) et ne renvoie jamais la valeur d'une clé.
 */
type View = 'mine' | 'discover'

/** Icône d'un serveur ajouté à la main (une prise). */
const CUSTOM_ICON = 'M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0zM12 17v4'

/**
 * Pastille d'un service : son logo (étape 424, Léo : « les logos des entreprises, pas des lettres ») sur une tuile
 * claire — certains logos sont sombres sur fond transparent —, ou une prise pour un serveur ajouté à la main.
 */
function McpIcon({ id }: { id: string | null }): JSX.Element {
  const entry = catalogEntry(id)
  const logo = entry ? MCP_LOGOS[entry.logo ?? entry.id] : undefined
  if (logo) {
    return (
      <span className="mcp-icon mcp-icon--logo" aria-hidden="true">
        <img src={logo} alt="" width={26} height={26} draggable={false} />
      </span>
    )
  }
  return (
    <span className="mcp-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={CUSTOM_ICON} />
      </svg>
    </span>
  )
}

/** Exemple du champ « Ajouter » : le serveur de référence « memory » du projet MCP, identique dans toutes les langues. */
export const MCP_EXAMPLE = '{"mcpServers": {"memory": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]}}}'

const catalogDescription = (id: string): string => t(`mcp.catalog.${id}.description` as MessageKey)

export default function McpSettings(): JSX.Element {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [view, setView] = useState<View>('mine')
  const [customOpen, setCustomOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.jaris
      .mcpList()
      .then((list) => {
        if (!alive) return
        setServers(list)
        // Rien encore : on arrive sur « Découvrir », là où il y a quelque chose à faire.
        if (!list.length) setView('discover')
      })
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    const off = window.jaris.onMcpChanged((list) => setServers(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  const act = (work: Promise<McpServerView[]>): Promise<boolean> => {
    setError(null)
    return work
      .then((list) => {
        setServers(list)
        return true
      })
      .catch((err) => {
        setError(ipcErrorMessage(err))
        return false
      })
  }

  return (
    <div className="options-menu__section mcp">
      <div className="mcp-bar">
        <div className="mcp-tabs" role="tablist" aria-label={t('options.tab.mcp')}>
          {(['mine', 'discover'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={`mcp-tab${view === id ? ' mcp-tab--active' : ''}`}
              onClick={() => setView(id)}
            >
              {t(id === 'mine' ? 'mcp.tab.mine' : 'mcp.tab.discover')}
            </button>
          ))}
        </div>
        <button type="button" className="mcp-btn mcp-btn--primary mcp-bar__add" aria-expanded={customOpen} aria-label={t('mcp.add.title')} onClick={() => setCustomOpen((open) => !open)}>
          <span aria-hidden="true">+</span> {t('mcp.add.button')}
        </button>
      </div>

      {customOpen && (
        <CustomServer
          onAdded={(list) => {
            setServers(list)
            setCustomOpen(false)
            setView('mine')
          }}
          onCancel={() => setCustomOpen(false)}
        />
      )}
      {error && (
        <p className="mcp-error" role="alert">
          {error}
        </p>
      )}

      {view === 'mine' ? (
        <MineList servers={servers} act={act} onDiscover={() => setView('discover')} />
      ) : (
        <Discover
          servers={servers ?? []}
          onAdd={async (id) => {
            const ok = await act(window.jaris.mcpCatalogAdd(id))
            if (ok) setView('mine')
            return ok
          }}
        />
      )}
      <p className="mcp-add__warning">{t('mcp.add.warning')}</p>
    </div>
  )
}

/** « + Ajouter » : son propre serveur, en collant ce que donne sa page (bloc JSON, commande ou adresse). */
function CustomServer({ onAdded, onCancel }: { onAdded: (list: McpServerView[]) => void; onCancel: () => void }): JSX.Element {
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    if (!pasted.trim() || adding) return
    setAdding(true)
    setError(null)
    window.jaris
      .mcpAdd(pasted, name.trim() || undefined)
      .then(onAdded)
      .catch((err) => setError(ipcErrorMessage(err)))
      .finally(() => setAdding(false))
  }
  return (
    <section className="mcp-add" aria-label={t('mcp.add.title')}>
      <h3 className="mcp-add__title">{t('mcp.add.title')}</h3>
      <p className="mcp-add__description">{t('mcp.add.description')}</p>
      <textarea
        className="mcp-add__input"
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        // Un vrai serveur officiel (le même nom dans toutes les langues) plutôt que « mon-serveur » écrit en français partout.
        placeholder={MCP_EXAMPLE}
        rows={5}
        spellCheck={false}
        aria-label={t('mcp.add.title')}
        autoFocus
      />
      <div className="mcp-add__row">
        <input className="mcp-add__name" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('mcp.add.name')} aria-label={t('mcp.add.name')} />
        <button type="button" className="mcp-btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="mcp-btn mcp-btn--primary" onClick={add} disabled={!pasted.trim() || adding}>
          {adding ? t('mcp.add.adding') : t('mcp.add.button')}
        </button>
      </div>
      {error && (
        <p className="mcp-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function statusText(server: McpServerView): string {
  switch (server.status) {
    case 'ready':
      return t('mcp.status.ready', { count: server.tools.length })
    case 'connecting':
      return t('mcp.status.connecting')
    case 'off':
      return t('mcp.status.off')
    case 'signin':
      return t('mcp.status.signin')
    case 'authorizing':
      return t('mcp.status.authorizing')
    default:
      return t('mcp.status.error')
  }
}

/** « Les vôtres » : un serveur par ligne — icône et nom, type, interrupteur actif/désactivé ; le reste dans « Détails ». */
function MineList({ servers, act, onDiscover }: { servers: McpServerView[] | null; act: (work: Promise<McpServerView[]>) => Promise<boolean>; onDiscover: () => void }): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  if (servers === null) return null
  if (!servers.length) {
    return (
      <div className="mcp-empty">
        <p>{t('mcp.list.empty')}</p>
        <button type="button" className="mcp-btn" onClick={onDiscover}>
          {t('mcp.mine.discover')}
        </button>
      </div>
    )
  }
  return (
    <div className="mcp-table" role="table" aria-label={t('mcp.tab.mine')}>
      <div className="mcp-table__head" role="row">
        <span role="columnheader">{t('mcp.col.name')}</span>
        <span role="columnheader">{t('mcp.col.type')}</span>
        <span role="columnheader">{t('mcp.col.status')}</span>
      </div>
      {servers.map((server) => {
        const expanded = open === server.id
        return (
          <div key={server.id} className={`mcp-row mcp-row--${server.status}`} role="row" aria-label={server.name}>
            <div className="mcp-row__main">
              <button type="button" className="mcp-row__name" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : server.id)} title={t(expanded ? 'mcp.details.hide' : 'mcp.details.show')}>
                <McpIcon id={server.catalogId} />
                <span className="mcp-row__label">
                  <span className="mcp-row__title">{server.name}</span>
                  <span className={`mcp-status mcp-status--${server.status}`}>{statusText(server)}</span>
                </span>
                <span className={`mcp-row__chevron${expanded ? ' mcp-row__chevron--open' : ''}`} aria-hidden="true">
                  ›
                </span>
              </button>
              <span className="mcp-row__type" role="cell">
                {t(server.kind === 'online' ? 'mcp.type.online' : 'mcp.type.local')}
              </span>
              <span className="mcp-row__switch" role="cell">
                <Toggle checked={server.enabled} onChange={(next) => void act(window.jaris.mcpSetEnabled(server.id, next))} label={t('mcp.server.enable', { name: server.name })} />
              </span>
            </div>
            {server.status === 'error' && server.error && <p className="mcp-error mcp-row__error">{server.error}</p>}
            {/* Étape 419 : la connexion avec le compte de Léo (page du service dans son navigateur). */}
            {server.enabled && server.kind === 'online' && server.secretNames.length === 0 && (server.status === 'signin' || server.status === 'error' || server.status === 'authorizing') && (
              <div className="mcp-row__signin">
                {server.status === 'authorizing' ? (
                  <button type="button" className="mcp-btn" onClick={() => void act(window.jaris.mcpCancelSignIn(server.id))}>
                    {t('common.cancel')}
                  </button>
                ) : (
                  <button type="button" className="mcp-btn mcp-btn--primary" onClick={() => void act(window.jaris.mcpSignIn(server.id))}>
                    {t('mcp.server.signin')}
                  </button>
                )}
              </div>
            )}
            {expanded && (
              <div className="mcp-row__details">
                <p className="mcp-server__summary" title={server.summary}>
                  {server.summary}
                </p>
                {server.secretNames.length > 0 && <p className="mcp-server__secrets">{t('mcp.server.secrets', { names: server.secretNames.join(', ') })}</p>}
                {server.tools.length > 0 && (
                  <div className="mcp-tools">
                    <p className="mcp-tools__title">{t('mcp.tools.title', { count: server.tools.filter((tool) => tool.enabled).length, total: server.tools.length })}</p>
                    {server.tools.length > MCP_MAX_TOOLS_PER_REQUEST && <p className="mcp-tools__note">{t('mcp.tools.limit', { max: MCP_MAX_TOOLS_PER_REQUEST })}</p>}
                    <ul className="mcp-tools__list">
                      {server.tools.map((tool) => (
                        <li key={tool.name} className="mcp-tool">
                          <div className="mcp-tool__text">
                            <span className="mcp-tool__name">
                              {tool.name}
                              {tool.readOnly && <span className="mcp-tool__badge">{t('mcp.tool.readOnly')}</span>}
                            </span>
                            {tool.description && <span className="mcp-tool__description">{tool.description}</span>}
                          </div>
                          <Toggle checked={tool.enabled} onChange={(next) => void act(window.jaris.mcpSetToolEnabled(server.id, tool.name, next))} label={t('mcp.tool.toggle', { tool: tool.name })} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mcp-server__actions">
                  {confirming === server.id ? (
                    <>
                      <span className="mcp-server__confirm">{t('mcp.server.removeConfirm', { name: server.name })}</span>
                      <button
                        type="button"
                        className="mcp-btn mcp-btn--danger"
                        onClick={() => {
                          setConfirming(null)
                          void act(window.jaris.mcpRemove(server.id))
                        }}
                      >
                        {t('common.delete')}
                      </button>
                      <button type="button" className="mcp-btn" onClick={() => setConfirming(null)}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      {server.enabled && (
                        <button type="button" className="mcp-btn" onClick={() => void act(window.jaris.mcpRestart(server.id))} disabled={server.status === 'connecting'}>
                          {t('mcp.server.restart')}
                        </button>
                      )}
                      <button type="button" className="mcp-btn" onClick={() => setConfirming(server.id)}>
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** « Découvrir » : les services proposés par Jaris, en cartes ; « + » ajoute et ouvre la connexion avec ton compte. */
function Discover({ servers, onAdd }: { servers: McpServerView[]; onAdd: (id: string) => Promise<boolean> }): JSX.Element {
  const added = new Set(servers.map((server) => server.catalogId).filter(Boolean))
  // Étape 425 : la recherche porte sur ce qui est affiché (nom, description, rubrique), dans la langue de Léo.
  const [query, setQuery] = useState('')
  const sections = MCP_CATEGORIES.map((category) => {
    const title = t(`mcp.category.${category}` as MessageKey)
    const entries = MCP_CATALOG.filter((entry) => entry.category === category && catalogMatches(query, [entry.name, catalogDescription(entry.id), title]))
    return { category, title, entries }
  }).filter((section) => section.entries.length)
  // Étape 424 : par rubrique, dans l'ordre de la liste de Léo.
  return (
    <div className="mcp-discover">
      <input
        type="search"
        className="mcp-search"
        placeholder={t('mcp.search.placeholder')}
        aria-label={t('mcp.search.placeholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.stopPropagation()
            setQuery('')
          }
        }}
      />
      {!sections.length && (
        <p className="mcp-search__empty" role="status">
          {t('mcp.search.empty', { query: query.trim(), button: t('mcp.add.button') })}
        </p>
      )}
      {sections.map(({ category, title, entries }) => {
        return (
          <section key={category} className="mcp-discover__section" aria-label={title}>
            <h3 className="mcp-discover__title">{title}</h3>
            <ul className="mcp-catalog">
              {entries.map((entry) => (
                <CatalogCard key={entry.id} entry={entry} added={added.has(entry.id)} onAdd={onAdd} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function CatalogCard({ entry, added, onAdd }: { entry: McpCatalogEntry; added: boolean; onAdd: (id: string) => Promise<boolean> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const add = (): void => {
    setBusy(true)
    void onAdd(entry.id).finally(() => setBusy(false))
  }
  return (
    <li className="mcp-card" aria-label={entry.name}>
      <div className="mcp-card__top">
        <McpIcon id={entry.id} />
        <div className="mcp-card__text">
          <span className="mcp-card__name">{entry.name}</span>
          <span className="mcp-card__description">{catalogDescription(entry.id)}</span>
          <span className="mcp-card__by">{t('mcp.catalog.account')}</span>
        </div>
        {added ? (
          <span className="mcp-card__added" title={t('mcp.catalog.added')} aria-label={t('mcp.catalog.added')}>
            ✓
          </span>
        ) : (
          <button type="button" className="mcp-card__plus" onClick={add} disabled={busy} aria-label={t('mcp.catalog.add', { name: entry.name })} title={t('mcp.catalog.add', { name: entry.name })}>
            +
          </button>
        )}
      </div>
    </li>
  )
}
