/**
 * Étape 418 (Léo : « on peut ajouter les MCP dans Jaris ? … oui fais-le ») : Jaris branche des serveurs MCP (Model
 * Context Protocol) et donne leurs outils au modèle du Chat et du Vocal, à côté des siens.
 *
 * Module pur (aucun accès au disque, au réseau ni à Electron) : formats de configuration, noms d'outils donnés au
 * modèle, choix des outils utiles à une demande. Partagé par le main (mcpHub.ts) et l'écran (Options), testé seul.
 */

/** Un serveur lancé sur ce PC (le cas le plus courant : `npx -y …`, `uvx …`, un .exe). */
export interface McpStdioConfig {
  kind: 'stdio'
  command: string
  args: string[]
  /** Variables d'environnement propres au serveur (clé d'API…), ajoutées à celles de Windows. */
  env: Record<string, string>
}

/** Un serveur joint par une adresse (HTTP « streamable », ou SSE pour les anciens). */
export interface McpHttpConfig {
  kind: 'http'
  url: string
  headers: Record<string, string>
}

export type McpTransportConfig = McpStdioConfig | McpHttpConfig

export interface McpServerConfig {
  id: string
  /** Le nom choisi par Léo (« github », « fichiers »…) : montré dans les Options, et préfixe des outils. */
  name: string
  enabled: boolean
  /** Outils que Léo a décochés : jamais donnés au modèle. */
  disabledTools: string[]
  transport: McpTransportConfig
  /** Étape 419 : ajouté depuis « Découvrir » (son icône, et « Ajouté » dans le catalogue). */
  catalogId?: string
}

export interface McpConfigFile {
  servers: McpServerConfig[]
}

/** Un outil d'un serveur, tel que l'écran le montre. */
export interface McpToolView {
  name: string
  description: string
  enabled: boolean
  /** Le serveur dit lui-même que l'outil ne fait que lire (annotations MCP `readOnlyHint`). */
  readOnly: boolean
}

/** Étape 419 : `signin` = à connecter avec le compte de Léo ; `authorizing` = connexion en cours dans son navigateur. */
export type McpServerStatus = 'off' | 'connecting' | 'ready' | 'error' | 'signin' | 'authorizing'

/** Ce que l'écran reçoit d'un serveur. Jamais les valeurs des variables d'environnement ni des en-têtes (secrets). */
export interface McpServerView {
  id: string
  name: string
  enabled: boolean
  status: McpServerStatus
  /** Message lisible quand `status` vaut `error`. */
  error: string | null
  /** « npx -y @modelcontextprotocol/server-filesystem C:\Users\Léo » ou l'adresse. */
  summary: string
  /** Noms des variables d'environnement / en-têtes définis (sans leurs valeurs). */
  secretNames: string[]
  tools: McpToolView[]
  /** Étape 419 : lancé sur ce PC (`local`) ou joint par une adresse (`online`). */
  kind: 'local' | 'online'
  catalogId: string | null
}

/** Au plus ce nombre d'outils MCP proposés au modèle pour une demande : au-delà, un petit modèle s'y perd. */
export const MCP_MAX_TOOLS_PER_REQUEST = 12
/** Taille maximale d'un résultat d'outil MCP renvoyé au modèle (le reste est coupé, et c'est dit). */
export const MCP_RESULT_MAX_CHARS = 20000
/** Préfixe des outils MCP dans la liste donnée au modèle : jamais confondus avec ceux de Jaris. */
export const MCP_TOOL_PREFIX = 'mcp_'
/** Nom d'un outil pour Ollama : lettres, chiffres, `_` et `-`, 64 caractères au plus. */
export const MCP_TOOL_NAME_MAX = 64

/**
 * Découpe une ligne de commande en mots, sans jamais passer par un shell : espaces comme séparateurs, guillemets
 * (simples ou doubles) pour garder des espaces. La barre oblique inverse reste telle quelle (chemins Windows).
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) words.push(current)
  return words
}

/** Ce qu'une ligne de commande affiche (guillemets seulement autour des mots qui ont des espaces). */
export function joinCommandLine(words: readonly string[]): string {
  return words.map((word) => (/\s/.test(word) || word === '' ? `"${word}"` : word)).join(' ')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() && (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')) out[key.trim()] = String(entry)
  }
  return out
}

/** Une configuration de transport lue dans un objet JSON (format de Claude Desktop, VS Code, Cursor…), ou `null`. */
export function transportFromJson(value: unknown): McpTransportConfig | null {
  if (!isRecord(value)) return null
  const url = typeof value.url === 'string' ? value.url : typeof value.serverUrl === 'string' ? value.serverUrl : null
  if (url !== null) {
    const clean = url.trim()
    return isHttpUrl(clean) ? { kind: 'http', url: clean, headers: stringRecord(value.headers) } : null
  }
  if (typeof value.command !== 'string' || !value.command.trim()) return null
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string | number => typeof arg === 'string' || typeof arg === 'number').map(String) : []
  // « "command": "npx -y paquet" » sans « args » : la commande est découpée comme une ligne de commande.
  const words = args.length ? [value.command.trim()] : splitCommandLine(value.command)
  return { kind: 'stdio', command: words[0], args: [...words.slice(1), ...args], env: stringRecord(value.env) }
}

export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Un serveur à ajouter, tel que l'écran l'envoie au main (le main revérifie tout). */
export interface McpServerDraft {
  name: string
  transport: McpTransportConfig
}

/**
 * Ce que Léo colle dans « Ajouter un serveur MCP » : ce que donne la page d'un serveur, le plus souvent un bloc JSON
 * `{"mcpServers": {"nom": {"command": …, "args": […], "env": {…}}}}` (Claude Desktop, Cursor), `{"servers": {…}}`
 * (VS Code), un seul serveur `{"command": …}`, une ligne de commande (`npx -y …`) ou une adresse (`https://…`).
 * `fallbackName` sert quand le texte ne donne pas de nom. Renvoie `[]` si rien n'est reconnu.
 */
export function parseMcpPaste(text: string, fallbackName = ''): McpServerDraft[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    // Un bloc copié sans ses accolades extérieures : « "github": { … } ».
    try {
      json = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`)
    } catch {
      json = undefined
    }
  }
  if (json !== undefined) {
    if (!isRecord(json)) return []
    const single = transportFromJson(json)
    if (single) return [{ name: cleanServerName(typeof json.name === 'string' ? json.name : fallbackName), transport: single }]
    const group = isRecord(json.mcpServers) ? json.mcpServers : isRecord(json.servers) ? json.servers : isRecord(json.mcp) && isRecord(json.mcp.servers) ? json.mcp.servers : json
    const drafts: McpServerDraft[] = []
    for (const [name, entry] of Object.entries(group)) {
      const transport = transportFromJson(entry)
      if (transport) drafts.push({ name: cleanServerName(name), transport })
    }
    return drafts
  }
  if (isHttpUrl(trimmed)) return [{ name: cleanServerName(fallbackName || new URL(trimmed).hostname), transport: { kind: 'http', url: trimmed, headers: {} } }]
  const words = splitCommandLine(trimmed)
  if (!words.length) return []
  return [{ name: cleanServerName(fallbackName || guessServerName(words)), transport: { kind: 'stdio', command: words[0], args: words.slice(1), env: {} } }]
}

/** Un nom lisible deviné d'une commande : le paquet lancé (« @modelcontextprotocol/server-github » → « github »). */
export function guessServerName(words: readonly string[]): string {
  const pkg = words.slice(1).find((word) => !word.startsWith('-')) ?? words[0] ?? ''
  const last = pkg.split(/[\\/]/).pop() ?? pkg
  return last
    .replace(/@[\w.^~-]*$/, '')
    .replace(/\.(exe|cmd|bat|js|mjs|py)$/i, '')
    .replace(/^(mcp-server-|server-|mcp-)/, '')
    .replace(/(-mcp-server|-mcp|-server)$/, '')
}

/** Un nom de serveur propre : sans espaces de bord, 40 caractères au plus. */
export function cleanServerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40)
}

/** Ce que les Options affichent d'un serveur : sa commande ou son adresse. */
export function transportSummary(transport: McpTransportConfig): string {
  return transport.kind === 'http' ? transport.url : joinCommandLine([transport.command, ...transport.args])
}

/** Les noms (jamais les valeurs) des secrets d'un serveur. */
export function secretNames(transport: McpTransportConfig): string[] {
  return Object.keys(transport.kind === 'http' ? transport.headers : transport.env).sort()
}

const slug = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

/**
 * Nom d'un outil MCP pour le modèle : `mcp_<serveur>_<outil>`, propre (Ollama n'accepte que lettres, chiffres, `_`
 * et `-`) et unique parmi `taken` (un numéro est ajouté sinon).
 */
export function mcpToolName(serverName: string, toolName: string, taken: ReadonlySet<string>): string {
  const base = `${MCP_TOOL_PREFIX}${slug(serverName) || 'serveur'}_${slug(toolName) || 'outil'}`.slice(0, MCP_TOOL_NAME_MAX)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const candidate = `${base.slice(0, MCP_TOOL_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Mots d'un texte, sans accents ni majuscules, découpés aussi dans les noms techniques (`list_issues`, `getFile`). Un
 * mot à majuscules internes compte aussi entier : « GitHub » donne « github », « git » et « hub ».
 */
export function words(text: string): string[] {
  const plain = (word: string): string => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const out: string[] = []
  for (const token of text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/)) {
    if (!token) continue
    const parts = token.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
    if (parts.length > 1) out.push(plain(token))
    out.push(...parts.map(plain))
  }
  return out.filter((word) => word.length >= 3)
}

/** Un outil MCP candidat pour une demande. */
export interface McpToolCandidate {
  /** Nom donné au modèle (`mcp_…`). */
  name: string
  serverName: string
  toolName: string
  description: string
}

/**
 * Les outils MCP proposés pour UNE demande. Tant qu'il y en a peu (au plus `max`), tous. Au-delà, ceux dont le nom, la
 * description ou le nom du serveur partagent le plus de mots avec la demande, puis les autres dans l'ordre (un petit
 * modèle reçoit toujours au plus `max` outils de plus que les siens). Les descriptions des serveurs sont souvent en
 * anglais : une demande en français peut ne partager aucun mot — l'ordre des serveurs départage alors.
 */
export function pickMcpTools<T extends McpToolCandidate>(prompt: string, tools: readonly T[], max = MCP_MAX_TOOLS_PER_REQUEST): T[] {
  if (tools.length <= max) return [...tools]
  const asked = new Set(words(prompt))
  const score = (tool: T): number => {
    const server = words(tool.serverName).filter((word) => asked.has(word)).length
    const own = new Set([...words(tool.toolName), ...words(tool.description)])
    let shared = 0
    for (const word of own) if (asked.has(word)) shared++
    // Un serveur nommé dans la demande (« sur GitHub ») compte plus qu'un mot commun.
    return server * 3 + shared
  }
  return tools
    .map((tool, index) => ({ tool, index, score: score(tool) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.tool)
}

/** Une partie d'un résultat d'outil MCP (`content` de `tools/call`). */
export interface McpContentPart {
  type: string
  text?: string
  mimeType?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
  uri?: string
  name?: string
}

/** Le résultat d'un outil MCP en texte pour le modèle, coupé à `max` caractères (et c'est dit). */
export function mcpResultText(content: readonly McpContentPart[] | undefined, structured: unknown, max = MCP_RESULT_MAX_CHARS): string {
  const parts: string[] = []
  for (const part of content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image') parts.push(`[image ${part.mimeType ?? ''}]`.replace(' ]', ']'))
    else if (part.type === 'audio') parts.push(`[audio ${part.mimeType ?? ''}]`.replace(' ]', ']'))
    else if (part.type === 'resource' && part.resource) parts.push(part.resource.text ?? part.resource.uri ?? '')
    else if (part.type === 'resource_link') parts.push(part.uri ? `${part.name ?? ''} ${part.uri}`.trim() : '')
  }
  let text = parts.filter((part) => part.trim()).join('\n\n')
  if (!text.trim() && structured !== undefined && structured !== null) text = JSON.stringify(structured)
  if (text.length > max) return `${text.slice(0, max)}\n[… résultat coupé : ${text.length - max} caractères de plus]`
  return text
}

/** Lecture tolérante du fichier de configuration : un serveur mal formé est ignoré, jamais tout le fichier. */
export function parseMcpConfigFile(value: unknown): McpConfigFile | null {
  if (!isRecord(value) || !Array.isArray(value.servers)) return null
  const servers: McpServerConfig[] = []
  const ids = new Set<string>()
  for (const entry of value.servers) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) continue
    const transport = isRecord(entry.transport) ? readTransport(entry.transport) : null
    if (!transport || typeof entry.name !== 'string') continue
    ids.add(entry.id)
    servers.push({
      id: entry.id,
      name: cleanServerName(entry.name) || 'MCP',
      enabled: entry.enabled !== false,
      disabledTools: Array.isArray(entry.disabledTools) ? entry.disabledTools.filter((name): name is string => typeof name === 'string') : [],
      transport,
      ...(typeof entry.catalogId === 'string' && entry.catalogId ? { catalogId: entry.catalogId } : {})
    })
  }
  return { servers }
}

function readTransport(value: Record<string, unknown>): McpTransportConfig | null {
  if (value.kind === 'http') return typeof value.url === 'string' && isHttpUrl(value.url) ? { kind: 'http', url: value.url, headers: stringRecord(value.headers) } : null
  if (value.kind === 'stdio' && typeof value.command === 'string' && value.command.trim()) {
    return {
      kind: 'stdio',
      command: value.command,
      args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: stringRecord(value.env)
    }
  }
  return null
}
