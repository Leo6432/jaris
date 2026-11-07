import { createServer, type Server } from 'http'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { DataFileUnreadableError, readFileWithRetries, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { t } from '../../shared/i18n'

/**
 * Étape 419 : la connexion PAR COMPTE aux serveurs MCP en ligne (Canva, Notion, Figma… — OAuth 2.1, comme les
 * « Connecteurs » de Claude). Jaris s'inscrit lui-même auprès du serveur (inscription dynamique, vérifiée sur chaque
 * serveur du catalogue), ouvre la page de connexion dans le navigateur de Léo, et reçoit la réponse sur une adresse
 * locale (`http://127.0.0.1:<port>/callback`, jamais ouverte au réseau). PKCE et `state` sont vérifiés.
 *
 * Les clés reçues (jetons) sont chiffrées par Windows (DPAPI via safeStorage, branché par main.ts) dans
 * `mcp-auth/<serveur>.bin`, et ne partent jamais à l'écran. Sans chiffrement possible : en mémoire seulement.
 */

/** Un échec de connexion déjà rédigé pour Léo (délai dépassé, refus du service) : affiché tel quel. */
export class McpSignInError extends Error {}

/** Ce qui est gardé pour un serveur : l'inscription de Jaris, les jetons, et la connexion en cours. */
interface AuthState {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
  port?: number
}

export interface SecretBox {
  /** `null` : chiffrement impossible sur ce PC (rien n'est alors écrit sur le disque). */
  encrypt(text: string): Buffer | null
  decrypt(data: Buffer): string
}

let box: SecretBox | null = null
let opener: (url: string) => void | Promise<void> = () => {}
const memory = new Map<string, AuthState>()

/** main.ts : le chiffrement de Windows. */
export function setMcpSecretBox(next: SecretBox | null): void {
  box = next
}

/** main.ts : ouvrir une adresse dans le navigateur de Léo (les tests la suivent eux-mêmes). */
export function setMcpBrowserOpener(next: (url: string) => void | Promise<void>): void {
  opener = next
}

const authDir = (): string => join(getDataRoot(), 'mcp-auth')
const authFile = (serverId: string): string => join(authDir(), `${serverId.replace(/[^A-Za-z0-9-]/g, '')}.bin`)

/**
 * Ce que Jaris a reçu de ce serveur. Relecture croisée : TOUTE erreur de lecture rendait « rien » et le gardait en
 * mémoire ; la demande suivante (le port de retour, par exemple) réécrivait alors le fichier SANS les clés — un fichier
 * verrouillé un instant par un antivirus suffisait à perdre la connexion. Seul un fichier ABSENT veut dire « rien » ;
 * illisible (verrouillé, indéchiffrable, abîmé) : une erreur rédigée pour Léo, rien gardé en mémoire, rien réécrit.
 */
async function load(serverId: string): Promise<AuthState> {
  const cached = memory.get(serverId)
  if (cached) return cached
  let state: AuthState = {}
  if (box) {
    let raw: string | null
    try {
      raw = await readFileWithRetries(authFile(serverId))
    } catch (err) {
      // « Un autre programme l'utilise, réessaie » est déjà une phrase complète ; une autre panne garde son vrai détail.
      if (err instanceof DataFileUnreadableError) throw new McpSignInError(err.message)
      throw new McpSignInError(t('mcp.error.authUnreadable', { detail: (err as NodeJS.ErrnoException)?.code ?? String((err as Error)?.message ?? err) }))
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(box.decrypt(Buffer.from(raw, 'base64'))) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('format')
        state = parsed as AuthState
      } catch (err) {
        throw new McpSignInError(t('mcp.error.authUnreadable', { detail: err instanceof Error ? err.message : String(err) }))
      }
    }
  }
  // Une lecture partie en même temps a pu remplir la mémoire (et une écriture la changer) : la sienne fait foi.
  const raced = memory.get(serverId)
  if (raced) return raced
  memory.set(serverId, state)
  return state
}

async function save(serverId: string, patch: Partial<AuthState>): Promise<void> {
  const state = { ...(await load(serverId)), ...patch }
  memory.set(serverId, state)
  const encrypted = box?.encrypt(JSON.stringify(state)) ?? null
  if (!encrypted) return
  await mkdir(authDir(), { recursive: true })
  await writeFileAtomic(authFile(serverId), encrypted.toString('base64'))
}

/** « Supprimer » un serveur efface aussi ce que Jaris avait reçu de lui. Jamais sur un simple échec. */
export async function forgetMcpAuth(serverId: string): Promise<void> {
  memory.delete(serverId)
  await rm(authFile(serverId), { force: true }).catch(() => {})
}

/** A-t-on déjà une clé pour ce serveur (sinon : « À connecter ») ? */
export async function hasMcpTokens(serverId: string): Promise<boolean> {
  return Boolean((await load(serverId)).tokens?.access_token)
}

/** Un port libre sur 127.0.0.1 (choisi une fois à l'inscription, puis réutilisé : il fait partie de l'adresse inscrite). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Le fournisseur OAuth d'un serveur, pour le kit MCP. `onAuthorize` reçoit l'adresse de la page de connexion : elle
 * n'est ouverte que pendant une connexion demandée par Léo (`interactive`) — jamais en arrière-plan au démarrage.
 */
export async function mcpAuthProvider(serverId: string, interactive: { open: boolean; state: string } | null): Promise<OAuthClientProvider> {
  const stored = await load(serverId)
  const port = stored.port ?? (await freePort())
  if (stored.port !== port) await save(serverId, { port })
  const redirectUrl = `http://127.0.0.1:${port}/callback`
  const metadata: OAuthClientMetadata = {
    client_name: 'Jaris',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }
  return {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return metadata
    },
    state: () => interactive?.state ?? '',
    clientInformation: async () => (await load(serverId)).client,
    saveClientInformation: (client) => save(serverId, { client }),
    tokens: async () => (await load(serverId)).tokens,
    saveTokens: (tokens) => save(serverId, { tokens }),
    saveCodeVerifier: (verifier) => save(serverId, { verifier }),
    codeVerifier: async () => {
      const verifier = (await load(serverId)).verifier
      if (!verifier) throw new Error(t('mcp.error.signinFailed', { error: 'PKCE' }))
      return verifier
    },
    redirectToAuthorization: async (url) => {
      if (interactive?.open) await opener(url.toString())
    },
    invalidateCredentials: async (scope) => {
      // Le serveur a refusé : on oublie seulement ce qu'il a refusé (jamais tout sur un seul échec).
      if (scope === 'all') await save(serverId, { client: undefined, tokens: undefined, verifier: undefined })
      else if (scope === 'client') await save(serverId, { client: undefined })
      else if (scope === 'tokens') await save(serverId, { tokens: undefined })
      else if (scope === 'verifier') await save(serverId, { verifier: undefined })
    }
  }
}

/** Le port inscrit pour ce serveur (celui que la page de connexion rappellera). */
export async function mcpAuthPort(serverId: string): Promise<number> {
  const stored = await load(serverId)
  if (stored.port) return stored.port
  const port = await freePort()
  await save(serverId, { port })
  return port
}

/** Le port inscrit est pris par un autre programme : Jaris en choisit un autre et s'inscrit de nouveau. */
export async function resetMcpAuthPort(serverId: string): Promise<void> {
  await save(serverId, { port: undefined, client: undefined })
}

/** Petite page que le navigateur affiche à la fin, dans la langue de Jaris. */
function page(text: string): string {
  const safe = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  return `<!doctype html><meta charset="utf-8"><title>Jaris</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f7f7f7;color:#111"><p style="font-size:18px;max-width:28em;text-align:center">${safe}</p></body>`
}

/**
 * Ouvre l'adresse de retour `http://127.0.0.1:<port>/callback` AVANT que le navigateur ne parte (un port pris : erreur
 * tout de suite, sans page de connexion ouverte pour rien), puis renvoie l'attente du code. Le `state` doit être celui
 * de CETTE connexion (une autre page ne peut pas glisser son code). `signal` : Léo annule, ou trop long.
 */
export function listenForMcpCallback(port: number, state: string, serverName: string, signal: AbortSignal): Promise<{ code: Promise<string> }> {
  return new Promise((ready, failed) => {
    let listening = false
    const code = waitForMcpCallback(port, state, serverName, signal, () => {
      listening = true
      ready({ code })
    })
    code.catch((err) => {
      if (!listening) failed(err)
    })
  })
}

function waitForMcpCallback(port: number, state: string, serverName: string, signal: AbortSignal, onListening: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null
    const finish = (err: Error | null, code?: string): void => {
      signal.removeEventListener('abort', onAbort)
      server?.close()
      server?.closeAllConnections?.()
      if (err) reject(err)
      else resolve(code as string)
    }
    const onAbort = (): void => finish(new McpSignInError(t('mcp.error.signinTimeout', { name: serverName })))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const ok = !error && Boolean(code) && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      if (ok) {
        res.end(page(t('mcp.signin.done', { name: serverName })))
        finish(null, code as string)
      } else {
        const reason = error ? (url.searchParams.get('error_description') ?? error) : 'state'
        res.end(page(t('mcp.error.signinFailed', { error: reason })))
        finish(new McpSignInError(t('mcp.error.signinFailed', { error: reason })))
      }
    })
    server.once('error', (err) => finish(err as Error))
    server.listen(port, '127.0.0.1', onListening)
  })
}
