import { randomUUID } from 'crypto'
import { converse, type ConverseRestrictions } from './assistant'
import { generateApp } from './codeGenerator'
import { createGeneratedAppPreview } from './generatedAppPreview'
import {
  duelMachine,
  getDuelCandidates,
  getDuelModelList,
  pickModelsForDuelCategory,
  type DuelCandidate
} from './hardwareScan'
import { deleteModel, listInstalledModels, pullModelIfMissing } from './ollama'
import { getProfile, patchProfile } from './profileStore'
import { DISK_SAFETY_MARGIN_GB, detectFreeDiskGb } from './systemResources'
import { TOOLS } from './tools'
import { synthesizeSpeech } from './tts'
import { addDuelVote, getDuelVotes, readDuelApp, saveDuelApp } from './duelStore'
import {
  DUEL_CATEGORIES,
  DUEL_HISTORY_TEXT_MAX,
  DUEL_MIN_CHOSEN,
  DUEL_MIN_MODELS,
  DUEL_SESSION_SIZES,
  duelActionFromLog,
  isJarisToolFailure,
  nextDuelPair,
  pairKey,
  rankDuels,
  selectDuelModels,
  type DuelCategory,
  type DuelOutcome,
  type DuelSide,
  type DuelVoteSide
} from '../../shared/duel'
import type {
  CodeGenProgress,
  DuelActivity,
  DuelHistoryEntry,
  DuelPlan,
  DuelRankingView,
  DuelSessionView,
  DuelSideView,
  DuelStandingView,
  DuelSummary,
  Profile
} from '../../shared/ipc'
import { t } from '../../shared/i18n'

/**
 * Étape 355 — le Duel. Léo : « un bouton duel, une session télécharge 4-6 modèles qui tiennent, anonymes, on choisit
 * conversation, code ou vocal, et on vote » ; puis « si on lui dit ouvre bloc-notes, il va voir si un modèle a vraiment
 * ouvert ou pas sur son PC ». Chaque modèle d'un duel fait donc VRAIMENT ce qu'il dit, sur le PC, l'un après l'autre :
 * A d'abord, puis B quand Léo a vérifié. Les noms restent ici : l'écran ne reçoit que « A » et « B » jusqu'à la fin.
 */

/** Ce que Jaris ne fait jamais pendant un duel : un modèle qui se trompe ne doit pas éteindre le PC de Léo. */
export const DUEL_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(['shutdown_pc'])

function duelRestrictions(model: string, onToolFailure?: ConverseRestrictions['onToolFailure']): ConverseRestrictions {
  return {
    allowedTools: new Set(TOOLS.map((tool) => tool.function.name).filter((name) => !DUEL_FORBIDDEN_TOOLS.has(name))),
    // Aucune consigne de plus : le modèle doit répondre exactement comme en usage normal.
    note: '',
    get refusal() {
      return t('duel.refusal')
    },
    model,
    modelOnly: true,
    journalLabel: 'duel',
    onToolFailure
  }
}

interface SideState extends DuelSideView {
  /** Duel Vocal : la réponse lue, gardée ici (l'écran la demande par getDuelAudio). */
  audioData: Buffer | null
  /** Duel Code : l'application écrite, gardée avec le vote pour l'historique. */
  html: string | null
}

interface RoundState {
  number: number
  pair: [string, string]
  prompt: string | null
  sides: Record<DuelSide, SideState>
  /** Étape 358 : noms révélés après le vote, comme sur Arena. */
  revealed: { a: string; b: string; outcome: DuelOutcome } | null
}

interface Session {
  id: string
  category: DuelCategory
  phase: DuelSessionView['phase']
  /** Les modèles de la session, dans l'ordre où ils ont été choisis. */
  models: string[]
  /** Ceux que la session a téléchargés (proposés à la suppression à la fin). */
  downloaded: Map<string, number>
  preparing: DuelSessionView['preparing']
  dropped: number
  played: Map<string, number>
  last: [string, string] | null
  round: RoundState | null
  history: DuelSummary['rounds']
  error: string | null
}

export interface DuelEnvironment {
  /** Un rappel programmé par un modèle sonne comme un vrai (main.ts, fireReminder). */
  onReminderFire: (message: string) => void
  /** Prévient l'écran d'un nouvel état de la session (`null` = plus de session). */
  emit: (view: DuelSessionView | null) => void
}

let environment: DuelEnvironment = { onReminderFire: () => {}, emit: () => {} }
export function setDuelEnvironment(env: DuelEnvironment): void {
  environment = env
}

let session: Session | null = null
let runController: AbortController | null = null
let prepareController: AbortController | null = null
let emitTimer: ReturnType<typeof setTimeout> | null = null

function emptySide(): SideState {
  return {
    status: 'idle',
    text: '',
    activity: null,
    startedAt: null,
    durationMs: null,
    actions: [],
    previewUrl: null,
    audio: false,
    audioError: null,
    error: null,
    trouble: null,
    audioData: null,
    html: null
  }
}

function sideView(side: SideState): DuelSideView {
  const { audioData: _audio, html: _html, ...view } = side
  return view
}

export function getDuelView(): DuelSessionView | null {
  if (!session) return null
  const round = session.round
  return {
    id: session.id,
    category: session.category,
    phase: session.phase,
    modelCount: session.models.length,
    preparing: session.preparing,
    dropped: session.dropped,
    votes: session.history.length,
    round: round
      ? { number: round.number, prompt: round.prompt, a: sideView(round.sides.a), b: sideView(round.sides.b), revealed: round.revealed }
      : null,
    error: session.error
  }
}

/** Envoie l'état tout de suite (changement d'étape). */
function emitNow(): void {
  if (emitTimer) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  environment.emit(getDuelView())
}

/** Pendant qu'une réponse s'écrit : au plus un envoi tous les 120 ms, pas un par mot. */
function emitSoon(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    environment.emit(getDuelView())
  }, 120)
}

const sameModel = (a: string, b: string): boolean => a.replace(/:latest$/, '') === b.replace(/:latest$/, '')

function isInstalled(model: string, installed: readonly string[]): boolean {
  return installed.some((m) => sameModel(m, model))
}

/** Le classement d'une catégorie, tous les votes compris. */
export function duelRanking(category: DuelCategory): DuelStandingView[] {
  const votes = getDuelVotes().filter((v) => v.category === category)
  // Le même classement que le choix des modèles (duelStrength, hardwareScan.ts) : tous partent de 0 (étape 358).
  return [...rankDuels(votes).values()].sort((a, b) => b.score - a.score)
}

export function duelRankings(): DuelRankingView[] {
  return DUEL_CATEGORIES.map((category) => ({
    category,
    votes: getDuelVotes().filter((v) => v.category === category).length,
    ranking: duelRanking(category)
  }))
}

async function candidatesFor(category: DuelCategory, profile: Profile | null): Promise<DuelCandidate[]> {
  return getDuelCandidates(category, profile)
}

/** Ce qu'une session proposerait, taille par taille, avant de la lancer : rien n'est téléchargé ici. */
export async function planDuel(category: DuelCategory): Promise<DuelPlan> {
  const profile = await getProfile()
  const [candidates, installed, freeDiskGb, machine, list] = await Promise.all([
    candidatesFor(category, profile),
    listInstalledModels().catch(() => [] as string[]),
    detectFreeDiskGb().catch(() => null),
    duelMachine(),
    getDuelModelList(category, profile)
  ])
  const sizeOf = new Map(candidates.map((c) => [c.model, c.vramGb]))
  const counts = [...new Set(DUEL_SESSION_SIZES.map((size) => Math.min(size, candidates.length)))].filter((n) => n >= DUEL_MIN_MODELS)
  return {
    category,
    available: candidates.length,
    freeDiskGb,
    machine,
    models: list.map((option) => ({ ...option, installed: isInstalled(option.model, installed) })),
    downloadBudgetGb: freeDiskGb === null ? null : Math.max(0, freeDiskGb - DISK_SAFETY_MARGIN_GB),
    sizes: counts.map((count) => {
      const missing = selectDuelModels(candidates, count).filter((m) => !isInstalled(m, installed))
      const downloadGb = missing.reduce((sum, m) => sum + (sizeOf.get(m) ?? 0), 0)
      return {
        count,
        toDownload: missing.length,
        downloadGb,
        fitsDisk: freeDiskGb === null || downloadGb <= Math.max(0, freeDiskGb - DISK_SAFETY_MARGIN_GB)
      }
    })
  }
}

function busy(): boolean {
  return Boolean(session && session.phase !== 'ended')
}

/**
 * Lance une session : choisit les modèles (exactement ceux annoncés par planDuel), télécharge ceux qui manquent sans
 * jamais en dire le nom, puis prépare le premier duel. Un modèle qui ne peut pas être téléchargé (place, réseau) est
 * retiré de la session, sans son nom non plus.
 *
 * Étape 363 : `pick` est soit un nombre (modèles au hasard), soit la liste des modèles choisis à la main. Une liste
 * venue de l'écran n'est jamais crue telle quelle : chaque nom doit être un modèle DISPONIBLE pour un duel sur ce PC,
 * et il en faut au moins DUEL_MIN_CHOSEN.
 */
export async function startDuel(category: DuelCategory, pick: number | readonly string[]): Promise<DuelSessionView> {
  if (busy()) throw new Error(t('duel.error.alreadyRunning'))
  const profile = await getProfile()
  const candidates = await candidatesFor(category, profile)
  let chosen: string[]
  if (typeof pick === 'number') {
    chosen = selectDuelModels(candidates, pick)
    if (chosen.length < DUEL_MIN_MODELS) throw new Error(t('duel.notEnough'))
  } else {
    const available = new Set(candidates.map((c) => c.model))
    chosen = [...new Set(pick)]
    if (chosen.some((m) => !available.has(m))) throw new Error(t('duel.error.notAvailable'))
    if (chosen.length < DUEL_MIN_CHOSEN) throw new Error(t('duel.error.chooseMin', { min: DUEL_MIN_CHOSEN }))
  }
  const installed = await listInstalledModels().catch(() => [] as string[])
  const missing = chosen.filter((m) => !isInstalled(m, installed))
  const sizeOf = new Map(candidates.map((c) => [c.model, c.vramGb]))
  // L'ordre des modèles est mélangé : la position dans la session ne dit rien de qui ils sont.
  const shuffled = [...chosen].sort(() => Math.random() - 0.5)
  session = {
    id: randomUUID(),
    category,
    phase: 'preparing',
    models: shuffled,
    downloaded: new Map(),
    preparing: missing.length ? { done: 0, total: missing.length, percent: null } : null,
    dropped: 0,
    played: new Map(),
    last: null,
    round: null,
    history: [],
    error: null
  }
  const current = session
  emitNow()
  void prepare(current, missing, sizeOf)
  return getDuelView() as DuelSessionView
}

async function prepare(current: Session, missing: string[], sizeOf: Map<string, number>): Promise<void> {
  prepareController = new AbortController()
  const signal = prepareController.signal
  for (const [index, model] of missing.entries()) {
    if (signal.aborted || session !== current) return
    current.preparing = { done: index, total: missing.length, percent: 0 }
    emitNow()
    try {
      // Aucun message de téléchargement transmis : ils portent le nom du modèle.
      await pullModelIfMissing(
        model,
        undefined,
        (progress) => {
          if (!progress || session !== current) return
          current.preparing = { done: index, total: missing.length, percent: progress.percent }
          emitSoon()
        },
        signal
      )
      current.downloaded.set(model, sizeOf.get(model) ?? 0)
    } catch (err) {
      if (signal.aborted) return
      console.error('[jaris] Duel : modèle non téléchargé —', err)
      current.models = current.models.filter((m) => m !== model)
      current.dropped += 1
    }
  }
  if (session !== current || signal.aborted) return
  current.preparing = null
  if (current.models.length < DUEL_MIN_MODELS) {
    current.phase = 'ended'
    current.error = t('duel.error.downloads')
  } else {
    current.phase = 'ready'
    nextRound(current)
  }
  prepareController = null
  emitNow()
}

function nextRound(current: Session): void {
  const pair = nextDuelPair(current.models, current.played, current.last)
  if (!pair) {
    current.round = null
    return
  }
  current.round = { number: current.history.length + 1, pair, prompt: null, sides: { a: emptySide(), b: emptySide() }, revealed: null }
}

function sideFinished(side: SideState): boolean {
  return side.status === 'done' || side.status === 'error' || side.status === 'stopped'
}

/**
 * Un message d'erreur d'Ollama nomme souvent le modèle (« model 'qwen3.5:9b' not found », « Réponse vide d'Ollama
 * (modèle '…') ») : affiché tel quel, il révélerait qui est A ou B. Chaque nom de la session y devient « Modèle A »,
 * « Modèle B », ou « … » pour un autre modèle de la session. Le texte écrit par le modèle lui-même n'est pas touché.
 */
export function withoutModelNames(text: string, models: readonly string[], pair: readonly [string, string]): string {
  const all = [...new Set([...models, ...pair])]
  // La famille seule (« qwen3.5 » de « qwen3.5:9b ») révèle aussi le modèle — « … » quand deux modèles la partagent.
  const familyOf = (model: string): string => {
    const colon = model.lastIndexOf(':')
    return colon > 0 ? model.slice(0, colon) : model
  }
  const replacements: Array<[string, string]> = []
  for (const model of all) {
    const label = model === pair[0] ? t('duel.side.a') : model === pair[1] ? t('duel.side.b') : '…'
    const family = familyOf(model)
    const shared = all.filter((other) => familyOf(other) === family).length > 1
    for (const variant of new Set([model, `${family}:latest`])) replacements.push([variant, label])
    replacements.push([family, shared ? '…' : label])
  }
  // Les plus longs d'abord : « qwen3.5:9b » avant « qwen3.5 », sinon il resterait « …:9b ».
  replacements.sort((x, y) => y[0].length - x[0].length)
  let out = text
  for (const [variant, label] of replacements) out = out.split(variant).join(label)
  return out
}

/** Léo pose la demande du duel : le modèle A répond tout de suite. */
export function askDuel(prompt: string): DuelSessionView {
  const current = session
  const text = prompt.trim()
  if (!current || current.phase !== 'ready' || !current.round) throw new Error(t('duel.error.noRound'))
  if (current.round.prompt !== null) throw new Error(t('duel.error.alreadyAsked'))
  if (!text) throw new Error(t('duel.error.emptyPrompt'))
  current.round.prompt = text
  void runSide(current, current.round, 'a')
  return getDuelView() as DuelSessionView
}

/** Le tour du modèle B, quand Léo a vérifié ce que A a fait. */
export function runDuelB(): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (!sideFinished(round.sides.a) || round.sides.b.status !== 'idle') throw new Error(t('duel.error.notYourTurn'))
  void runSide(current, round, 'b')
  return getDuelView() as DuelSessionView
}

export function stopDuelRun(): void {
  runController?.abort()
}

async function runSide(current: Session, round: RoundState, sideName: DuelSide): Promise<void> {
  const side = round.sides[sideName]
  const model = round.pair[sideName === 'a' ? 0 : 1]
  const prompt = round.prompt as string
  runController?.abort()
  const controller = new AbortController()
  runController = controller
  side.status = 'running'
  side.startedAt = Date.now()
  side.activity = { kind: current.category === 'code' ? 'loading' : 'thinking' }
  emitNow()
  try {
    if (current.category === 'code') await runCode(current, side, model, prompt, controller.signal)
    else await runConversation(current, side, model, prompt, controller.signal)
    if (controller.signal.aborted) side.status = 'stopped'
    else side.status = 'done'
  } catch (err) {
    if (controller.signal.aborted) side.status = 'stopped'
    else {
      side.status = 'error'
      side.error = withoutModelNames(err instanceof Error ? err.message : String(err), current.models, round.pair)
    }
  } finally {
    side.activity = null
    side.durationMs = side.startedAt === null ? null : Date.now() - side.startedAt
    if (runController === controller) runController = null
    if (session === current) emitNow()
  }
}

async function runConversation(current: Session, side: SideState, model: string, prompt: string, signal: AbortSignal): Promise<void> {
  const profile = await getProfile()
  const channel = current.category === 'voice' ? 'voice' : 'chat'
  let streamed = ''
  const reply = await converse(
    prompt,
    profile?.name ?? null,
    environment.onReminderFire,
    (line) => {
      const action = duelActionFromLog(line)
      if (action) {
        side.actions.push(action)
        side.activity = { kind: 'action', action }
      } else if (/^Résultat de l'outil/u.test(line)) {
        side.activity = { kind: 'thinking' }
      }
      emitSoon()
    },
    [],
    signal,
    undefined,
    channel,
    (delta) => {
      streamed += delta
      side.text = streamed
      side.activity = { kind: 'writing' }
      emitSoon()
    },
    undefined,
    undefined,
    duelRestrictions(model, (tool, error) => {
      if (side.trouble) return
      const name = error instanceof Error ? error.name : null
      if (!isJarisToolFailure(tool, name)) return
      const message = error instanceof Error ? error.message : String(error)
      side.trouble = { tool, message: withoutModelNames(message, current.models, current.round?.pair ?? ['', '']).slice(0, 400) }
      emitSoon()
    })
  )
  // Un outil de Jaris en panne : la réponse est souvent son message d'erreur (écrit par Jaris, pas par le modèle), qui
  // peut nommer un modèle — masqué comme les autres erreurs.
  side.text = side.trouble ? withoutModelNames(reply, current.models, current.round?.pair ?? ['', '']) : reply
  // Duel Vocal : la réponse est lue par la voix de Jaris, comme à l'Agent vocal. Une voix en panne n'efface jamais la
  // réponse écrite : Léo peut toujours voter dessus.
  if (current.category === 'voice' && !signal.aborted && reply.trim()) {
    try {
      side.audioData = await synthesizeSpeech(reply)
      side.audio = true
    } catch (err) {
      side.audioError = err instanceof Error ? err.message : String(err)
    }
  }
}

function codeActivity(progress: CodeGenProgress): DuelActivity {
  return { kind: progress.phase }
}

async function runCode(_current: Session, side: SideState, model: string, prompt: string, signal: AbortSignal): Promise<void> {
  const app = await generateApp(prompt, () => {}, undefined, undefined, {
    model,
    persist: false,
    signal,
    onProgress: (progress) => {
      side.activity = codeActivity(progress)
      emitSoon()
    }
  })
  side.html = app.html
  side.previewUrl = createGeneratedAppPreview(app.html)
  side.text = app.issues.length ? app.issues.join('\n') : ''
}

/** La réponse lue d'un côté (duel Vocal), pour que l'écran la joue. */
export function duelAudio(sideName: DuelSide): Uint8Array | null {
  const data = session?.round?.sides[sideName].audioData
  return data ? new Uint8Array(data) : null
}

/**
 * Le vote de Léo. Étape 358 (« pour noms révélés, fais après chaque vote, comme Arena ») : les noms des deux modèles
 * sont révélés tout de suite ; le duel suivant attend que Léo les ait vus (nextDuel). Le vote est enregistré AVANT de
 * révéler quoi que ce soit : seuls les votes donnés à l'aveugle comptent.
 */
export async function voteDuel(outcome: DuelOutcome): Promise<DuelSessionView> {
  const current = session
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.revealed) throw new Error(t('duel.error.alreadyVoted'))
  // Un outil de Jaris a échoué : ce duel ne dit rien des modèles, il se rejoue ou se passe (retryDuel, skipDuel).
  if (round.sides.a.trouble || round.sides.b.trouble) throw new Error(t('duel.error.trouble'))
  if (!sideFinished(round.sides.a) || !sideFinished(round.sides.b)) throw new Error(t('duel.error.notFinished'))
  const [modelA, modelB] = round.pair
  const id = randomUUID()
  const keep = async (name: DuelSide): Promise<DuelVoteSide> => {
    const side = round.sides[name]
    let app = false
    if (side.html) {
      try {
        await saveDuelApp(id, name, side.html)
        app = true
      } catch (err) {
        // L'historique perd l'application, jamais le vote.
        console.error('[jaris] Duel : application non gardée pour l’historique —', err)
      }
    }
    return {
      text: side.text.slice(0, DUEL_HISTORY_TEXT_MAX),
      actions: side.actions,
      durationMs: side.durationMs,
      error: side.error,
      app
    }
  }
  const sides = { a: await keep('a'), b: await keep('b') }
  await addDuelVote({
    id,
    category: current.category,
    at: Date.now(),
    sessionId: current.id,
    modelA,
    modelB,
    outcome,
    prompt: round.prompt,
    sides
  })
  if (session !== current) return getDuelView() as DuelSessionView
  current.history.push({ prompt: round.prompt, modelA, modelB, outcome })
  const key = pairKey(modelA, modelB)
  current.played.set(key, (current.played.get(key) ?? 0) + 1)
  current.last = round.pair
  round.revealed = { a: modelA, b: modelB, outcome }
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Après la révélation des noms : le duel suivant (une autre paire). */
export function nextDuel(): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || !round.revealed) throw new Error(t('duel.error.noRound'))
  nextRound(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Un duel gâché par un outil de Jaris : les deux modèles le refont, même paire, même demande, A d'abord. */
export function retryDuel(): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.sides.a.status === 'running' || round.sides.b.status === 'running') throw new Error(t('duel.error.notFinished'))
  if (!round.sides.a.trouble && !round.sides.b.trouble) throw new Error(t('duel.error.badRequest'))
  round.sides = { a: emptySide(), b: emptySide() }
  void runSide(current, round, 'a')
  return getDuelView() as DuelSessionView
}

/** Passe un duel gâché par un outil de Jaris, sans vote : une autre paire prend sa place. */
export function skipDuel(): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.sides.a.status === 'running' || round.sides.b.status === 'running') throw new Error(t('duel.error.notFinished'))
  if (!round.sides.a.trouble && !round.sides.b.trouble) throw new Error(t('duel.error.badRequest'))
  current.last = round.pair
  nextRound(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Tous les duels votés, du plus récent au plus ancien, noms compris : ils sont révélés dès le vote (étape 358). */
export function duelHistory(): DuelHistoryEntry[] {
  return [...getDuelVotes()]
    .sort((x, y) => y.at - x.at)
    .map((vote) => ({
      id: vote.id,
      category: vote.category,
      at: vote.at,
      prompt: vote.prompt,
      outcome: vote.outcome,
      modelA: vote.modelA,
      modelB: vote.modelB,
      sides: vote.sides ?? null
    }))
}

/** L'application d'un duel Code de l'historique, dans l'aperçu isolé (`null` si elle n'a pas été gardée). */
export async function duelHistoryApp(voteId: string, side: DuelSide): Promise<string | null> {
  if (!getDuelVotes().some((v) => v.id === voteId)) return null
  const html = await readDuelApp(voteId, side)
  return html === null ? null : createGeneratedAppPreview(html)
}

/**
 * Étape 364 : le code d'une application du duel en cours, demandé au clic (jamais dans la vue envoyée à chaque mise à
 * jour, trop lourde). Seulement une fois ce côté fini, et sans le nom d'un modèle avant la révélation.
 */
export function duelSideCode(name: DuelSide): string | null {
  const current = session
  const round = current?.round
  if (!current || !round || current.category !== 'code') return null
  const side = round.sides[name]
  if (!side.html || !sideFinished(side)) return null
  return withoutModelNames(side.html, current.models, round.pair)
}

/** Le code d'une application d'un duel Code de l'historique (`null` si elle n'a pas été gardée). */
export async function duelHistoryCode(voteId: string, side: DuelSide): Promise<string | null> {
  if (!getDuelVotes().some((v) => v.id === voteId)) return null
  return readDuelApp(voteId, side)
}

const ROLES = ['flash', 'medium', 'large'] as const

/**
 * Fin de session : les noms sont révélés, le classement est recalculé, et le choix de Jaris suit les votes — tout de
 * suite pour un modèle déjà installé (ceux de la session le sont), sinon au prochain « Retester la configuration ».
 */
export async function endDuel(): Promise<DuelSummary> {
  const current = session
  if (!current) throw new Error(t('duel.error.noSession'))
  prepareController?.abort()
  runController?.abort()
  current.phase = 'ended'
  current.preparing = null
  current.round = null
  emitNow()

  const profile = await getProfile()
  const installed = await listInstalledModels().catch(() => [] as string[])
  const changes: DuelSummary['changes'] = []
  if (current.history.length && profile) {
    // Étape 360 : un modèle en service n'est remplacé que s'il est PROUVÉ moins bon (comparaison directe).
    const picks = await pickModelsForDuelCategory(current.category, profile)
    if (current.category === 'code') {
      if (!profile.codeModel || !sameModel(profile.codeModel, picks.code)) {
        const applied = isInstalled(picks.code, installed)
        changes.push({ role: 'code', from: profile.codeModel ?? null, to: picks.code, applied })
        if (applied) await patchProfile({ codeModel: picks.code })
      }
    } else {
      const before = (current.category === 'voice' ? profile.voiceModels ?? profile.models : profile.models) ?? null
      const next = { ...(before ?? { flash: picks.flash, medium: picks.medium, large: picks.large }) }
      for (const role of ROLES) {
        if (before && sameModel(before[role], picks[role])) continue
        const applied = isInstalled(picks[role], installed)
        changes.push({ role, from: before?.[role] ?? null, to: picks[role], applied })
        if (applied) next[role] = picks[role]
      }
      if (changes.some((c) => c.applied)) {
        if (current.category === 'voice') {
          const chat = profile.models
          const same = chat && ROLES.every((r) => sameModel(chat[r], next[r]))
          await patchProfile({ voiceModels: same ? undefined : next })
        } else {
          await patchProfile({ models: next })
        }
      }
    }
  }

  const updated = await getProfile()
  const used = new Set(
    [
      ...Object.values(updated?.models ?? {}),
      ...Object.values(updated?.voiceModels ?? {}),
      updated?.visionModel,
      updated?.codeModel,
      updated?.pilotModel,
      ...Object.values(updated?.modelChoices ?? {})
    ].filter((m): m is string => Boolean(m))
  )
  return {
    category: current.category,
    rounds: current.history,
    ranking: duelRanking(current.category),
    changes,
    downloaded: [...current.downloaded].map(([model, sizeGb]) => ({
      model,
      sizeGb,
      inUse: [...used].some((u) => sameModel(u, model))
    }))
  }
}

/**
 * Supprime les modèles téléchargés pour la session terminée — seulement ceux-là, et jamais un modèle dont Jaris se
 * sert (revérifié ici : la liste vient de l'écran).
 */
export async function deleteDuelModels(models: string[]): Promise<{ deleted: string[]; failed: { model: string; error: string }[] }> {
  const current = session
  if (!current || current.phase !== 'ended') throw new Error(t('duel.error.noSession'))
  const profile = await getProfile()
  const used = [
    ...Object.values(profile?.models ?? {}),
    ...Object.values(profile?.voiceModels ?? {}),
    profile?.visionModel,
    profile?.codeModel,
    profile?.pilotModel,
    ...Object.values(profile?.modelChoices ?? {})
  ].filter((m): m is string => Boolean(m))
  const deleted: string[] = []
  const failed: { model: string; error: string }[] = []
  for (const model of models) {
    if (!current.downloaded.has(model) || used.some((u) => sameModel(u, model))) continue
    try {
      await deleteModel(model)
      current.downloaded.delete(model)
      deleted.push(model)
    } catch (err) {
      failed.push({ model, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { deleted, failed }
}

/** Oublie la session terminée (l'écran revient au choix de la catégorie). */
export function closeDuel(): void {
  if (busy()) return
  session = null
  emitNow()
}

/** Fermeture de Jaris ou « Déplacer » : tout ce qui tourne s'arrête, rien n'est voté à la place de Léo. */
export function abortDuel(): void {
  prepareController?.abort()
  runController?.abort()
}
