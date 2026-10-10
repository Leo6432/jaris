import { config } from '../config'
import { chosenThink } from '../../shared/effort'
import type { CodeGenProgress, GithubDeviceCode, GithubRepoSummary, GithubStatus, RepoAgentResult, RepoChange, RepoCommitResult, RepoView } from '../../shared/ipc'
import { GenerationStoppedError, createModelStepRunner, isAbortError, readModelMaxContext, resolveCodeModel } from './codeGenerator'
import {
  GithubClient,
  GithubError,
  clearGithubToken,
  loadGithubToken,
  pollDeviceToken,
  requestDeviceCode,
  saveGithubToken,
  type DeviceLogin,
  type RepoSnapshot
} from './github'
import { getModelThinking, type ThinkLevel } from './ollama'
import { getProfile } from './profileStore'
import { runRepoAgent } from './repoAgent'
import type { ThinkValue } from '../../shared/effort'

/**
 * État GitHub du mode Code (étape 277), côté main : compte connecté, dépôts ouverts et changements préparés par
 * Jaris en attente de vérification. Rien de tout ça n'est écrit sur le disque, à part le jeton chiffré
 * (github.ts) : fermer Jaris abandonne les changements non enregistrés, comme fermer un éditeur sans sauvegarder.
 */

interface RepoSession {
  snapshot: RepoSnapshot
  /** Chemin → nouveau contenu (`null` = supprimé). Seul ce qui diffère vraiment de GitHub y reste. */
  staged: Map<string, string | null>
  /** Contenus lus sur GitHub (`null` = binaire/trop lourd), pour ne pas relire deux fois. */
  originals: Map<string, string | null>
  busy: boolean
}

let client: GithubClient | null = null
let login: string | null = null
let pendingLogin: { device: DeviceLogin; controller: AbortController } | null = null
const sessions = new Map<string, RepoSession>()

function clientId(): string {
  return config.github.clientId
}

async function getClient(): Promise<GithubClient | null> {
  if (client) return client
  const token = await loadGithubToken()
  if (!token) return null
  client = new GithubClient(token)
  return client
}

async function forget(): Promise<void> {
  client = null
  login = null
  sessions.clear()
  await clearGithubToken()
}

/** Toute demande à GitHub passe par ici : un jeton refusé (retiré sur github.com) déconnecte proprement. */
async function withClient<T>(action: (github: GithubClient) => Promise<T>): Promise<T> {
  const github = await getClient()
  if (!github) throw new GithubError(401, "Jaris n'est pas connecté à GitHub.", 'auth')
  try {
    return await action(github)
  } catch (err) {
    if (err instanceof GithubError && err.reason === 'auth') await forget()
    throw err
  }
}

export async function getGithubStatus(): Promise<GithubStatus> {
  if (!clientId()) return { available: false, connected: false, login: null }
  const github = await getClient()
  if (!github) return { available: true, connected: false, login: null }
  if (!login) {
    try {
      login = await github.viewer()
    } catch (err) {
      if (err instanceof GithubError && err.reason === 'auth') {
        await forget()
        return { available: true, connected: false, login: null }
      }
      // Réseau coupé : toujours connecté, le nom s'affichera au prochain essai.
      return { available: true, connected: true, login: null }
    }
  }
  return { available: true, connected: true, login }
}

export async function startGithubLogin(): Promise<GithubDeviceCode> {
  if (!clientId()) throw new GithubError(0, "La connexion à GitHub n'est pas encore configurée dans cette version de Jaris.")
  pendingLogin?.controller.abort()
  const device = await requestDeviceCode(clientId())
  pendingLogin = { device, controller: new AbortController() }
  return { userCode: device.userCode, verificationUri: device.verificationUri }
}

/** Attend que le code soit validé sur github.com, puis enregistre le jeton (chiffré). */
export async function finishGithubLogin(): Promise<GithubStatus> {
  const pending = pendingLogin
  if (!pending) throw new GithubError(0, 'Aucune connexion en cours : clique sur « Se connecter à GitHub ».')
  try {
    const token = await pollDeviceToken(clientId(), pending.device, { signal: pending.controller.signal })
    await saveGithubToken(token)
    client = new GithubClient(token)
    login = null
    sessions.clear()
    return await getGithubStatus()
  } catch (err) {
    if (isAbortError(err)) throw new GithubError(0, 'Connexion annulée.')
    throw err
  } finally {
    if (pendingLogin === pending) pendingLogin = null
  }
}

export function cancelGithubLogin(): void {
  pendingLogin?.controller.abort()
}

export async function logoutGithub(): Promise<void> {
  cancelGithubLogin()
  await forget()
}

export function listGithubRepos(): Promise<GithubRepoSummary[]> {
  return withClient((github) => github.listRepos())
}

export function listGithubBranches(fullName: string): Promise<string[]> {
  return withClient((github) => github.listBranches(fullName))
}

function findSession(fullName: string): RepoSession | undefined {
  const wanted = fullName.toLowerCase()
  for (const [name, session] of sessions) if (name.toLowerCase() === wanted) return session
  return undefined
}

function requireSession(fullName: string): RepoSession {
  const session = findSession(fullName)
  if (!session) throw new GithubError(0, `Le dépôt ${fullName} n'est plus ouvert : rouvre-le depuis le bouton GitHub.`)
  return session
}

function listPaths(session: RepoSession): string[] {
  const paths = new Set(session.snapshot.files.map((file) => file.path))
  for (const [path, content] of session.staged) {
    if (content === null) paths.delete(path)
    else paths.add(path)
  }
  return [...paths].sort()
}

async function originalText(session: RepoSession, path: string): Promise<string | null | undefined> {
  if (session.originals.has(path)) return session.originals.get(path)
  const file = session.snapshot.files.find((entry) => entry.path === path)
  if (!file) return undefined
  const text = await withClient((github) => github.readText(session.snapshot, file))
  session.originals.set(path, text)
  return text
}

async function currentText(session: RepoSession, path: string): Promise<string | null | undefined> {
  if (session.staged.has(path)) {
    const staged = session.staged.get(path)
    return staged === null ? undefined : staged
  }
  return originalText(session, path)
}

/** Un changement qui revient à l'état de GitHub n'en est plus un : il disparaît de la liste. */
function stage(session: RepoSession, path: string, content: string | null): void {
  const inGithub = session.snapshot.files.some((file) => file.path === path)
  if (!inGithub && content === null) session.staged.delete(path)
  else if (inGithub && session.originals.has(path) && session.originals.get(path) === content) session.staged.delete(path)
  else session.staged.set(path, content)
}

function changesOf(session: RepoSession): RepoChange[] {
  return [...session.staged.entries()]
    .map(([path, after]): RepoChange => {
      const inGithub = session.snapshot.files.some((file) => file.path === path)
      const before = inGithub ? session.originals.get(path) ?? null : null
      return { path, kind: !inGithub ? 'added' : after === null ? 'deleted' : 'modified', before, after }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function viewOf(session: RepoSession): RepoView {
  const { snapshot } = session
  return {
    fullName: snapshot.fullName,
    branch: snapshot.branch,
    defaultBranch: snapshot.defaultBranch,
    private: snapshot.private,
    htmlUrl: snapshot.htmlUrl,
    fileCount: listPaths(session).length,
    truncated: snapshot.truncated,
    changes: changesOf(session)
  }
}

/**
 * Ouvre (ou rouvre) un dépôt. Des changements en attente ne sont jamais jetés en silence : rouvrir le même dépôt
 * les retrouve, et changer de branche est refusé tant qu'ils ne sont ni enregistrés ni annulés.
 */
export async function openGithubRepo(fullName: string, branch?: string): Promise<RepoView> {
  const existing = findSession(fullName)
  if (existing && existing.staged.size > 0) {
    if (!branch || branch === existing.snapshot.branch) return viewOf(existing)
    throw new GithubError(0, 'Enregistre ou annule tes changements avant de changer de branche.')
  }
  const snapshot = await withClient((github) => github.openRepo(fullName, branch))
  if (existing) sessions.delete(existing.snapshot.fullName)
  const session: RepoSession = { snapshot, staged: new Map(), originals: new Map(), busy: false }
  sessions.set(snapshot.fullName, session)
  return viewOf(session)
}

/** Réflexion choisie pour le modèle Code s'il y en a une, sinon « medium » : l'agent enchaîne des dizaines d'appels. */
async function agentThink(model: string): Promise<ThinkLevel | ThinkValue> {
  const choice = (await getProfile())?.thinkChoices?.code
  if (!choice) return 'medium'
  return chosenThink(choice, model, await getModelThinking(model)) ?? 'medium'
}

/** Mémoire de travail laissée à l'historique : la fenêtre du modèle, moins la place de sa réponse et de sa réflexion. */
export function historyBudgetChars(modelMax: number | null): number {
  const tokens = Math.min(65536, modelMax && modelMax > 0 ? modelMax : 65536)
  return Math.max(20_000, Math.min(90_000, Math.floor((tokens - 16384) * 2.5)))
}

export interface RunGithubAgentOptions {
  onStatus: (message: string) => void
  onProgress?: (progress: CodeGenProgress) => void
  signal?: AbortSignal
}

export async function runGithubAgent(fullName: string, request: string, options: RunGithubAgentOptions): Promise<RepoAgentResult> {
  // Dépôt oublié entre-temps (relecture impossible après un enregistrement) : rouvert depuis GitHub.
  if (!findSession(fullName)) await openGithubRepo(fullName)
  const session = requireSession(fullName)
  if (session.busy) throw new GithubError(0, 'Jaris travaille déjà sur ce dépôt.')
  session.busy = true
  try {
    const profile = await getProfile()
    const model = await resolveCodeModel(options.onStatus, profile)
    const modelMax = await readModelMaxContext(model)
    const run = createModelStepRunner({
      model,
      think: await agentThink(model),
      modelMaxContext: modelMax,
      // Nombre d'étapes inconnu d'avance : « Étape 3 », sans « sur N » (voir formatCodeGenProgress).
      steps: { index: 0, count: 0 },
      onStatus: options.onStatus,
      onProgress: options.onProgress,
      signal: options.signal
    })
    const outcome = await runRepoAgent(request, {
      repoName: session.snapshot.fullName,
      branch: session.snapshot.branch,
      listPaths: () => listPaths(session),
      readFile: (path) => currentText(session, path),
      writeFile: (path, content) => stage(session, path, content),
      pendingSummary: () =>
        changesOf(session).map((change) => `- ${change.kind === 'added' ? 'créé' : change.kind === 'deleted' ? 'supprimé' : 'modifié'} : ${change.path}`),
      chat: (messages) => run(`Travail sur ${session.snapshot.fullName}`, messages, 8000),
      onStatus: options.onStatus,
      signal: options.signal,
      maxHistoryChars: historyBudgetChars(modelMax)
    })
    return { summary: outcome.summary, view: viewOf(session) }
  } catch (err) {
    if (isAbortError(err)) throw new GenerationStoppedError()
    throw err
  } finally {
    session.busy = false
  }
}

export function discardGithubChanges(fullName: string, path?: string): RepoView {
  const session = requireSession(fullName)
  if (session.busy) throw new GithubError(0, 'Attends la fin du travail en cours (ou arrête-le) avant d\'annuler.')
  if (path) session.staged.delete(path)
  else session.staged.clear()
  return viewOf(session)
}

/**
 * Enregistre sur GitHub, en un seul commit, exactement les changements affichés à Léo — jamais pendant que
 * l'agent travaille (la liste pourrait changer entre ce qu'il a vu et ce qui part).
 */
export async function commitGithubChanges(fullName: string, message: string): Promise<RepoCommitResult> {
  const session = requireSession(fullName)
  if (session.busy) throw new GithubError(0, 'Attends la fin du travail en cours avant d\'enregistrer.')
  const changes = [...session.staged.entries()].map(([path, content]) => ({ path, content }))
  if (changes.length === 0) throw new GithubError(0, "Il n'y a aucun changement à enregistrer.")
  const text = message.trim() || 'Modifications préparées avec Jaris'
  session.busy = true
  let result: { sha: string; url: string }
  try {
    result = await withClient((github) => github.commit(session.snapshot, changes, text))
  } finally {
    session.busy = false
  }
  // Le commit est fait : on repart de la nouvelle version de la branche pour la demande suivante.
  session.staged.clear()
  session.originals.clear()
  try {
    session.snapshot = await withClient((github) => github.openRepo(session.snapshot.fullName, session.snapshot.branch))
  } catch {
    // Relecture impossible (réseau) : le dépôt sera rouvert depuis GitHub à la prochaine demande, jamais réutilisé
    // avec l'ancienne base, qui ferait refuser le commit suivant.
    sessions.delete(session.snapshot.fullName)
  }
  return { sha: result.sha, url: result.url, view: viewOf(session) }
}

