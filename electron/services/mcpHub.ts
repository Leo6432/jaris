import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { delimiter, isAbsolute, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { McpSignInError, forgetMcpAuth, listenForMcpCallback, mcpAuthPort, mcpAuthProvider, resetMcpAuthPort } from './mcpAuth'
import type { OllamaTool } from './ollama'
import {
  cleanServerName,
  mcpResultText,
  mcpToolName,
  parseMcpConfigFile,
  parseMcpPaste,
  isServerNamed,
  pickMcpTools,
  secretNames,
  serverRequestedWaitMs,
  transportSummary,
  type McpConfigFile,
  type McpContentPart,
  type McpServerConfig,
  type McpServerStatus,
  type McpServerView,
  type McpToolCandidate
} from '../../shared/mcp'
import { catalogEntry, catalogTransport } from '../../shared/mcpCatalog'
import { t } from '../../shared/i18n'

/**
 * Étape 418 : les serveurs MCP de Léo (Model Context Protocol), branchés au démarrage, et leurs outils donnés au modèle
 * du Chat et du Vocal (assistant.ts, par `setExtraToolSource` — pas d'import là-bas, pour ne casser aucun test qui
 * charge assistant.ts avec ses propres modules).
 *
 * Sécurité : un serveur local est lancé SANS shell (StdioClientTransport : cross-spawn, `shell: false`, tableau
 * d'arguments ; console cachée sous Windows). Ajouter un serveur, c'est le choix de Léo, fait dans les Options ; chaque
 * outil peut y être décoché. L'écran ne reçoit jamais les valeurs des variables d'environnement ni des en-têtes.
 */

/** Démarrage d'un serveur : `npx -y` peut télécharger son paquet la première fois (souvent 30 s à 2 min). */
const CONNECT_TIMEOUT_MS = 180_000
/** Sans aucun signe de vie (progression) pendant ce temps, l'outil est abandonné, avec un message qui le dit. */
const TOOL_IDLE_TIMEOUT_MS = 300_000
/** Les dernières lignes que le serveur a écrites sur sa sortie d'erreur : la vraie raison d'un échec, quand il y en a. */
const STDERR_TAIL_CHARS = 2000
/** Étape 419 : le temps laissé à Léo pour se connecter dans son navigateur. */
const SIGNIN_TIMEOUT_MS = 10 * 60_000

interface ServerTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

interface Connection {
  config: McpServerConfig
  status: McpServerStatus
  error: string | null
  client: Client | null
  tools: ServerTool[]
  stderr: string
  /** Change à chaque (re)connexion : un ancien client qui se ferme ne touche plus l'état du nouveau. */
  generation: number
}

const configPath = (): string => join(getDataRoot(), 'mcp-servers.json')
const unreadableDir = (): string => join(getDataRoot(), UNREADABLE_DATA_DIR)

let config: McpConfigFile = { servers: [] }
const connections = new Map<string, Connection>()
let loading: Promise<void> | null = null
let onChange: (() => void) | null = null
let writeChain: Promise<unknown> = Promise.resolve()

/** main.ts : prévenir l'écran (Options) à chaque changement d'état d'un serveur. */
export function setMcpChangeListener(listener: (() => void) | null): void {
  onChange = listener
}

function changed(): void {
  try {
    onChange?.()
  } catch (err) {
    console.error('[jaris] MCP : écran non prévenu —', err)
  }
}

function save(): Promise<void> {
  const snapshot = JSON.stringify(config, null, 2)
  const run = writeChain.then(() => writeFileAtomic(configPath(), snapshot))
  writeChain = run.catch((err) => console.error('[jaris] MCP : configuration non enregistrée —', err))
  return run
}

function loadOnce(): Promise<void> {
  loading ??= readJsonDataFile(configPath(), parseMcpConfigFile, unreadableDir(), 'mcp-servers')
    .then((read) => {
      if (read.status === 'ok') config = read.value
    })
    .catch((err) => console.error('[jaris] MCP : configuration illisible pour l’instant —', err))
  return loading
}

/** Au démarrage de Jaris : relit la configuration et branche les serveurs activés (sans attendre qu'ils répondent). */
export async function startMcpHub(): Promise<void> {
  await loadOnce()
  for (const server of config.servers) if (server.enabled) void connect(server)
}

/** À la fermeture de Jaris : chaque serveur local est arrêté (jamais laissé tourner sans Jaris). */
export async function stopMcpHub(): Promise<void> {
  for (const run of signIns.values()) run.controller.abort()
  await Promise.all([...connections.values()].map((connection) => closeConnection(connection)))
  connections.clear()
}

async function closeConnection(connection: Connection): Promise<void> {
  connection.generation++
  const client = connection.client
  connection.client = null
  if (client) await client.close().catch(() => {})
}

/** Le message lisible d'un échec de démarrage, avec ce que le serveur a lui-même écrit quand il a écrit quelque chose. */
export function startFailure(server: McpServerConfig, err: unknown, stderr: string): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ENOENT' && server.transport.kind === 'stdio') return t('mcp.error.commandNotFound', { command: server.transport.command })
  const said = lastLines(stderr)
  const message = err instanceof Error ? err.message : String(err)
  // Étape 419 : une clé absente ou refusée (GitHub : « missing required Authorization header », 401, 403) se dit telle quelle.
  if (server.transport.kind === 'http' && /authori[sz]|\b40[13]\b|forbidden|token/i.test(message)) return t('mcp.error.auth', { name: server.name })
  if (server.transport.kind === 'http') return t('mcp.error.unreachable', { name: server.name, url: server.transport.url, error: message })
  return t('mcp.error.start', { name: server.name, error: said || message })
}

function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
    .slice(-400)
}

/**
 * La commande d'un serveur local existe-t-elle ? Cherchée comme Windows le ferait (PATH, puis extensions de PATHEXT :
 * `npx` → `npx.cmd`). Vérifiée AVANT le lancement : sans ça, Windows lançait l'interpréteur de commandes, qui
 * répondait « n'est pas reconnu… » au lieu de dire quoi installer.
 */
export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  const candidates = (base: string): string[] => extensions.flatMap((ext) => [base + ext, base + ext.toLowerCase()])
  if (isAbsolute(command) || /[\\/]/.test(command)) return candidates(command).some((file) => existsSync(file))
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  return dirs.some((dir) => candidates(join(dir, command)).some((file) => existsSync(file)))
}

/**
 * Étape 419 : un serveur en ligne SANS clé collée (aucun en-tête `Authorization`) se connecte avec le compte de Léo
 * (OAuth, mcpAuth.ts) quand il le demande.
 */
export function usesAccountSignIn(server: McpServerConfig): boolean {
  return server.transport.kind === 'http' && !Object.keys(server.transport.headers).some((name) => name.toLowerCase() === 'authorization')
}

const isUnauthorized = (err: unknown): boolean => err instanceof UnauthorizedError || (err as { name?: string } | null)?.name === 'UnauthorizedError'

function makeTransport(server: McpServerConfig, connection: Connection, legacySse = false, authProvider?: OAuthClientProvider): Transport {
  const transport = server.transport
  if (transport.kind === 'http') {
    const init = { requestInit: { headers: transport.headers }, ...(authProvider ? { authProvider } : {}) }
    return legacySse ? new SSEClientTransport(new URL(transport.url), init) : new StreamableHTTPClientTransport(new URL(transport.url), init)
  }
  const stdio = new StdioClientTransport({ command: transport.command, args: transport.args, env: transport.env, stderr: 'pipe' })
  stdio.stderr?.on('data', (chunk: Buffer | string) => {
    connection.stderr = (connection.stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS)
  })
  return stdio
}

async function connect(server: McpServerConfig): Promise<void> {
  const previous = connections.get(server.id)
  if (previous) await closeConnection(previous)
  const connection: Connection = {
    config: server,
    status: 'connecting',
    error: null,
    client: null,
    tools: [],
    stderr: '',
    generation: (previous?.generation ?? 0) + 1
  }
  connections.set(server.id, connection)
  changed()
  const generation = connection.generation
  const current = (): boolean => connections.get(server.id) === connection && connection.generation === generation
  const attempt = async (legacySse: boolean): Promise<Client> => {
    if (server.transport.kind === 'stdio' && !commandExists(server.transport.command)) {
      throw Object.assign(new Error(`spawn ${server.transport.command} ENOENT`), { code: 'ENOENT' })
    }
    // En arrière-plan, jamais de page de connexion ouverte : seulement les clés déjà reçues (renouvelées au besoin).
    const provider = usesAccountSignIn(server) ? await mcpAuthProvider(server.id, null) : undefined
    const client = new Client({ name: 'jaris', version: '1' })
    await client.connect(makeTransport(server, connection, legacySse, provider), { timeout: CONNECT_TIMEOUT_MS })
    return client
  }
  try {
    let client: Client
    try {
      client = await attempt(false)
    } catch (err) {
      // Un ancien serveur par adresse ne parle que SSE : un deuxième essai avant d'abandonner (jamais quand il demande
      // simplement à Léo de se connecter).
      if (server.transport.kind !== 'http' || !current() || isUnauthorized(err)) throw err
      client = await attempt(true)
    }
    if (!current()) {
      await client.close().catch(() => {})
      return
    }
    connection.client = client
    client.onclose = () => {
      if (!current() || connection.status === 'off') return
      connection.client = null
      connection.status = 'error'
      const said = lastLines(connection.stderr)
      connection.error = said ? t('mcp.error.stoppedSaid', { name: server.name, detail: said }) : t('mcp.error.stopped', { name: server.name })
      changed()
    }
    connection.tools = await listAllTools(client)
    if (!current()) return
    connection.status = 'ready'
    connection.error = null
    changed()
  } catch (err) {
    if (!current()) return
    connection.client = null
    if (isUnauthorized(err) && usesAccountSignIn(server)) {
      // Pas encore connecté avec le compte de Léo (ou la connexion a expiré) : « À connecter », sans erreur.
      connection.status = 'signin'
      connection.error = null
    } else {
      connection.status = 'error'
      connection.error = startFailure(server, err, connection.stderr)
    }
    changed()
  }
}

const signIns = new Map<string, { controller: AbortController; cancelled: boolean }>()

/**
 * Étape 419 : « Se connecter » — la page de connexion du service s'ouvre dans le navigateur de Léo ; à son retour,
 * Jaris échange le code contre une clé (gardée chiffrée), puis se connecte au serveur. Renvoie tout de suite : l'état
 * « Connexion dans ton navigateur… » puis « Connecté » arrive par l'évènement de changement.
 */
export async function signInMcpServer(id: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const server = findServer(id)
  if (!usesAccountSignIn(server)) throw new Error(t('mcp.error.unknownServer'))
  let target = server
  if (!server.enabled) {
    target = { ...server, enabled: true }
    config = { servers: config.servers.map((entry) => (entry === server ? target : entry)) }
    await save()
  }
  void runSignIn(target, true)
  return config.servers.map(view)
}

/** « Annuler » pendant la connexion dans le navigateur. */
export async function cancelMcpSignIn(id: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const running = signIns.get(findServer(id).id)
  if (running) {
    running.cancelled = true
    running.controller.abort()
  }
  return config.servers.map(view)
}

async function runSignIn(server: McpServerConfig, retryPort: boolean): Promise<void> {
  if (server.transport.kind !== 'http') return
  signIns.get(server.id)?.controller.abort()
  const run = { controller: new AbortController(), cancelled: false }
  signIns.set(server.id, run)
  const timer = setTimeout(() => run.controller.abort(), SIGNIN_TIMEOUT_MS)
  const previous = connections.get(server.id)
  if (previous) await closeConnection(previous)
  const connection: Connection = { config: server, status: 'authorizing', error: null, client: null, tools: [], stderr: '', generation: (previous?.generation ?? 0) + 1 }
  connections.set(server.id, connection)
  changed()
  const mine = (): boolean => connections.get(server.id) === connection
  try {
    const state = randomUUID()
    const port = await mcpAuthPort(server.id)
    const { code } = await listenForMcpCallback(port, state, server.name, run.controller.signal)
    code.catch(() => {})
    const provider = await mcpAuthProvider(server.id, { open: true, state })
    const transport = new StreamableHTTPClientTransport(new URL(server.transport.url), { requestInit: { headers: server.transport.headers }, authProvider: provider })
    const client = new Client({ name: 'jaris', version: '1' })
    try {
      // Déjà connecté (clé encore valable) : rien à demander.
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      await client.close().catch(() => {})
      run.controller.abort()
    } catch (err) {
      if (!isUnauthorized(err)) throw err
      await transport.finishAuth(await code)
    }
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'EADDRINUSE' && retryPort) {
      // Le port inscrit est pris par un autre programme : un autre port, une nouvelle inscription, une seule fois.
      clearTimeout(timer)
      await resetMcpAuthPort(server.id)
      if (signIns.get(server.id) === run) signIns.delete(server.id)
      return runSignIn(server, false)
    }
    if (!mine()) return
    if (run.cancelled) {
      connection.status = 'signin'
      connection.error = null
    } else {
      connection.status = 'error'
      const message = err instanceof Error ? err.message : String(err)
      connection.error = err instanceof McpSignInError ? message : t('mcp.error.signinFailed', { error: message })
    }
    changed()
    return
  } finally {
    clearTimeout(timer)
    // L'adresse de retour locale se ferme dans TOUS les cas (réussite, échec, annulation).
    run.controller.abort()
    if (signIns.get(server.id) === run) signIns.delete(server.id)
  }
  if (mine()) await connect(server)
}

async function listAllTools(client: Client): Promise<ServerTool[]> {
  const tools: ServerTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
    for (const tool of result.tools) {
      tools.push({
        name: tool.name,
        description: (tool.description ?? tool.title ?? '').trim(),
        inputSchema: toolSchema(tool.inputSchema),
        readOnly: tool.annotations?.readOnlyHint === true
      })
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  return tools
}

/** Le schéma des paramètres tel qu'Ollama l'accepte : toujours un objet, sans `$schema`. */
export function toolSchema(schema: unknown): Record<string, unknown> {
  const value = typeof schema === 'object' && schema !== null ? { ...(schema as Record<string, unknown>) } : {}
  delete value.$schema
  return { ...value, type: 'object', properties: typeof value.properties === 'object' && value.properties !== null ? value.properties : {} }
}

function view(server: McpServerConfig): McpServerView {
  const connection = connections.get(server.id)
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    status: server.enabled ? (connection?.status ?? 'connecting') : 'off',
    error: server.enabled ? (connection?.error ?? null) : null,
    summary: transportSummary(server.transport),
    secretNames: secretNames(server.transport),
    kind: server.transport.kind === 'http' ? 'online' : 'local',
    catalogId: server.catalogId ?? null,
    tools: (connection?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: !server.disabledTools.includes(tool.name),
      readOnly: tool.readOnly
    }))
  }
}

/** Les serveurs, pour les Options. */
export async function listMcpServers(): Promise<McpServerView[]> {
  await loadOnce()
  return config.servers.map(view)
}

/**
 * Ajoute ce que Léo a collé (configuration JSON d'une page de serveur, ligne de commande ou adresse) et branche les
 * serveurs tout de suite. Un nom déjà pris reçoit un numéro (« github 2 ») : rien n'est jamais remplacé en silence.
 */
export async function addMcpServers(pasted: unknown, name: unknown): Promise<McpServerView[]> {
  await loadOnce()
  if (typeof pasted !== 'string' || pasted.length > 100_000) throw new Error(t('mcp.error.nothing'))
  const chosen = typeof name === 'string' ? cleanServerName(name) : ''
  const parsed = parseMcpPaste(pasted, chosen)
  if (!parsed.length) throw new Error(t('mcp.error.nothing'))
  // Un nom tapé par Léo l'emporte sur celui du bloc collé (un seul serveur : sans ambiguïté).
  const drafts = chosen && parsed.length === 1 ? [{ ...parsed[0], name: chosen }] : parsed
  return addServers(drafts)
}

async function addServers(drafts: readonly { name: string; transport: McpServerConfig['transport']; catalogId?: string }[], connectNow = true): Promise<McpServerView[]> {
  const taken = new Set(config.servers.map((server) => server.name.toLowerCase()))
  const added: McpServerConfig[] = []
  for (const draft of drafts) {
    const base = cleanServerName(draft.name) || 'MCP'
    let unique = base
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${base} ${n}`
    taken.add(unique.toLowerCase())
    added.push({ id: randomUUID(), name: unique, enabled: true, disabledTools: [], transport: draft.transport, ...(draft.catalogId ? { catalogId: draft.catalogId } : {}) })
  }
  config = { servers: [...config.servers, ...added] }
  await save()
  if (connectNow) for (const server of added) void connect(server)
  changed()
  return config.servers.map(view)
}

/**
 * Étape 419 : un service de « Découvrir ». L'adresse vient du catalogue (shared/mcpCatalog.ts), jamais de l'écran ;
 * la connexion avec le compte de Léo démarre tout de suite (la page s'ouvre dans son navigateur).
 */
export async function addCatalogServer(id: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const entry = catalogEntry(id)
  if (!entry) throw new Error(t('mcp.error.unknownServer'))
  const views = await addServers([{ name: entry.name, transport: catalogTransport(entry), catalogId: entry.id }], false)
  const added = config.servers[config.servers.length - 1]
  void runSignIn(added, true)
  return views
}

function findServer(id: unknown): McpServerConfig {
  const server = config.servers.find((entry) => entry.id === id)
  if (!server) throw new Error(t('mcp.error.unknownServer'))
  return server
}

export async function removeMcpServer(id: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const server = findServer(id)
  config = { servers: config.servers.filter((entry) => entry !== server) }
  await save()
  const connection = connections.get(server.id)
  connections.delete(server.id)
  signIns.get(server.id)?.controller.abort()
  if (connection) await closeConnection(connection)
  // Ce que Jaris avait reçu de ce service (sa clé) est effacé avec lui.
  await forgetMcpAuth(server.id)
  changed()
  return config.servers.map(view)
}

export async function setMcpServerEnabled(id: unknown, enabled: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const server = findServer(id)
  const next = { ...server, enabled: enabled === true }
  config = { servers: config.servers.map((entry) => (entry === server ? next : entry)) }
  await save()
  const connection = connections.get(server.id)
  if (next.enabled) void connect(next)
  else if (connection) {
    connection.status = 'off'
    connections.delete(server.id)
    await closeConnection(connection)
  }
  changed()
  return config.servers.map(view)
}

export async function setMcpToolEnabled(id: unknown, tool: unknown, enabled: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const server = findServer(id)
  if (typeof tool !== 'string' || !tool) throw new Error(t('mcp.error.unknownServer'))
  const others = server.disabledTools.filter((name) => name !== tool)
  const next = { ...server, disabledTools: enabled === true ? others : [...others, tool] }
  config = { servers: config.servers.map((entry) => (entry === server ? next : entry)) }
  const connection = connections.get(server.id)
  if (connection) connection.config = next
  await save()
  changed()
  return config.servers.map(view)
}

/** « Relancer » : utile après avoir installé Node.js ou corrigé une clé. */
export async function restartMcpServer(id: unknown): Promise<McpServerView[]> {
  await loadOnce()
  const server = findServer(id)
  if (server.enabled) await connect(server).catch(() => {})
  return config.servers.map(view)
}

/** Une attente interrompue tout de suite par « Arrêter » ou une nouvelle phrase. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}

/** Un échec que le serveur a lui-même signalé (`isError`) : son message part tel quel, sans être réemballé. */
class McpToolError extends Error {}

interface OfferedTool extends McpToolCandidate {
  serverId: string
  tool: ServerTool
}

/** Les outils des serveurs connectés et non décochés, avec leur nom pour le modèle. */
function availableTools(): OfferedTool[] {
  const taken = new Set<string>()
  const out: OfferedTool[] = []
  for (const server of config.servers) {
    const connection = connections.get(server.id)
    if (!server.enabled || connection?.status !== 'ready') continue
    for (const tool of connection.tools) {
      if (server.disabledTools.includes(tool.name)) continue
      const name = mcpToolName(server.name, tool.name, taken)
      taken.add(name)
      out.push({
        name,
        serverName: server.name,
        toolName: tool.name,
        description: tool.description,
        required: Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as string[]) : [],
        serverId: server.id,
        tool
      })
    }
  }
  return out
}

/**
 * Ce qu'assistant.ts reçoit (setExtraToolSource) : les outils MCP utiles à UNE demande (au plus
 * MCP_MAX_TOOLS_PER_REQUEST, shared/mcp.ts), et leur exécution. Seuls les outils proposés pour cette demande peuvent
 * être appelés : un modèle peut inventer un nom d'outil qu'on ne lui a pas donné.
 */
export function mcpToolsFor(prompt: string): {
  tools: OllamaTool[]
  call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>
  named: string[]
  unavailable?: string
} {
  // Étape 421 (Léo, « fais-moi un design sur Canva » → Jaris pilotait l'écran, Gmail devant) : un serveur NOMMÉ dans la
  // demande et prêt reçoit seul les places d'outils ; nommé mais pas prêt, la demande dit pourquoi au lieu de laisser
  // le modèle se rabattre sur l'écran.
  const named = config.servers.filter((server) => server.enabled && isServerNamed(prompt, server.name))
  const ready = named.filter((server) => connections.get(server.id)?.status === 'ready')
  const all = availableTools()
  const readyIds = new Set(ready.map((server) => server.id))
  const pool = ready.length ? all.filter((tool) => readyIds.has(tool.serverId)) : all
  const offered = pickMcpTools(prompt, pool)
  const byName = new Map(offered.map((tool) => [tool.name, tool]))
  return {
    tools: offered.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: `[MCP ${tool.serverName}] ${tool.description || tool.toolName}`.slice(0, 1024),
        parameters: tool.tool.inputSchema as OllamaTool['function']['parameters']
      }
    })),
    call: async (name, args, signal) => {
      const tool = byName.get(name)
      if (!tool) throw new Error(t('mcp.error.unknownTool', { tool: name }))
      return callTool(tool, args, signal)
    },
    named: ready.map((server) => server.name),
    unavailable: ready.length || !named.length ? undefined : unavailableReason(named[0])
  }
}

/** Pourquoi un serveur nommé dans la demande ne peut pas servir maintenant, dit à Léo avec ce qu'il peut faire. */
function unavailableReason(server: McpServerConfig): string {
  const connection = connections.get(server.id)
  if (connection?.status === 'signin') return t('mcp.reply.signin', { name: server.name, options: t('options.title'), tab: t('options.tab.mcp'), button: t('mcp.server.signin') })
  if (connection?.status === 'error') return t('mcp.error.notReady', { name: server.name, error: connection.error ?? t('mcp.status.error') })
  return t('mcp.reply.connecting', { name: server.name })
}

async function callTool(tool: OfferedTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const connection = connections.get(tool.serverId)
  const client = connection?.client
  if (!connection || connection.status !== 'ready' || !client) {
    throw new Error(t('mcp.error.notReady', { name: tool.serverName, error: connection?.error ?? t('mcp.status.connecting') }))
  }
  try {
    const result = await client.callTool({ name: tool.toolName, arguments: args }, undefined, {
      signal,
      timeout: TOOL_IDLE_TIMEOUT_MS,
      resetTimeoutOnProgress: true
    })
    const text = mcpResultText(result.content as McpContentPart[] | undefined, result.structuredContent)
    // Étape 420 : le serveur demande d'attendre avant de redemander (travail en cours) — Jaris attend ici, plutôt que
    // de laisser le modèle redemander aussitôt et épuiser ses actions sur un travail pas encore fini.
    const wait = result.isError ? 0 : serverRequestedWaitMs(result.content as McpContentPart[] | undefined, result.structuredContent)
    if (wait > 0) await pause(wait, signal)
    if (result.isError) throw new McpToolError(t('mcp.error.toolFailed', { tool: tool.toolName, name: tool.serverName, error: text || '?' }))
    return text || t('mcp.result.empty', { tool: tool.toolName })
  } catch (err) {
    if (signal?.aborted || err instanceof McpToolError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/timed out|timeout/i.test(message)) {
      throw new Error(t('mcp.error.timeout', { tool: tool.toolName, name: tool.serverName, seconds: Math.round(TOOL_IDLE_TIMEOUT_MS / 1000) }))
    }
    throw new Error(t('mcp.error.toolFailed', { tool: tool.toolName, name: tool.serverName, error: message }))
  }
}
