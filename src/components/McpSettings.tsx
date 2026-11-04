import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { ipcErrorMessage } from '@/lib/ipcError'
import { SettingGroup, Toggle } from './SettingsLayout'
import { MCP_MAX_TOOLS_PER_REQUEST, type McpServerView } from '../../shared/mcp'

/**
 * Étape 418 (Léo : « on peut ajouter les MCP dans Jaris ? … oui fais-le ») : Options → Outils MCP. Léo colle ce que
 * donne la page d'un serveur (bloc JSON « mcpServers », commande `npx -y …` ou adresse) ; chaque serveur dit s'il est
 * connecté, avec ses outils (décochables un par un), ou la vraie raison de son échec. Le main revérifie tout
 * (mcpHub.ts) et ne renvoie jamais la valeur d'une clé.
 */
export default function McpSettings(): JSX.Element {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.jaris
      .mcpList()
      .then((list) => alive && setServers(list))
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    const off = window.jaris.onMcpChanged((list) => setServers(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  const act = (work: Promise<McpServerView[]>): void => {
    setError(null)
    void work.then(setServers).catch((err) => setError(ipcErrorMessage(err)))
  }

  const add = (): void => {
    if (!pasted.trim() || adding) return
    setAdding(true)
    setError(null)
    window.jaris
      .mcpAdd(pasted, name.trim() || undefined)
      .then((list) => {
        setServers(list)
        setPasted('')
        setName('')
      })
      .catch((err) => setError(ipcErrorMessage(err)))
      .finally(() => setAdding(false))
  }

  return (
    <div className="options-menu__section mcp">
      <SettingGroup title={t('mcp.add.title')} description={t('mcp.add.description')}>
        <div className="mcp-add">
          <textarea
            className="mcp-add__input"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={'{"mcpServers": {"fichiers": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\…\\\\Documents"]}}}'}
            rows={5}
            spellCheck={false}
            aria-label={t('mcp.add.title')}
          />
          <div className="mcp-add__row">
            <input
              className="mcp-add__name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('mcp.add.name')}
              aria-label={t('mcp.add.name')}
            />
            <button type="button" className="mcp-btn mcp-btn--primary" onClick={add} disabled={!pasted.trim() || adding}>
              {adding ? t('mcp.add.adding') : t('mcp.add.button')}
            </button>
          </div>
          <p className="mcp-add__warning">{t('mcp.add.warning')}</p>
          {error && (
            <p className="mcp-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </SettingGroup>

      {servers !== null && servers.length === 0 && <p className="mcp-empty">{t('mcp.list.empty')}</p>}
      {servers?.map((server) => (
        <article key={server.id} className={`mcp-server mcp-server--${server.status}`} aria-label={server.name}>
          <header className="mcp-server__head">
            <div className="mcp-server__title">
              <span className="mcp-server__name">{server.name}</span>
              <span className={`mcp-status mcp-status--${server.status}`}>{statusText(server)}</span>
            </div>
            <Toggle checked={server.enabled} onChange={(next) => act(window.jaris.mcpSetEnabled(server.id, next))} label={t('mcp.server.enable', { name: server.name })} />
          </header>
          <p className="mcp-server__summary" title={server.summary}>
            {server.summary}
          </p>
          {server.secretNames.length > 0 && <p className="mcp-server__secrets">{t('mcp.server.secrets', { names: server.secretNames.join(', ') })}</p>}
          {server.status === 'error' && server.error && <p className="mcp-error">{server.error}</p>}

          {server.tools.length > 0 && (
            <details className="mcp-tools">
              <summary>{t('mcp.tools.title', { count: server.tools.filter((tool) => tool.enabled).length, total: server.tools.length })}</summary>
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
                    <Toggle
                      checked={tool.enabled}
                      onChange={(next) => act(window.jaris.mcpSetToolEnabled(server.id, tool.name, next))}
                      label={t('mcp.tool.toggle', { tool: tool.name })}
                    />
                  </li>
                ))}
              </ul>
            </details>
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
                    act(window.jaris.mcpRemove(server.id))
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
                  <button type="button" className="mcp-btn" onClick={() => act(window.jaris.mcpRestart(server.id))} disabled={server.status === 'connecting'}>
                    {t('mcp.server.restart')}
                  </button>
                )}
                <button type="button" className="mcp-btn" onClick={() => setConfirming(server.id)}>
                  {t('common.delete')}
                </button>
              </>
            )}
          </div>
        </article>
      ))}
    </div>
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
    default:
      return t('mcp.status.error')
  }
}
