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

/** Ce qui remplace une clé dans ce que les Options affichent. */
export const HIDDEN_SECRET = '•••'

/**
 * Un morceau d'adresse ou de commande qui ressemble à une clé : un préfixe de clé connu (« sk- », « ghp_ », « xoxb- »…),
 * ou une longue suite sans espace mêlant lettres et chiffres (« /mcp/a1B2c3D4e5F6g7H8i9/sse », un identifiant secret).
 * Un mot ordinaire (« server-filesystem », « mcp ») n'en est pas une.
 */
export function looksLikeSecret(text: string): boolean {
  if (text.length >= 12 && /^(?:sk|pk|rk)[-_]|^(?:ghp|gho|ghs|ghu|ghr|github_pat)_|^xox[abposr]-|^AKIA|^AIza|^ya29\.|^eyJ[\w-]+\./.test(text)) return true
  if (text.length < 20 || !/^[\w.~+/=-]+$/.test(text)) return false
  return (text.match(/\d/g) ?? []).length >= 2 && (text.match(/[a-z]/gi) ?? []).length >= 2
}

/** Une option de commande qui annonce une clé : sa valeur (l'argument suivant, ou après « = ») est masquée. */
const SECRET_FLAG = /^--?(?:[\w-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|auth)[\w-]*|key)$/i

function maskUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return looksLikeSecret(raw) ? HIDDEN_SECRET : raw.replace(/\?.*$/s, `?${HIDDEN_SECRET}`)
  }
  const decode = (segment: string): string => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (looksLikeSecret(decode(segment)) ? HIDDEN_SECRET : segment))
    .join('/')
  const user = url.username || url.password ? `${HIDDEN_SECRET}@` : ''
  return `${url.protocol}//${user}${url.host}${path}${url.search ? `?${HIDDEN_SECRET}` : ''}${url.hash ? `#${HIDDEN_SECRET}` : ''}`
}

function maskArgs(words: readonly string[]): string[] {
  return words.map((word, index) => {
    const flag = /^(--?[\w-]+)=(.+)$/s.exec(word)
    if (flag && (SECRET_FLAG.test(flag[1]) || looksLikeSecret(flag[2]))) return `${flag[1]}=${HIDDEN_SECRET}`
    if (index > 0 && SECRET_FLAG.test(words[index - 1]) && !word.startsWith('-')) return HIDDEN_SECRET
    if (/^https?:\/\//i.test(word)) return maskUrl(word)
    // Mot par mot : « Authorization: Bearer sk-… » (option --header de mcp-remote) garde son nom, pas sa clé.
    return word.replace(/[^\s"',;]+/g, (part) => (looksLikeSecret(part) ? HIDDEN_SECRET : part))
  })
}

/**
 * Ce que les Options affichent d'un serveur : sa commande ou son adresse. Relecture croisée : l'adresse s'affichait EN
 * ENTIER, clé comprise (« ?api_key=… », « /mcp/sk-…/sse ») ; une capture d'écran envoyée pour de l'aide la donnait à
 * tout le monde. La requête, ce qui ressemble à une clé et la valeur d'une option « --token » sont masqués.
 */
export function transportSummary(transport: McpTransportConfig): string {
  return transport.kind === 'http' ? maskUrl(transport.url) : joinCommandLine([transport.command, ...maskArgs(transport.args)])
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
  /** Étape 421 : les paramètres obligatoires de l'outil (`inputSchema.required`). */
  required?: readonly string[]
}

/**
 * Étape 421 : un outil qui ne peut pas être le PREMIER pas d'une demande — il exige l'identifiant d'une chose déjà
 * obtenue (`design_id`, `job_id`, `transaction_id`, `jobId`, `asset_ids`…). Patron des noms de paramètres, jamais une
 * liste d'outils.
 */
export function needsPriorId(required: readonly string[] | undefined): boolean {
  return (required ?? []).some((param) => /(?:^|_)ids?$|[a-z]Ids?$/.test(param))
}

/**
 * Étape 421 : le texte contient-il un identifiant à réutiliser (« DAGk3x9LmQ2 », « JOB42abc », un UUID) ? Un mot de 8
 * signes et plus, avec chiffres ET lettres, ET majuscules mélangées aux minuscules, ou un « _ », ou la forme d'un UUID —
 * jamais une dimension ni une date (« 210x297mm », « 1080x1920 », « 14-juillet-2026 », revue de l'étape 423).
 */
export function hasIdLikeToken(text: string): boolean {
  for (const token of text.match(/[A-Za-z0-9_-]{8,}/g) ?? []) {
    if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) continue
    if ((/[a-z]/.test(token) && /[A-Z]/.test(token)) || token.includes('_') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token)) return true
  }
  return false
}

/** Étape 420 : outils ajoutés en plus de `max` parce qu'un outil choisi les nomme (voir pickMcpTools). */
export const MCP_COMPANION_TOOLS_MAX = 4

/**
 * Étape 420 : un outil que son serveur dit ancien ou à éviter (« LEGACY-ONLY — DO NOT CALL WHEN create-design IS
 * AVAILABLE », « deprecated »…). Détecté par le PATRON, jamais par le nom d'un serveur.
 */
export function isLegacyTool(description: string): boolean {
  return /\b(legacy|deprecated|obsolete)\b/i.test(description) || /\bdo not (call|use)\b[^.\n]{0,40}\bwhen\b/i.test(description)
}

/**
 * Étape 421 : l'outil qui remplace un outil ancien, quand sa description le nomme (« DO NOT CALL WHEN create-design IS
 * AVAILABLE »). Si ce remplaçant n'est PAS proposé par le serveur (Canva ne donne pas `create-design` à Jaris), l'outil
 * ancien redevient le bon : le serveur le dit lui-même (« All instructions below apply when create-design is absent »).
 */
export function legacyReplacement(description: string): string | null {
  const match = /\bdo not (?:call|use)\b[^.\n]{0,40}?\bwhen\s+[`'"]?([A-Za-z0-9_.-]+?)[`'"]?\s+is\s+(?:available|present|listed|in the tool list)\b/i.exec(description)
  return match ? match[1] : null
}

/** Un nom d'outil cité tel quel dans un texte (`create-design` ne compte pas dans `create-design-from-candidate`). */
/** Les mots ENTIERS d'un texte, sans accents ni majuscules (« GitHub » reste « github », jamais « git » + « hub »). */
function plainTokens(text: string): string[] {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

// Ce qui, juste avant le nom, en fait la CIBLE de la demande (« sur Canva », « avec Notion », « utilise Canva »…).
const SERVICE_TARGET_BEFORE = new Set([
  'sur', 'avec', 'dans', 'via', 'depuis', 'vers', 'utilise', 'utiliser', 'utilises', 'ouvre', 'mcp', 'compte', 'mon', 'ma',
  'mes', 'ton', 'ta', 'tes', 'on', 'with', 'in', 'using', 'use', 'my', 'into'
])
// « le mcp de Canva », « mon compte de Notion »
const SERVICE_NOUNS = new Set(['mcp', 'compte', 'serveur', 'outil', 'outils', 'connecteur', 'account', 'server'])
const GENERIC_NAME_WORDS = new Set(['mcp', 'com', 'www', 'org', 'net', 'app', 'api', 'dev', 'server', 'serveur', 'http', 'https'])
const NEGATIONS = new Set(['pas', 'jamais', 'sans', 'ni', 'not', 'never', 'without', 'no', 'dont'])

/**
 * Étape 421, resserré à l'étape 423 (revue : « explique-moi la NOTION de dérivée » visait le serveur Notion, « regarde
 * GitHub » le serveur « git », « n'utilise pas Canva » retirait l'écran) : la demande VISE-t-elle ce serveur ? Son nom
 * en mots entiers, juste après un mot qui le désigne comme cible (« sur », « avec », « dans », « utilise », « mon »,
 * « le mcp de »…) ou juste avant « mcp », et sans négation dans les quatre mots qui précèdent. Un simple « Canva c'est
 * quoi ? » ne compte pas : seulement une demande qui s'en sert.
 */
export function isServerTargeted(prompt: string, serverName: string): boolean {
  // « mcp.canva.com », « Canva MCP » : les mots génériques d'une adresse ou d'un nom de serveur ne sont pas le nom.
  const all = plainTokens(serverName).filter((word) => word.length >= 3)
  const specific = all.filter((word) => !GENERIC_NAME_WORDS.has(word))
  const name = specific.length ? specific : all
  if (!name.length) return false
  const tokens = plainTokens(prompt)
  for (let i = 0; i + name.length <= tokens.length; i++) {
    if (!name.every((word, k) => tokens[i + k] === word)) continue
    const before = tokens[i - 1]
    const targeted =
      (before !== undefined && SERVICE_TARGET_BEFORE.has(before)) ||
      ((before === 'de' || before === 'du' || before === 'd' || before === 'of') && SERVICE_NOUNS.has(tokens[i - 2] ?? '')) ||
      tokens[i + name.length] === 'mcp'
    const negated = tokens.slice(Math.max(0, i - 4), i).some((word) => NEGATIONS.has(word))
    if (targeted && !negated) return true
  }
  return false
}

function mentions(text: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(text)
}

/**
 * Les outils MCP proposés pour UNE demande. Tant qu'il y en a peu (au plus `max`), tous. Au-delà, ceux dont le nom, la
 * description ou le nom du serveur partagent le plus de mots avec la demande, puis les autres dans l'ordre (un petit
 * modèle reçoit au plus `max` outils de plus que les siens). Les descriptions des serveurs sont souvent en anglais :
 * une demande en français peut ne partager aucun mot — l'ordre des serveurs départage alors.
 *
 * Étape 420 (Léo : « il a commencé, mais il ne fait même pas sur mon compte Canva, il me demande d'ouvrir des liens ») :
 * Canva a ~45 outils ; le modèle avait reçu l'ANCIEN `generate-design` (des propositions à choisir) sans l'outil qui
 * met la proposition dans le compte. Deux règles générales :
 * - un outil que son serveur dit ancien ou à éviter passe après les autres (`isLegacyTool`) ;
 * - un outil choisi qui en NOMME un autre du même serveur dans sa description (« use create-design-from-candidate »,
 *   « poll get-create-design-async-job ») l'emmène avec lui, au plus MCP_COMPANION_TOOLS_MAX en plus : sans lui, le
 *   modèle ne peut pas finir ce que le premier commence.
 */
export function pickMcpTools<T extends McpToolCandidate>(prompt: string, tools: readonly T[], max = MCP_MAX_TOOLS_PER_REQUEST): T[] {
  if (tools.length <= max) return [...tools]
  const asked = new Set(words(prompt))
  const idInPrompt = hasIdLikeToken(prompt)
  // Étape 421 : un outil ancien ne passe après les autres que si son remplaçant nommé est là (même serveur).
  const demoted = (tool: T): boolean => {
    if (!isLegacyTool(tool.description)) return false
    const replacement = legacyReplacement(tool.description)
    return !replacement || tools.some((other) => other.serverName === tool.serverName && other.toolName.toLowerCase() === replacement.toLowerCase())
  }
  const score = (tool: T): number => {
    const server = words(tool.serverName).filter((word) => asked.has(word)).length
    const own = new Set([...words(tool.toolName), ...words(tool.description)])
    let shared = 0
    for (const word of own) if (asked.has(word)) shared++
    // Un serveur nommé dans la demande (« sur GitHub ») compte plus qu'un mot commun ; un outil ancien, moins.
    // Étape 421 : sans identifiant dans la demande, un outil qui en exige un passe après ceux qui peuvent commencer
    // (une demande en français partage peu de mots avec des descriptions en anglais : sans ça, l'ordre du serveur
    // décidait, et Canva donnait 12 outils pour modifier un design existant, aucun pour en créer un).
    return server * 3 + shared - (demoted(tool) ? 2 : 0) - (!idInPrompt && needsPriorId(tool.required) ? 2 : 0)
  }
  const ranked = tools.map((tool, index) => ({ tool, index, score: score(tool) })).sort((a, b) => b.score - a.score || a.index - b.index)
  const chosen = new Set(ranked.slice(0, max).map((entry) => entry.index))
  let extra = 0
  for (const entry of ranked.slice(0, max)) {
    for (let index = 0; index < tools.length && extra < MCP_COMPANION_TOOLS_MAX; index++) {
      const other = tools[index]
      if (chosen.has(index) || other.serverName !== entry.tool.serverName || !mentions(entry.tool.description, other.toolName)) continue
      chosen.add(index)
      extra++
    }
  }
  return tools.filter((_, index) => chosen.has(index))
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

/** Étape 420 : la plus longue attente demandée par un serveur que Jaris respecte (au-delà, il rend la main au modèle). */
export const MCP_MAX_SERVER_WAIT_MS = 60_000

/**
 * Étape 420 : un serveur qui dit « reviens dans N secondes » (Canva : `polling_policy.wait_seconds` du travail en
 * cours de `create-design`). Cherché dans les données structurées et dans un texte JSON, par le NOM du champ
 * (`wait_seconds`, `retry_after_seconds`, `retry_after`). Sans demande, ou au-delà d'une minute : 0.
 */
export function serverRequestedWaitMs(content: readonly McpContentPart[] | undefined, structured: unknown): number {
  const found: number[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(wait_seconds|retry_after_seconds|retry_after)$/i.test(key) && typeof entry === 'number' && Number.isFinite(entry) && entry > 0) found.push(entry)
      else visit(entry, depth + 1)
    }
  }
  visit(structured, 0)
  for (const part of content ?? []) {
    if (part.type !== 'text' || !part.text || !/wait_seconds|retry_after/i.test(part.text)) continue
    try {
      visit(JSON.parse(part.text), 0)
    } catch {
      const match = part.text.match(/"?(?:wait_seconds|retry_after_seconds)"?\s*[:=]\s*(\d+(?:\.\d+)?)/i)
      if (match) found.push(Number(match[1]))
    }
  }
  if (!found.length) return 0
  const ms = Math.max(...found) * 1000
  return ms <= MCP_MAX_SERVER_WAIT_MS ? Math.round(ms) : 0
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
