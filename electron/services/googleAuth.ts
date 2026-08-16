import { randomBytes } from 'crypto'
import { createServer } from 'http'
import { app, safeStorage, shell } from 'electron'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { OAuth2Client } from 'google-auth-library'
import { config } from '../config'

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'openid']

const tokenPath = join(app.getPath('userData'), 'gmail-token.enc')

interface StoredToken {
  email: string
  refreshToken: string
}

export interface GmailStatus {
  connected: boolean
  email: string | null
}

async function readStoredToken(): Promise<StoredToken | null> {
  try {
    const encrypted = await readFile(tokenPath)
    return JSON.parse(safeStorage.decryptString(encrypted)) as StoredToken
  } catch {
    return null
  }
}

async function writeStoredToken(token: StoredToken): Promise<void> {
  await writeFile(tokenPath, safeStorage.encryptString(JSON.stringify(token)))
}

function createOAuthClient(redirectUri: string): OAuth2Client {
  return new OAuth2Client({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri })
}

export async function getGmailStatus(): Promise<GmailStatus> {
  const stored = await readStoredToken()
  return { connected: Boolean(stored), email: stored?.email ?? null }
}

export async function disconnectGmail(): Promise<void> {
  await rm(tokenPath, { force: true })
}

/**
 * Ouvre le navigateur système pour l'autorisation Google (obligatoire : Google bloque les popups
 * intégrées à l'app), récupère le code via un petit serveur HTTP local temporaire, échange contre un
 * refresh token et le stocke chiffré (Electron safeStorage, via le trousseau du système).
 */
export async function connectGmail(): Promise<GmailStatus> {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error(
      'Configuration Google manquante : renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env (voir le README).'
    )
  }

  const state = randomBytes(16).toString('hex')

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    // Capturé au démarrage du serveur : server.address() renvoie null une fois server.close() appelé,
    // donc on ne peut pas relire le port après coup dans le handler de la requête.
    let redirectUri = ''

    const server = createServer((req, res) => {
      try {
        if (!req.url) return
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404)
          res.end()
          return
        }

        const authCode = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const returnedState = url.searchParams.get('state')
        const ok = !error && authCode && returnedState === state

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          ok
            ? '<html><body>Compte Google connecté, tu peux fermer cette fenêtre et revenir à Jaris.</body></html>'
            : '<html><body>Connexion Google annulée ou échouée, tu peux fermer cette fenêtre.</body></html>'
        )
        server.close()

        if (!ok || !authCode) {
          reject(new Error(error || 'Autorisation Google refusée ou invalide.'))
          return
        }
        resolve({ code: authCode, redirectUri })
      } catch (err) {
        server.close()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Impossible de démarrer le serveur local pour la connexion Google.'))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`
      const authUrl = createOAuthClient(redirectUri).generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state
      })
      void shell.openExternal(authUrl)
    })
  })

  const client = createOAuthClient(redirectUri)
  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error(
      "Google n'a pas renvoyé de jeton persistant. Retire l'accès de Jaris sur " +
        'myaccount.google.com/permissions puis réessaie.'
    )
  }

  client.setCredentials(tokens)
  const userInfo = await client.request<{ email?: string }>({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' })
  const email = userInfo.data.email ?? 'compte Google'

  await writeStoredToken({ email, refreshToken: tokens.refresh_token })
  return { connected: true, email }
}

/** Client OAuth2 authentifié (rafraîchit l'access token automatiquement), ou null si aucun compte n'est connecté. */
export async function getGmailClient(): Promise<OAuth2Client | null> {
  const stored = await readStoredToken()
  if (!stored) return null

  const client = createOAuthClient('')
  client.setCredentials({ refresh_token: stored.refreshToken })
  return client
}
