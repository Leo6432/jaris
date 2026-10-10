import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { GithubRepoSummary } from '../../shared/ipc'

/**
 * GitHub pour le mode Code (étape 277). Léo : « pouvoir connecter Jaris à GitHub pour Code », pour « travailler
 * sur mes dépôts », avec la connexion « la plus facile pour les utilisateurs ».
 *
 * Connexion : le « device flow » documenté par GitHub (docs.github.com, Authorizing OAuth apps → Device flow).
 * Jaris affiche un code à 8 caractères, Léo le colle sur github.com/login/device et clique « Autoriser » : aucun
 * mot de passe ni jeton à créer ou à recopier, et aucun secret embarqué dans Jaris (« The client_secret is not
 * needed for the device flow »).
 *
 * Lecture et écriture : uniquement l'API REST, jamais `git` (rien à installer chez l'utilisateur). Un
 * enregistrement = un seul commit, construit par la Git Data API (arbre → commit → déplacement de la branche),
 * toujours SANS forcer : si la branche a bougé entre-temps, GitHub refuse et rien n'est écrasé.
 *
 * Le jeton ne quitte jamais ce process : il n'apparaît dans aucun message d'erreur, aucune URL, aucun journal.
 */

const API = 'https://api.github.com'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** « repo » : lire et écrire les dépôts, privés compris — ce que Léo a demandé. Rien d'autre. */
export const GITHUB_SCOPE = 'repo'
/** Au-delà, un fichier n'est pas lu (ni donc modifié) par Jaris : trop lourd pour le modèle local. */
const MAX_TEXT_FILE_BYTES = 400_000
/** Trois pages de 100 : largement assez pour choisir un dépôt, sans attendre une liste interminable. */
const MAX_REPO_PAGES = 3

type FetchLike = typeof fetch

/** Erreur lisible par Léo, avec le statut HTTP pour le code qui doit réagir (reconnexion, conflit). */
export class GithubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: 'auth' | 'conflict' | 'other' = 'other'
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
}

// ---------------------------------------------------------------------------------------------------------
// Connexion par code
// ---------------------------------------------------------------------------------------------------------

export interface DeviceLogin {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Date limite (ms) pour taper le code — 15 minutes par défaut chez GitHub. */
  expiresAt: number
  /** Écart minimal entre deux demandes de jeton, imposé par GitHub. */
  intervalMs: number
}

async function postForm(url: string, params: Record<string, string>, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal
    })
  } catch (err) {
    if (isAbort(err)) throw err
    throw new GithubError(0, 'Impossible de joindre GitHub : vérifie ta connexion internet.')
  }
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new GithubError(response.status, `GitHub a répondu quelque chose d'illisible (code ${response.status}).`)
  }
}

/** Étape 1 du device flow : obtenir le code à montrer à Léo. */
export async function requestDeviceCode(clientId: string, fetchImpl: FetchLike = fetch, now: () => number = Date.now): Promise<DeviceLogin> {
  const data = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_SCOPE }, fetchImpl)
  if (typeof data.error === 'string') throw deviceFlowError(data.error)
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new GithubError(0, "GitHub n'a pas donné de code de connexion. Réessaie dans un instant.")
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    // Cette adresse est ouverte dans le navigateur : seule une page de github.com est acceptée.
    verificationUri:
      typeof data.verification_uri === 'string' && data.verification_uri.startsWith('https://github.com/')
        ? data.verification_uri
        : 'https://github.com/login/device',
    expiresAt: now() + (typeof data.expires_in === 'number' ? data.expires_in : 900) * 1000,
    intervalMs: (typeof data.interval === 'number' ? data.interval : 5) * 1000
  }
}

/** Les erreurs documentées du device flow, en français et avec quoi faire. */
function deviceFlowError(code: string): GithubError {
  switch (code) {
    case 'expired_token':
    case 'token_expired':
      return new GithubError(0, 'Le code a expiré avant d\'être validé sur GitHub. Clique à nouveau sur « Se connecter à GitHub ».')
    case 'access_denied':
      return new GithubError(0, 'La connexion a été refusée sur GitHub. Tu peux recommencer quand tu veux.')
    case 'device_flow_disabled':
      return new GithubError(0, "La connexion par code n'est pas activée dans l'application GitHub de Jaris (case « Enable Device Flow »).")
    case 'incorrect_client_credentials':
      return new GithubError(0, "GitHub ne reconnaît pas l'application de Jaris (identifiant client invalide).")
    default:
      return new GithubError(0, `GitHub a refusé la connexion (${code}).`)
  }
}

/** Pause interrompable : « Annuler » pendant l'attente doit répondre tout de suite, pas au prochain essai. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Connexion annulée.'), { name: 'AbortError' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(Object.assign(new Error('Connexion annulée.'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface PollOptions {
  fetchImpl?: FetchLike
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

/**
 * Étape 3 du device flow : attendre que Léo ait validé le code. Respecte l'intervalle imposé (et l'allonge de 5 s
 * sur `slow_down`, comme la documentation l'exige). Une coupure réseau passagère ne fait pas échouer l'attente :
 * Léo est peut-être en train de taper le code, trois échecs d'affilée seulement l'arrêtent.
 */
export async function pollDeviceToken(clientId: string, login: DeviceLogin, options: PollOptions = {}): Promise<string> {
  const { fetchImpl = fetch, sleep = abortableSleep, now = Date.now, signal } = options
  let interval = login.intervalMs
  let networkFailures = 0
  for (;;) {
    await sleep(interval, signal)
    if (now() > login.expiresAt) throw deviceFlowError('expired_token')
    let data: Record<string, unknown>
    try {
      data = await postForm(ACCESS_TOKEN_URL, { client_id: clientId, device_code: login.deviceCode, grant_type: DEVICE_GRANT }, fetchImpl, signal)
      networkFailures = 0
    } catch (err) {
      if (isAbort(err)) throw err
      networkFailures += 1
      if (networkFailures >= 3) throw err
      continue
    }
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token
    const code = typeof data.error === 'string' ? data.error : 'unknown'
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') {
      interval = typeof data.interval === 'number' ? data.interval * 1000 : interval + 5000
      continue
    }
    throw deviceFlowError(code)
  }
}

// ---------------------------------------------------------------------------------------------------------
// Jeton, chiffré par Windows (DPAPI via safeStorage)
// ---------------------------------------------------------------------------------------------------------

/** Repli si le chiffrement du système est indisponible : gardé en mémoire seulement, jamais écrit en clair. */
let memoryToken: string | null = null

function tokenPath(): string {
  return join(app.getPath('userData'), 'github-token.bin')
}

export async function saveGithubToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    memoryToken = token
    return
  }
  memoryToken = null
  await writeFile(tokenPath(), safeStorage.encryptString(token))
}

export async function loadGithubToken(): Promise<string | null> {
  if (memoryToken) return memoryToken
  try {
    const encrypted = await readFile(tokenPath())
    return safeStorage.decryptString(encrypted) || null
  } catch {
    return null
  }
}

export async function clearGithubToken(): Promise<void> {
  memoryToken = null
  await rm(tokenPath(), { force: true })
}

// ---------------------------------------------------------------------------------------------------------
// API REST
// ---------------------------------------------------------------------------------------------------------

export interface RepoFile {
  path: string
  sha: string
  size: number
  mode: string
}

/** Photographie d'une branche au moment de l'ouverture : ce qui sert de base au futur commit. */
export interface RepoSnapshot {
  owner: string
  repo: string
  fullName: string
  branch: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
  /** `null` : dépôt tout neuf, sans aucun commit (étape 279) — le premier enregistrement le crée. */
  commitSha: string | null
  treeSha: string | null
  files: RepoFile[]
  truncated: boolean
}

export interface FileChange {
  path: string
  /** `null` : fichier supprimé. */
  content: string | null
}

/** « propriétaire/nom », refusé sinon : ce texte finit dans des URL de l'API. */
export function parseFullName(fullName: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(fullName.trim())
  if (!match || match[2] === '.' || match[2] === '..') throw new GithubError(0, `Nom de dépôt invalide : ${fullName}`)
  return { owner: match[1], repo: match[2] }
}

/** Nom de branche découpé segment par segment : « claude/ma-branche » garde son « / ». */
function branchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * Le message GitHub (court, en anglais) n'est gardé que là où il aide à comprendre ; le reste est traduit en
 * une phrase qui dit quoi faire.
 */
export function githubHttpError(status: number, apiMessage: string | undefined, rateLimitRemaining: string | null): GithubError {
  const message = apiMessage ?? ''
  if (status === 401) {
    return new GithubError(401, "Ta connexion à GitHub n'est plus valable (retirée ou expirée). Reconnecte-toi depuis le mode Code.", 'auth')
  }
  if (/workflow/i.test(message)) {
    return new GithubError(status, "GitHub refuse que Jaris modifie les fichiers .github/workflows (il faudrait une autorisation spéciale). Annule le changement de ce fichier puis réessaie.")
  }
  if (status === 403 && rateLimitRemaining === '0') {
    return new GithubError(403, 'GitHub limite le nombre de demandes pour le moment : réessaie dans quelques minutes.')
  }
  if (status === 422 && /fast.?forward/i.test(message)) {
    return new GithubError(
      422,
      "Le dépôt a changé sur GitHub depuis que Jaris l'a ouvert : rien n'a été écrasé. Annule tes changements, rouvre le dépôt pour repartir de la dernière version, puis redemande-les.",
      'conflict'
    )
  }
  if ((status === 422 || status === 403) && /protected/i.test(message)) {
    return new GithubError(status, 'Cette branche est protégée sur GitHub : Jaris ne peut pas y enregistrer directement. Choisis une autre branche.')
  }
  if (status === 404) return new GithubError(404, 'Introuvable sur GitHub (dépôt supprimé, renommé, ou sans accès pour ton compte).')
  if (status === 409) return new GithubError(409, 'Ce dépôt est vide : ajoute au moins un premier fichier sur GitHub avant de travailler dessus avec Jaris.')
  return new GithubError(status, `GitHub a répondu une erreur (code ${status}${message ? ` : ${message}` : ''}).`)
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Jaris',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      })
    } catch (err) {
      if (isAbort(err)) throw err
      throw new GithubError(0, 'Impossible de joindre GitHub : vérifie ta connexion internet.')
    }
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const apiMessage = (data as { message?: unknown } | null)?.message
      throw githubHttpError(response.status, typeof apiMessage === 'string' ? apiMessage : undefined, response.headers.get('x-ratelimit-remaining'))
    }
    return data as T
  }

  async viewer(): Promise<string> {
    const user = await this.request<{ login: string }>('GET', '/user')
    return user.login
  }

  async listRepos(): Promise<GithubRepoSummary[]> {
    const repos: GithubRepoSummary[] = []
    for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
      const batch = await this.request<
        Array<{ full_name: string; private: boolean; description: string | null; default_branch: string; pushed_at: string | null; archived?: boolean }>
      >('GET', `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`)
      for (const repo of batch) {
        // Un dépôt archivé est en lecture seule : Jaris ne pourrait rien y enregistrer.
        if (repo.archived) continue
        repos.push({
          fullName: repo.full_name,
          private: repo.private,
          description: repo.description,
          defaultBranch: repo.default_branch,
          pushedAt: repo.pushed_at
        })
      }
      if (batch.length < 100) break
    }
    return repos
  }

  async listBranches(fullName: string): Promise<string[]> {
    const { owner, repo } = parseFullName(fullName)
    const branches = await this.request<Array<{ name: string }>>('GET', `/repos/${owner}/${repo}/branches?per_page=100`)
    return branches.map((branch) => branch.name)
  }

  async openRepo(fullName: string, branch?: string): Promise<RepoSnapshot> {
    const { owner, repo } = parseFullName(fullName)
    const info = await this.request<{ full_name: string; default_branch: string; private: boolean; html_url: string }>('GET', `/repos/${owner}/${repo}`)
    const target = branch || info.default_branch
    let head: { commit: { sha: string; commit: { tree: { sha: string } } } }
    try {
      head = await this.request('GET', `/repos/${owner}/${repo}/branches/${branchPath(target)}`)
    } catch (err) {
      if (!(err instanceof GithubError) || err.status !== 404) throw err
      if (branch) throw new GithubError(404, `La branche « ${branch} » n'existe pas (ou plus) sur GitHub.`)
      // Étape 279 (Léo : « pourquoi on peut pas même sans rien dans le dépôt ») : un dépôt tout neuf n'a encore
      // aucune branche. GitHub le dit en répondant 409 (« Git Repository is empty ») à la liste des commits : on
      // l'ouvre alors VIDE, et le premier enregistrement crée sa branche.
      if (await this.isEmpty(owner, repo)) {
        return {
          owner,
          repo,
          fullName: info.full_name,
          branch: info.default_branch,
          defaultBranch: info.default_branch,
          private: info.private,
          htmlUrl: info.html_url,
          commitSha: null,
          treeSha: null,
          files: [],
          truncated: false
        }
      }
      throw new GithubError(404, `La branche principale « ${info.default_branch} » est introuvable sur GitHub.`)
    }
    const tree = await this.request<{ tree: Array<{ path: string; type: string; sha: string; size?: number; mode: string }>; truncated?: boolean }>(
      'GET',
      `/repos/${owner}/${repo}/git/trees/${head.commit.commit.tree.sha}?recursive=1`
    )
    return {
      owner,
      repo,
      fullName: info.full_name,
      branch: target,
      defaultBranch: info.default_branch,
      private: info.private,
      htmlUrl: info.html_url,
      commitSha: head.commit.sha,
      treeSha: head.commit.commit.tree.sha,
      // Les liens symboliques (120000) et sous-modules ne sont pas des fichiers texte que Jaris peut modifier.
      files: tree.tree
        .filter((entry) => entry.type === 'blob' && entry.mode !== '120000')
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0, mode: entry.mode })),
      truncated: tree.truncated === true
    }
  }

  private async isEmpty(owner: string, repo: string): Promise<boolean> {
    try {
      await this.request('GET', `/repos/${owner}/${repo}/commits?per_page=1`)
      return false
    } catch (err) {
      if (err instanceof GithubError && err.status === 409) return true
      throw err
    }
  }

  /** Contenu texte d'un fichier, `null` s'il est binaire ou trop lourd pour être confié au modèle. */
  async readText(snapshot: RepoSnapshot, file: RepoFile): Promise<string | null> {
    if (file.size > MAX_TEXT_FILE_BYTES) return null
    const blob = await this.request<{ content: string; encoding: string }>('GET', `/repos/${snapshot.owner}/${snapshot.repo}/git/blobs/${file.sha}`)
    const bytes = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8')
    return decodeText(bytes)
  }

  /**
   * Un seul commit avec tous les changements, posé SANS forcer sur la branche photographiée à l'ouverture.
   * Un fichier supprimé passe par `sha: null` (documenté : « If the value is null then the file will be
   * deleted »), le reste par `content` : GitHub crée lui-même les blobs.
   */
  async commit(snapshot: RepoSnapshot, changes: FileChange[], message: string): Promise<{ sha: string; url: string }> {
    if (changes.length === 0) throw new GithubError(0, "Il n'y a aucun changement à enregistrer.")
    if (snapshot.commitSha === null || snapshot.treeSha === null) return this.firstCommit(snapshot, changes, message)
    return this.commitOnto(snapshot, { commitSha: snapshot.commitSha, treeSha: snapshot.treeSha }, changes, message)
  }

  /**
   * Dépôt vide (étape 279) : l'API d'arbres et de commits ne peut rien écrire tant qu'il n'existe aucun commit.
   * L'API « créer un fichier » sait, elle, faire ce tout premier commit (c'est ce que fait le bouton « creating a
   * new file » d'un dépôt vide sur github.com). Le premier fichier passe donc par elle, les autres suivent dans un
   * second commit posé dessus, toujours sans forcer.
   */
  private async firstCommit(snapshot: RepoSnapshot, changes: FileChange[], message: string): Promise<{ sha: string; url: string }> {
    const writes = changes.filter((change): change is { path: string; content: string } => change.content !== null)
    if (writes.length === 0) throw new GithubError(0, "Le dépôt est vide : il n'y a aucun fichier à créer.")
    const [first, ...rest] = writes
    const created = await this.request<{ commit: { sha: string; html_url: string; tree: { sha: string } } }>(
      'PUT',
      `/repos/${snapshot.owner}/${snapshot.repo}/contents/${first.path.split('/').map(encodeURIComponent).join('/')}`,
      { message, content: Buffer.from(first.content, 'utf8').toString('base64') }
    )
    if (rest.length === 0) return { sha: created.commit.sha, url: created.commit.html_url }
    return this.commitOnto(snapshot, { commitSha: created.commit.sha, treeSha: created.commit.tree.sha }, rest, message)
  }

  private async commitOnto(
    snapshot: RepoSnapshot,
    parent: { commitSha: string; treeSha: string },
    changes: FileChange[],
    message: string
  ): Promise<{ sha: string; url: string }> {
    const modes = new Map(snapshot.files.map((file) => [file.path, file.mode]))
    const base = `/repos/${snapshot.owner}/${snapshot.repo}`
    const tree = await this.request<{ sha: string }>('POST', `${base}/git/trees`, {
      base_tree: parent.treeSha,
      tree: changes.map((change) =>
        change.content === null
          ? { path: change.path, mode: modes.get(change.path) ?? '100644', type: 'blob', sha: null }
          : { path: change.path, mode: modes.get(change.path) ?? '100644', type: 'blob', content: change.content }
      )
    })
    const commit = await this.request<{ sha: string; html_url: string }>('POST', `${base}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [parent.commitSha]
    })
    await this.request('PATCH', `${base}/git/refs/heads/${branchPath(snapshot.branch)}`, { sha: commit.sha, force: false })
    return { sha: commit.sha, url: commit.html_url }
  }
}

/** Texte UTF-8, ou `null` pour un fichier binaire (un octet nul dans les premiers 8 Ko, comme le fait git). */
export function decodeText(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 8000)
  if (head.includes(0)) return null
  return bytes.toString('utf8')
}
