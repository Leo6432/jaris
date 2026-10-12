import { config } from '../config'
import { chosenThink } from '../../shared/effort'
import type { CodeActivity, CodeGenProgress, CodeLiveWrite, CodeNarration, GithubDeviceCode, GithubLostConnection, GithubRepoSummary, GithubStatus, RepoAgentResult, RepoChange, RepoCommitResult, RepoView } from '../../shared/ipc'
import { GenerationStoppedError, createModelStepRunner, describeImageForCode, isAbortError, readModelMaxContext, resolveCodeModel, withImageDescription } from './codeGenerator'
import {
  GithubClient,
  GithubError,
  clearConnectionRecord,
  clearGithubToken,
  pollDeviceToken,
  readConnectionRecord,
  readGithubToken,
  requestDeviceCode,
  saveGithubToken,
  writeConnectionRecord,
  type DeviceLogin,
  type RepoSnapshot
} from './github'
import { getModelThinking, type ThinkLevel } from './ollama'
import { getProfile } from './profileStore'
import { runRepoAgent } from './repoAgent'
import type { ThinkValue } from '../../shared/effort'
import { t } from '../../shared/i18n'

/**
 * État GitHub du mode Code (étape 277), côté main : compte connecté, dépôts ouverts et changements préparés par
 * Jaris en attente de vérification. Rien de tout ça n'est écrit sur le disque, à part le jeton chiffré et la trace
 * de connexion sans le jeton (github.ts) : fermer Jaris abandonne les changements non enregistrés, comme fermer un
 * éditeur sans sauvegarder.
 */

interface RepoSession {
  snapshot: RepoSnapshot
  /** Chemin → nouveau contenu (`null` = supprimé). Seul ce qui diffère vraiment de GitHub y reste. */
  staged: Map<string, string | null>
  /** Contenus lus sur GitHub (`null` = binaire/trop lourd), pour ne pas relire deux fois. */
  originals: Map<string, string | null>
  /**
   * Fichiers bruts lus pour l'aperçu (étape 287) : une page recharge souvent ses images, inutile de les redemander.
   * Étape 304 : rangés par EMPREINTE GitHub (sha du contenu), plus par chemin — après un enregistrement, l'ancien
   * index.html ressortait de ce cache sous le même chemin, et l'aperçu montrait l'ancien site alors que GitHub (et
   * Vercel) avaient le nouveau. Une empreinte change avec le contenu : une version périmée ne peut plus ressortir.
   */
  previewFiles: Map<string, Buffer | null>
  busy: boolean
}

let client: GithubClient | null = null
let login: string | null = null
let pendingLogin: { device: DeviceLogin; controller: AbortController } | null = null
const sessions = new Map<string, RepoSession>()

function clientId(): string {
  return config.github.clientId
}

/** Un jeton trouvé mais illisible au dernier essai (pour dire pourquoi Jaris n'est plus connecté). */
let tokenUnreadable = false

async function getClient(): Promise<GithubClient | null> {
  if (client) return client
  const stored = await readGithubToken()
  tokenUnreadable = stored.unreadable
  if (!stored.token) return null
  client = new GithubClient(stored.token)
  return client
}

/**
 * Oublie la connexion. `rejected` : GitHub a refusé le jeton — la trace le note (étape 297) pour l'afficher ;
 * sinon c'est Léo qui s'est déconnecté, et il n'y a rien à expliquer.
 */
async function forget(rejected = false): Promise<void> {
  client = null
  login = null
  await clearGithubToken()
  if (!rejected) {
    sessions.clear()
    await clearConnectionRecord()
    return
  }
  // Étape 308 (Léo : « ça veut dire que ça va pas sauvegarder dans GitHub ») : un refus en plein travail effaçait
  // aussi les changements préparés. Ils restent : une fois reconnecté au même compte, ils partent sur GitHub.
  const record = await readConnectionRecord()
  if (record) await writeConnectionRecord({ ...record, rejectedAt: Date.now() })
}

/** Étape 297 : pas (ou plus) de jeton alors qu'une connexion avait été faite — dit pourquoi. */
async function lostConnection(): Promise<GithubLostConnection | null> {
  const record = await readConnectionRecord()
  if (!record) return null
  const reason = record.rejectedAt !== null ? 'rejected' : record.memoryOnly ? 'memoryOnly' : tokenUnreadable ? 'unreadable' : 'missing'
  return { reason, login: record.login, connectedAt: record.connectedAt }
}

/** Toute demande à GitHub passe par ici : un jeton refusé (retiré sur github.com) déconnecte proprement. */
const isAuthError = (err: unknown): boolean => err instanceof GithubError && err.reason === 'auth'

async function withClient<T>(action: (github: GithubClient) => Promise<T>): Promise<T> {
  const github = await getClient()
  if (!github) throw new GithubError(401, t('github.err.notConnected'), 'auth')
  try {
    return await action(github)
  } catch (err) {
    if (!isAuthError(err)) throw err
    // Étape 308 : un seul refus effaçait le jeton pour de bon — Léo devait se reconnecter « tous les jours ». Avant
    // d'effacer quoi que ce soit, GitHub dit lui-même si ce jeton vaut encore (/user) : s'il passe, la demande est
    // refaite une fois au lieu de déconnecter ; s'il est refusé là aussi, le jeton est vraiment mort.
    try {
      await github.viewer()
    } catch (check) {
      if (isAuthError(check)) await forget(true)
      throw err
    }
    return await action(github)
  }
}

export async function getGithubStatus(): Promise<GithubStatus> {
  if (!clientId()) return { available: false, connected: false, login: null }
  const github = await getClient()
  if (!github) return { available: true, connected: false, login: null, lost: await lostConnection() }
  if (!login) {
    try {
      login = await github.viewer()
      const record = await readConnectionRecord()
      if (record && record.login !== login) await writeConnectionRecord({ ...record, login })
    } catch (err) {
      if (err instanceof GithubError && err.reason === 'auth') {
        await forget(true)
        return { available: true, connected: false, login: null, lost: await lostConnection() }
      }
      // Réseau coupé : toujours connecté, le nom s'affichera au prochain essai.
      return { available: true, connected: true, login: null }
    }
  }
  return { available: true, connected: true, login }
}

export async function startGithubLogin(): Promise<GithubDeviceCode> {
  if (!clientId()) throw new GithubError(0, t('github.err.notConfigured'))
  pendingLogin?.controller.abort()
  const device = await requestDeviceCode(clientId())
  pendingLogin = { device, controller: new AbortController() }
  return { userCode: device.userCode, verificationUri: device.verificationUri }
}

/** Attend que le code soit validé sur github.com, puis enregistre le jeton (chiffré). */
export async function finishGithubLogin(): Promise<GithubStatus> {
  const pending = pendingLogin
  if (!pending) throw new GithubError(0, t('github.err.noPending'))
  try {
    const token = await pollDeviceToken(clientId(), pending.device, { signal: pending.controller.signal })
    const previous = await readConnectionRecord()
    const encrypted = await saveGithubToken(token)
    await writeConnectionRecord({ connectedAt: Date.now(), login: null, memoryOnly: !encrypted, rejectedAt: null })
    client = new GithubClient(token)
    login = null
    const status = await getGithubStatus()
    // Changements préparés gardés après un refus (étape 308) : seulement pour le MÊME compte, jamais pour un autre.
    if (!previous || previous.login === null || previous.login !== status.login) sessions.clear()
    return status
  } catch (err) {
    if (isAbortError(err)) throw new GithubError(0, t('github.loginCancelled'))
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
  if (!session) throw new GithubError(0, t('github.err.notOpen', { name: fullName }))
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

/**
 * GitHub refuse une branche sans aucun fichier (étape 306, essai réel sur une branche jetable : supprimer le DERNIER
 * fichier → `POST git/trees` « 404 Not Found », et l'arbre vide de git n'existe pas côté GitHub — 404 lui aussi).
 * Léo voyait donc « Introuvable sur GitHub » après « tout supprimer », sans que rien ne change. Un README.md minimal
 * reste à la place, préparé comme n'importe quel fichier : visible dans les changements, jamais caché à l'envoi.
 */
function keepBranchNonEmpty(session: RepoSession): boolean {
  if (listPaths(session).length > 0) return false
  stage(session, 'README.md', `# ${session.snapshot.repo}\n`)
  return true
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
    throw new GithubError(0, t('github.err.pendingBranch'))
  }
  const snapshot = await withClient((github) => github.openRepo(fullName, branch))
  if (existing) sessions.delete(existing.snapshot.fullName)
  const session: RepoSession = { snapshot, staged: new Map(), originals: new Map(), previewFiles: new Map(), busy: false }
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
  onActivity?: (activity: CodeActivity) => void
  onNarration?: (narration: CodeNarration) => void
  onLive?: (live: CodeLiveWrite | null) => void
  onProgress?: (progress: CodeGenProgress) => void
  signal?: AbortSignal
  /** Étape 298 (Léo : « en plein chat, on n'a pas le bouton image ») : une capture jointe, comme pour une nouvelle application. */
  imageBase64?: string
}

export async function runGithubAgent(fullName: string, request: string, options: RunGithubAgentOptions): Promise<RepoAgentResult> {
  // Dépôt oublié entre-temps (relecture impossible après un enregistrement) : rouvert depuis GitHub.
  if (!findSession(fullName)) await openGithubRepo(fullName)
  const session = requireSession(fullName)
  if (session.busy) throw new GithubError(0, t('github.err.busy'))
  session.busy = true
  try {
    const profile = await getProfile()
    // L'image est lue AVANT de charger le modèle de code : jamais deux modèles en mémoire à la fois (étape 91).
    const task = options.imageBase64
      ? withImageDescription(request, await describeImageForCode(options.imageBase64, profile?.visionModel ?? config.ollama.visionModel, options.onStatus))
      : request
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
    const outcome = await runRepoAgent(task, {
      repoName: session.snapshot.fullName,
      branch: session.snapshot.branch,
      listPaths: () => listPaths(session),
      readFile: (path) => currentText(session, path),
      writeFile: (path, content) => stage(session, path, content),
      pendingSummary: () =>
        changesOf(session).map((change) => `- ${change.kind === 'added' ? 'créé' : change.kind === 'deleted' ? 'supprimé' : 'modifié'} : ${change.path}`),
      chat: (messages, onDelta) => run(`Travail sur ${session.snapshot.fullName}`, messages, 8000, undefined, onDelta),
      onStatus: options.onStatus,
      onActivity: options.onActivity,
      onNarration: options.onNarration,
      onLive: options.onLive,
      signal: options.signal,
      maxHistoryChars: historyBudgetChars(modelMax)
    })
    const summary = keepBranchNonEmpty(session) ? `${outcome.summary}\n\n${t('github.keptReadme')}` : outcome.summary
    return { summary, view: viewOf(session), finished: !outcome.limitReached }
  } catch (err) {
    if (isAbortError(err)) throw new GenerationStoppedError()
    throw err
  } finally {
    session.busy = false
  }
}

/**
 * La page d'accueil du site d'un dépôt (étape 287) : index.html à la racine ; sinon celui d'un dossier de publication
 * habituel (docs/, public/, site/, dist/, build/, src/) ; sinon la page HTML la moins profonde. `null` : aucune page.
 */
export function findPreviewEntry(paths: string[]): string | null {
  const pages = paths.filter((path) => /\.html?$/i.test(path))
  if (pages.length === 0) return null
  const depth = (path: string): number => path.split('/').length
  const byDepth = (a: string, b: string): number => depth(a) - depth(b) || a.localeCompare(b)
  if (pages.some((path) => path.toLowerCase() === 'index.html')) return pages.find((path) => path.toLowerCase() === 'index.html') ?? null
  for (const dir of ['docs', 'public', 'site', 'dist', 'build', 'src']) {
    const found = pages.find((path) => path.toLowerCase() === `${dir}/index.html`)
    if (found) return found
  }
  const indexes = pages.filter((path) => /(^|\/)index\.html?$/i.test(path)).sort(byDepth)
  return indexes[0] ?? [...pages].sort(byDepth)[0]
}

/** La page d'accueil à afficher pour ce dépôt, changements préparés compris (`null` : aucune page web). */
export function githubPreviewEntry(fullName: string): string | null {
  return findPreviewEntry(listPaths(requireSession(fullName)))
}

/**
 * Un fichier du dépôt pour l'aperçu (étape 287) : la version PRÉPARÉE par Jaris si elle existe — c'est elle que Léo
 * veut essayer avant d'enregistrer —, sinon celle de GitHub. `undefined` : pas de tel fichier (ou supprimé).
 */
export async function readGithubPreviewFile(fullName: string, path: string): Promise<Buffer | string | undefined> {
  const session = findSession(fullName)
  if (!session) return undefined
  if (session.staged.has(path)) return session.staged.get(path) ?? undefined
  const file = session.snapshot.files.find((entry) => entry.path === path)
  if (!file) return undefined
  if (!session.previewFiles.has(file.sha)) {
    session.previewFiles.set(file.sha, await withClient((github) => github.readBytes(session.snapshot, file)))
  }
  return session.previewFiles.get(file.sha) ?? undefined
}

export function discardGithubChanges(fullName: string, path?: string): RepoView {
  const session = requireSession(fullName)
  if (session.busy) throw new GithubError(0, t('github.err.busyUndo'))
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
  if (session.busy) throw new GithubError(0, t('github.err.busySave'))
  // Filet : des suppressions préparées autrement que par l'agent ne doivent pas non plus vider la branche.
  keepBranchNonEmpty(session)
  const changes = [...session.staged.entries()].map(([path, content]) => ({ path, content }))
  if (changes.length === 0) throw new GithubError(0, t('github.err.noChanges'))
  const text = message.trim() || t('github.defaultCommit')
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
  // Plus rien à y reprendre : la nouvelle version n'a plus les mêmes empreintes (et la mémoire ne grossit pas).
  session.previewFiles.clear()
  try {
    session.snapshot = await withClient((github) => github.openRepo(session.snapshot.fullName, session.snapshot.branch))
  } catch {
    // Relecture impossible (réseau) : le dépôt sera rouvert depuis GitHub à la prochaine demande, jamais réutilisé
    // avec l'ancienne base, qui ferait refuser le commit suivant.
    sessions.delete(session.snapshot.fullName)
  }
  return { sha: result.sha, url: result.url, view: viewOf(session) }
}

