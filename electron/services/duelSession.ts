import { randomUUID } from 'crypto'
import { config, runWithLocalOllama, runWithOllamaHost } from '../config'
import { connectedMachine, machineFreeDiskGb } from './remoteMachine'
import { converse, type ConverseRestrictions } from './assistant'
import { generateApp } from './codeGenerator'
import { createGeneratedAppPreview } from './generatedAppPreview'
import { imageDrawingAvailable } from './imageGenerator'
import {
  duelMachine,
  getDuelCandidates,
  getDuelModelList,
  imageReadingModels,
  pickModelsForDuelCategory,
  type DuelCandidate,
  type DuelMachineOverride
} from './hardwareScan'
import { chatWithOllama, deleteModel, fetchOllamaVersion, type OllamaMessage, getModelThinking, listInstalledModels, loadedOllamaModels, pullModelIfMissing, repairModelsViewIfNeeded } from './ollama'
import { getProfile, patchProfile } from './profileStore'
import { DISK_SAFETY_MARGIN_GB, detectFreeDiskGb } from './systemResources'
import { TOOLS } from './tools'
import { synthesizeSpeech } from './tts'
import {
  addDuelReview,
  addDuelVote,
  decideDuelReview,
  deleteDuelVotes,
  getDuelReviews,
  getDuelVotes,
  getAllDuelVotes,
  getRankingVotes,
  countPendingDuelVotes,
  readDuelApp,
  saveDuelApp
} from './duelStore'
import { loadClaudeKey } from './claudeKey'
import { JUDGE_MODEL, JudgeRefusalError, JudgeStopError, adviseCodeDuel, adviseVisionDuel as askClaudeVisionAdvice, judgeDuel, writeDuelQuestion, type DuelScreens, type JudgedSide } from './duelJudge'
import {
  SERIES_FORMAT,
  SERIES_VERSION,
  clearSeries,
  loadSeries,
  readSeriesApp,
  saveSeries,
  saveSeriesApp,
  type SeriesSideSnapshot,
  type SeriesSnapshot
} from './duelSeriesStore'
import {
  DUEL_CATEGORIES,
  DUEL_FORBIDDEN_TOOLS,
  DUEL_FOLLOW_UP_MAX_CHARS,
  DUEL_VISION_IMAGE_MAX_CHARS,
  DUEL_HISTORY_TEXT_MAX,
  DUEL_MAX_FOLLOW_UPS,
  DUEL_MIN_CHOSEN,
  DUEL_MIN_MODELS,
  DUEL_BATCH_MAX,
  DUEL_BATCH_MIN,
  DUEL_SESSION_SIZES,
  DUEL_CODE_IDEAS,
  DUEL_CODE_NUM_CTX,
  remoteThreadsFor,
  batchSlotsToStart,
  seriesRoomForModel,
  seriesNewModelFits,
  seriesModelNeedGb,
  seriesPlacementFrom,
  DUEL_SERIES_SLOTS_PER_MODEL,
  type SeriesPlacement,
  isDuelSeriesCount,
  isDuelAdviceEffort,
  isDuelAdviceModel,
  planDuelSeries,
  baseModelTag,
  countDuelPairs,
  countDuelsByModel,
  canRunDuelTogether,
  duelActionFromLog,
  duelOfferedTools,
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
  DuelReviewView,
  DuelSessionView,
  DuelSideView,
  DuelStandingView,
  DuelSummary,
  DuelAdvice,
  Profile
} from '../../shared/ipc'
import { formatDecimal, replyLanguageRule, t, tn, type MessageKey } from '../../shared/i18n'
import { equivalentThink, type ThinkValue } from '../../shared/effort'

/**
 * Étape 355 — le Duel. Léo : « un bouton duel, une session télécharge 4-6 modèles qui tiennent, anonymes, on choisit
 * conversation, code ou vocal, et on vote » ; puis « si on lui dit ouvre bloc-notes, il va voir si un modèle a vraiment
 * ouvert ou pas sur son PC ». Chaque modèle d'un duel fait donc VRAIMENT ce qu'il dit, sur le PC, l'un après l'autre :
 * A d'abord, puis B quand Léo a vérifié. Les noms restent ici : l'écran ne reçoit que « A » et « B » jusqu'à la fin.
 */

/**
 * Étape 365 (Léo : « ça se fait pas un modèle avec raisonnement low et un autre max et un autre qui n'en a pas ») : la
 * réflexion demandée à TOUS les modèles d'un duel, choisie par Léo — « moyen », comme les tests d'appel d'outils —,
 * traduite dans les réglages de chacun (equivalentThink, shared/effort.ts).
 */
export const DUEL_THINK_LEVEL = 'medium'

function duelRestrictions(
  model: string,
  think: ThinkValue,
  tools: ReadonlySet<string>,
  onToolFailure?: ConverseRestrictions['onToolFailure'],
  remote = false
): ConverseRestrictions {
  return {
    // Étape 377 : le modèle tourne sur une autre machine, mais les outils de Jaris (regarder l'écran, dessiner…) restent
    // ceux de CE PC, avec son Ollama à lui.
    ...(remote ? { runTool: runWithLocalOllama } : {}),
    think,
    allowedTools: tools,
    // Aucune consigne de plus : le modèle doit répondre exactement comme en usage normal.
    note: '',
    get refusal() {
      return t('duel.refusal')
    },
    // Étape 366 : un outil absent de ce PC n'est pas « éteindre le PC » — chacun son refus.
    refusalFor: (tool) => (DUEL_FORBIDDEN_TOOLS.has(tool) ? t('duel.refusal') : t('duel.toolUnavailable')),
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
  /** Étape 382 : nouveaux essais après une panne de la machine (Ollama arrêté, modèle introuvable) pendant une série. */
  retries: number
  /**
   * Étape 399 : les appels d'outils ET ce que chaque outil a répondu, pour que Claude juge ce qui a vraiment été fait
   * (pas seulement ce que le modèle affirme). Sans noms de modèles, raccourcis ; jamais montrés à l'écran.
   */
  toolLog: string[]
  /**
   * Étape 415 : duel Code, deuxième message de Léo — l'application que CE modèle a écrite au tour d'avant, qu'il
   * modifie (même chemin que « modifier l'application » du mode Code). `null` : rien à modifier.
   */
  baseHtml: string | null
  /** Étape 416 : « Écrire le code maintenant » pour la génération en cours de ce côté (`null` hors génération). */
  writeNow: AbortController | null
}

interface RoundState {
  number: number
  pair: [string, string]
  prompt: string | null
  /** Étape 401 : ce que Léo a répondu aux deux modèles depuis la demande (même message aux deux), dans l'ordre. */
  followUps: string[]
  sides: Record<DuelSide, SideState>
  /** Étape 358 : noms révélés après le vote, comme sur Arena. Étape 458 : avec l'identifiant du vote (fichier du duel). */
  revealed: { a: string; b: string; outcome: DuelOutcome; voteId?: string } | null
  /** Étape 379 : A et B travaillent en même temps (canRunDuelTogether). */
  together: boolean
  /**
   * Étape 366 : les outils proposés pendant CE duel — ceux que ce PC peut faire tourner —, lus avant le tour de A et
   * gardés pour B : les deux modèles ont exactement les mêmes. `null` tant que A n'a pas commencé.
   */
  tools: ReadonlySet<string> | null
  /**
   * Étape 475 : l'image d'un Duel Vision (base64, sans en-tête), la même pour A et B. Gardée le temps du duel seulement :
   * jamais écrite avec le vote (elle peut être personnelle), seule la consigne l'est. Absente hors Duel Vision.
   */
  image?: string | null
}

/**
 * Étape 377 : la machine qui fait tourner les modèles d'une session, figée à son lancement (changer le réglage pendant
 * une session ne la coupe pas en deux machines).
 */
interface RemoteMachine {
  host: string
  machine: DuelMachineOverride
}

interface Session {
  id: string
  /** `null` = les modèles tournent sur ce PC. */
  remote: RemoteMachine | null
  /**
   * Étape 379 : la mémoire de la carte qui fait tourner les modèles (ce PC ou l'autre machine) et le poids de chaque
   * modèle, pour savoir si A et B tiennent ensemble.
   */
  vramGb: number | null
  sizes: Map<string, number>
  category: DuelCategory
  phase: DuelSessionView['phase']
  /** Les modèles de la session, dans l'ordre où ils ont été choisis. */
  models: string[]
  /** Ceux que la session a téléchargés (proposés à la suppression à la fin). */
  downloaded: Map<string, number>
  preparing: DuelSessionView['preparing']
  dropped: number
  /**
   * Étape 380 : pourquoi le dernier téléchargement a échoué (sans nom de modèle). Avant, seul « moins de deux modèles »
   * s'affichait : impossible de savoir si c'était la place, le réseau ou un Ollama arrêté.
   */
  dropReason: string | null
  played: Map<string, number>
  last: [string, string] | null
  round: RoundState | null
  /**
   * Étape 381 : une file de duels Code lancés d'un coup (`null` = un duel à la fois, comme avant). `round` est alors le
   * duel de la file que Léo a ouvert, ou `null` quand il regarde la liste.
   */
  batch: RoundState[] | null
  /** Étape 382 : une série de duels Code qui tourne sans Léo (`null` = pas de série). */
  series: SeriesState | null
  /** Étape 399 : Claude écrit les demandes et vote (`null` = c'est Léo qui joue). */
  judge: JudgeState | null
  history: DuelSummary['rounds']
  error: string | null
}

/**
 * Étape 382 : ce qu'il faut à une série pour tourner seule — les modèles sur le disque (« présents »), le téléchargement
 * en cours, et pourquoi elle attend.
 */
interface SeriesState {
  createdAt: number
  perModel: number
  /** Les modèles qui peuvent tourner tout de suite (installés, ou téléchargés par la série). */
  present: Set<string>
  /** Modèles à ne pas supprimer (Jaris s'en sert, ou la suppression a échoué une fois). */
  undeletable: Set<string>
  download: { percent: number | null } | null
  waiting: 'ollama' | 'disk' | null
  /** Modèles supprimés par la série après leur dernier duel. */
  deleted: number
  controller: AbortController
  wake: (() => void) | null
  /** Le gardien tourne (un seul à la fois). */
  running: boolean
  /** Étape 388 : le gardien doit repartir dès qu'il s'est arrêté (la série vient de changer de machine). */
  restart: boolean
  /**
   * Un téléchargement a rempli le disque (souvent celui d'une machine louée, dont Jaris ne connaît pas la place libre) :
   * le nombre de modèles supprimés à ce moment-là. On ne réessaie qu'après une nouvelle suppression.
   */
  diskFullAt: number | null
  /**
   * Étape 456 : sur une machine louée, ce qu'Ollama a VRAIMENT chargé pour la série (relu par le gardien), et les modèles
   * lancés depuis, pas encore vus chargés (leur place estimée). `null` sur ce PC : la règle d'avant s'applique.
   */
  placement: SeriesPlacement | null
  pending: Map<string, number>
  /** Étape 457 : le dernier vrai progrès d'un duel (texte écrit, réflexion, côté fini), et le blocage constaté. */
  lastProgressAt: number
  stalledMinutes: number | null
  /** Étape 458 : un modèle tourne sur le processeur alors que les cartes sont presque libres (Ollama, pas la place). */
  cpuFallback: boolean
}

/** Étape 399 : la suite de duels Conversation jugés par Claude. */
interface JudgeState {
  perModel: number
  plan: [string, string][]
  /** Prochain duel du plan. */
  index: number
  judged: number
  skipped: number
  step: 'question' | 'a' | 'b' | 'judge' | null
  last: { outcome: DuelOutcome; reason: string } | null
  /** Les demandes déjà posées, pour que Claude ne se répète pas. */
  prompts: string[]
  /** Léo a choisi de montrer l'écran à Claude : captures avant A, après A, après B. */
  screens: boolean
  controller: AbortController
  finished: boolean
  error: string | null
}

export interface DuelEnvironment {
  /** Un rappel programmé par un modèle sonne comme un vrai (main.ts, fireReminder). */
  onReminderFire: (message: string) => void
  /** Prévient l'écran d'un nouvel état de la session (`null` = plus de session). */
  emit: (view: DuelSessionView | null) => void
  /** Étape 382 : garder le PC éveillé pendant qu'une série tourne (powerSaveBlocker, main.ts). */
  keepAwake?: (on: boolean) => void
  /**
   * Étape 399 : une capture de l'écran (JPEG en base64), sans les fenêtres de Jaris, pour que Claude voie ce que les
   * modèles ont vraiment fait. `null` si la capture échoue : le vote se fait alors sans elle.
   */
  captureScreen?: () => Promise<string | null>
}

let environment: DuelEnvironment = { onReminderFire: () => {}, emit: () => {} }
export function setDuelEnvironment(env: DuelEnvironment): void {
  environment = env
}

let session: Session | null = null
/**
 * Étape 379 : un arrêt par côté — en Code, A et B peuvent travailler en même temps. Étape 381 : rangé par duel ET par
 * côté (« 3:a »), plusieurs duels d'une file tournant en même temps.
 */
const runControllers = new Map<string, AbortController>()
/**
 * Étape 388 : les côtés arrêtés parce que la série change de machine. Ils ne sont ni « arrêtés » ni en erreur : ils
 * repartent de zéro sur la nouvelle machine.
 */
const movingRuns = new Set<string>()
function abortRuns(): void {
  for (const controller of runControllers.values()) controller.abort()
}
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
    html: null,
    retries: 0,
    toolLog: [],
    baseHtml: null,
    writeNow: null,
    earlier: []
  }
}

function sideView(side: SideState): DuelSideView {
  const { audioData: _audio, html: _html, retries: _retries, toolLog: _log, baseHtml: _base, writeNow: _hurry, ...view } = side
  return view
}

export function getDuelView(): DuelSessionView | null {
  if (!session) return null
  const round = session.round
  return {
    id: session.id,
    category: session.category,
    phase: session.phase,
    remote: session.remote !== null,
    modelCount: session.models.length,
    preparing: session.preparing,
    dropped: session.dropped,
    dropReason: session.dropReason,
    votes: session.history.length,
    round: round
      ? {
          number: round.number,
          prompt: round.prompt,
          followUps: round.followUps,
          a: sideView(round.sides.a),
          b: sideView(round.sides.b),
          revealed: round.revealed,
          together: round.together,
          canSwap: swapCandidates(session, round).length > 0 && swapAllowed(session, round)
        }
      : null,
    batch: session.batch
      ? session.batch.map((r) => ({
          number: r.number,
          prompt: r.prompt ?? '',
          a: r.sides.a.status,
          b: r.sides.b.status,
          revealed: r.revealed
        }))
      : null,
    series: session.series
      ? {
          perModel: session.series.perModel,
          download: session.series.download,
          waiting: session.series.waiting,
          deleted: session.series.deleted,
          active: session.series.running,
          stalledMinutes: session.series.stalledMinutes,
          cpuFallback: session.series.cpuFallback
        }
      : null,
    judge: session.judge
      ? {
          total: session.judge.plan.length,
          index: session.judge.index,
          judged: session.judge.judged,
          skipped: session.judge.skipped,
          step: session.judge.step,
          last: session.judge.last,
          finished: session.judge.finished,
          stopped: session.judge.controller.signal.aborted,
          error: session.judge.error
        }
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

/** Le classement d'une catégorie : seulement les votes livrés avec Jaris, le même sur tous les PC (étape 430). */
export function duelRanking(category: DuelCategory): DuelStandingView[] {
  const votes = getRankingVotes().filter((v) => v.category === category)
  // Le même classement que le choix des modèles (duelStrength, hardwareScan.ts) : tous partent de 0 (étape 358).
  return [...rankDuels(votes).values()].sort((a, b) => b.score - a.score)
}

export function duelRankings(): DuelRankingView[] {
  return DUEL_CATEGORIES.map((category) => ({
    category,
    votes: getRankingVotes().filter((v) => v.category === category).length,
    pending: countPendingDuelVotes(category),
    ranking: duelRanking(category)
  }))
}

async function candidatesFor(category: DuelCategory, profile: Profile | null, remote: RemoteMachine | null = null): Promise<DuelCandidate[]> {
  return getDuelCandidates(category, profile, remote?.machine)
}

/** Ce qui doit parler à l'Ollama des modèles : celui de l'autre machine pendant une session à distance, sinon ce PC. */
function onModels<T>(remote: RemoteMachine | null, fn: () => Promise<T>, sizes?: ReadonlyMap<string, number>): Promise<T> {
  // Étape 437 : une session sur CE PC y reste, même si une machine louée est connectée en route.
  if (!remote) return runWithLocalOllama(fn)
  // Étape 387 : quand les modèles écrivent, peu de fils de calcul pour ceux qui tiennent entiers sur la carte.
  const threadsFor = sizes ? (model: string) => remoteThreadsFor(sizes.get(model) ?? Number.NaN, remote.machine.vramGb) : undefined
  return runWithOllamaHost(remote.host, fn, threadsFor)
}

/**
 * Étape 377 : l'autre machine, avec la version de son Ollama — ou l'erreur qui dit pourquoi elle ne répond pas (`machine`
 * est alors celle qu'a donnée Léo, sans version : rien ne peut commencer). Étape 437 : c'est la machine connectée de la
 * page Machine (remoteMachine.ts) ; le Duel n'a plus son propre réglage.
 */
async function remoteMachine(): Promise<{ remote: RemoteMachine; error: string | null; diskGb: number } | null> {
  const settings = connectedMachine()
  if (!settings) return null
  let version: string | null = null
  let error: string | null = null
  try {
    version = await runWithOllamaHost(settings.host, () => fetchOllamaVersion())
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return { remote: { host: settings.host, machine: { vramGb: settings.vramGb, ramGb: settings.ramGb, ollamaVersion: version } }, error, diskGb: settings.diskGb }
}

/** Ce qu'une session proposerait, taille par taille, avant de la lancer : rien n'est téléchargé ici. */
export async function planDuel(category: DuelCategory): Promise<DuelPlan> {
  const profile = await getProfile()
  const away = await remoteMachine()
  const remote = away?.remote ?? null
  const reachable = !away?.error
  const [candidates, installed, freeDiskGb, machine, list] = await Promise.all([
    candidatesFor(category, profile, remote),
    reachable ? onModels(remote, installedModelsSeen) : Promise.resolve([] as string[]),
    // Étape 437 : le disque de la machine louée est connu (taille donnée sur la page Machine, moins ses modèles).
    remote ? (reachable && connectedMachine() ? machineFreeDiskGb(connectedMachine()!) : Promise.resolve(null)) : detectFreeDiskGb().catch(() => null),
    duelMachine(remote?.machine),
    getDuelModelList(category, profile, remote?.machine)
  ])
  const sizeOf = new Map(candidates.map((c) => [c.model, c.vramGb]))
  const done = countDuelsByModel(getAllDuelVotes(), category)
  const counts = [...new Set(DUEL_SESSION_SIZES.map((size) => Math.min(size, candidates.length)))].filter((n) => n >= DUEL_MIN_MODELS)
  return {
    category,
    available: candidates.length,
    freeDiskGb,
    machine,
    models: list.map((option) => ({
      ...option,
      installed: isInstalled(option.model, installed),
      duels: done.get(baseModelTag(option.model)) ?? 0
    })),
    downloadBudgetGb: freeDiskGb === null ? null : Math.max(0, freeDiskGb - DISK_SAFETY_MARGIN_GB),
    remote: away ? { host: away.remote.host, version: away.remote.machine.ollamaVersion, error: away.error } : null,
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

/**
 * Étape 365 : la liste des modèles installés, après la réparation des étapes 289/313 si Ollama n'en voit AUCUN (il
 * regarde alors le mauvais dossier). Sans elle, des modèles déjà sur le PC passaient pour « à télécharger » : l'écran
 * annonçait des téléchargements qui n'avaient pas lieu.
 */
async function installedModelsSeen(): Promise<string[]> {
  const list = await listInstalledModels().catch(() => [] as string[])
  // Étape 377 : la réparation agit sur l'Ollama et le dossier de CE PC, jamais sur ceux d'une autre machine.
  if (list.length || config.ollama.remote || !(await repairModelsViewIfNeeded())) return list
  return listInstalledModels().catch(() => [] as string[])
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
export async function startDuel(
  category: DuelCategory,
  pick: number | readonly string[],
  seriesPerModel?: number,
  judgePerModel?: number,
  judgeScreens = false
): Promise<DuelSessionView> {
  if (busy()) throw new Error(t('duel.error.alreadyRunning'))
  // Étape 399 : Claude juge — duels Conversation seulement, et jamais sans clé enregistrée.
  if (judgePerModel !== undefined) {
    if (category !== 'conversation' || seriesPerModel !== undefined) throw new Error(t('duel.error.badRequest'))
    if (!isDuelSeriesCount(judgePerModel)) throw new Error(t('duel.error.badRequest'))
    if (!(await loadClaudeKey())) throw new Error(t('judge.error.noKey'))
  }
  // Étape 382 : une série de duels (Code seulement, comme la file de l'étape 381 : les modèles n'agissent pas sur le PC).
  if (seriesPerModel !== undefined) {
    if (category !== 'code') throw new Error(t('duel.error.batchCodeOnly'))
    if (!isDuelSeriesCount(seriesPerModel)) throw new Error(t('duel.error.badRequest'))
  }
  const profile = await getProfile()
  const away = await remoteMachine()
  if (away?.error) throw new Error(away.error)
  const remote = away?.remote ?? null
  const candidates = await candidatesFor(category, profile, remote)
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
  const installed = await onModels(remote, installedModelsSeen)
  const missing = chosen.filter((m) => !isInstalled(m, installed))
  const sizeOf = new Map(candidates.map((c) => [c.model, c.vramGb]))
  const machine = await duelMachine(remote?.machine).catch(() => null)
  // L'ordre des modèles est mélangé : la position dans la session ne dit rien de qui ils sont.
  const shuffled = [...chosen].sort(() => Math.random() - 0.5)
  // Étape 384 : les duels déjà votés comptent (votes de ce PC et votes livrés avec Jaris).
  const seriesPlan =
    seriesPerModel === undefined ? null : planDuelSeries(shuffled, seriesPerModel, Math.random, countDuelsByModel(getAllDuelVotes(), 'code'), countDuelPairs(getAllDuelVotes(), 'code'))
  if (seriesPlan && !seriesPlan.length) throw new Error(tn('duel.series.allDone', seriesPerModel as number))
  // Étape 399 : chaque modèle fait au moins N duels, en comptant les votes déjà faits ET ceux de Claude encore à vérifier.
  const judgePlan =
    judgePerModel === undefined
      ? null
      : planDuelSeries(
          shuffled,
          judgePerModel,
          Math.random,
          countDuelsByModel([...getAllDuelVotes(), ...getDuelReviews()], 'conversation'),
          countDuelPairs([...getAllDuelVotes(), ...getDuelReviews()], 'conversation')
        )
  if (judgePlan && !judgePlan.length) throw new Error(tn('duel.series.allDone', judgePerModel as number))
  session = {
    id: randomUUID(),
    remote,
    vramGb: machine?.vramGb ?? null,
    sizes: sizeOf,
    category,
    phase: 'preparing',
    models: shuffled,
    downloaded: new Map(),
    // Une série ne télécharge rien d'avance : chaque modèle arrive juste avant ses duels (seriesKeeper).
    preparing:
      missing.length && seriesPerModel === undefined
        ? { done: 0, total: missing.length, percent: null, installed: chosen.length - missing.length }
        : null,
    dropped: 0,
    dropReason: null,
    played: new Map(),
    last: null,
    round: null,
    batch: null,
    series: null,
    judge: judgePlan
      ? {
          perModel: judgePerModel as number,
          plan: judgePlan,
          index: 0,
          judged: 0,
          skipped: 0,
          step: null,
          last: null,
          prompts: [],
          screens: judgeScreens,
          controller: new AbortController(),
          finished: false,
          error: null
        }
      : null,
    history: [],
    error: null
  }
  const current = session
  if (seriesPerModel !== undefined) {
    current.phase = 'ready'
    current.batch = (seriesPlan ?? []).map((pair, index) => ({
      number: index + 1,
      pair,
      prompt: '',
      followUps: [],
      sides: { a: emptySide(), b: emptySide() },
      revealed: null,
      tools: null,
      together: false
    }))
    assignSeriesPrompts(current.batch)
    current.series = newSeriesState(Date.now(), seriesPerModel)
    emitNow()
    persistSeries(current)
    startSeriesKeeper(current)
    return getDuelView() as DuelSessionView
  }
  emitNow()
  void onModels(remote, () => prepare(current, missing, sizeOf))
  return getDuelView() as DuelSessionView
}

async function prepare(current: Session, missing: string[], sizeOf: Map<string, number>): Promise<void> {
  prepareController = new AbortController()
  const signal = prepareController.signal
  const installed = current.preparing?.installed ?? 0
  for (const [index, model] of missing.entries()) {
    if (signal.aborted || session !== current) return
    current.preparing = { done: index, total: missing.length, percent: 0, installed }
    emitNow()
    try {
      // Aucun message de téléchargement transmis : ils portent le nom du modèle.
      const pulled = await pullModelIfMissing(
        model,
        undefined,
        (progress) => {
          if (!progress || session !== current) return
          current.preparing = { done: index, total: missing.length, percent: progress.percent, installed }
          emitSoon()
        },
        signal
      )
      // Seulement un modèle VRAIMENT téléchargé : un modèle déjà sur le PC (liste d'Ollama vide au départ, puis réparée
      // par pullModelIfMissing) ne doit jamais être proposé à la suppression à la fin de la session.
      if (pulled) current.downloaded.set(model, sizeOf.get(model) ?? 0)
    } catch (err) {
      if (signal.aborted) return
      console.error('[jaris] Duel : modèle non téléchargé —', err)
      const message = err instanceof Error ? err.message : String(err)
      // Masqué avec TOUS les modèles choisis (celui-ci compris) : le nom d'un modèle ne sort jamais avant les votes.
      current.dropReason = withoutModelNames(message, [...current.models, ...missing], ['', '']).slice(0, 400)
      current.models = current.models.filter((m) => m !== model)
      current.dropped += 1
    }
  }
  if (session !== current || signal.aborted) return
  current.preparing = null
  if (current.models.length < DUEL_MIN_MODELS) {
    current.phase = 'ended'
    current.error = current.dropReason
      ? `${t('duel.error.downloads')} ${t('duel.dropReason', { reason: current.dropReason })}`
      : t('duel.error.downloads')
  } else {
    current.phase = 'ready'
    // Étape 399 : avec Claude comme juge, les duels s'enchaînent seuls.
    if (current.judge) void runJudgedDuels(current)
    else nextRound(current)
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
  const together = canRunDuelTogether(current.category, [current.sizes.get(pair[0]) ?? NaN, current.sizes.get(pair[1]) ?? NaN], current.vramGb)
  current.round = { number: current.history.length + 1, pair, prompt: null, followUps: [], sides: { a: emptySide(), b: emptySide() }, revealed: null, tools: null, together, image: null }
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
  // Un nom vide (pas de paire : téléchargement raté) serait « trouvé » entre chaque caractère.
  const all = [...new Set([...models, ...pair])].filter(Boolean)
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
  // Étape 399 : avec Claude comme juge, c'est lui qui pose, lance et vote.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const text = prompt.trim()
  if (!current || current.phase !== 'ready' || !current.round) throw new Error(t('duel.error.noRound'))
  if (current.round.prompt !== null) throw new Error(t('duel.error.alreadyAsked'))
  if (!text) throw new Error(t('duel.error.emptyPrompt'))
  // Étape 475 : un Duel Vision ne part que d'une image (askDuelImage), jamais d'un texte.
  if (current.category === 'vision') throw new Error(t('duel.error.badRequest'))
  current.round.prompt = text
  void runSide(current, current.round, 'a')
  // Étape 379 : en Code, avec assez de mémoire pour les deux, B n'attend pas A.
  if (current.round.together) void runSide(current, current.round, 'b')
  return getDuelView() as DuelSessionView
}

/**
 * Étape 475 (Léo : « l'utilisateur met juste une image, et aucun prompt, et il doit décrire ») : Léo donne l'image du
 * Duel Vision ; les deux modèles la décrivent avec la même consigne fixe (DUEL_VISION_ASK), A d'abord. La consigne
 * est gardée comme « demande » du duel (historique, vote) ; l'image, elle, n'est jamais écrite.
 */
export function askDuelImage(image: unknown): DuelSessionView {
  const current = session
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  if (!current || current.phase !== 'ready' || !current.round) throw new Error(t('duel.error.noRound'))
  if (current.category !== 'vision') throw new Error(t('duel.error.badRequest'))
  if (current.round.prompt !== null) throw new Error(t('duel.error.alreadyAsked'))
  // Revérifié ici : seulement du base64 (jamais une adresse ni un chemin), d'une taille raisonnable.
  if (typeof image !== 'string' || !image || image.length > DUEL_VISION_IMAGE_MAX_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw new Error(t('duel.error.badRequest'))
  }
  current.round.image = image
  current.round.prompt = DUEL_VISION_ASK
  void runSide(current, current.round, 'a')
  if (current.round.together) void runSide(current, current.round, 'b')
  return getDuelView() as DuelSessionView
}

/**
 * Étape 476 (Léo : « mettre une API d'IA et à la fin lui demander laquelle elle préfère, pour t'aider à voter ») :
 * l'avis de Claude sur les deux descriptions d'un Duel Vision, avec la clé API de Léo. Seulement un conseil : Léo vote
 * toujours lui-même, et l'avis n'est ni gardé ni compté. Les noms des modèles ne partent jamais (A et B seulement).
 */
export async function adviseDuel(model: unknown, effort: unknown): Promise<DuelAdvice> {
  const current = session
  // Étape 477 : revérifiés ici — seulement un modèle et un effort de la liste proposée.
  if (!isDuelAdviceModel(model) || !isDuelAdviceEffort(effort)) throw new Error(t('duel.error.badRequest'))
  // Avec Claude comme juge, c'est déjà lui qui vote : pas d'avis en plus.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (current.category === 'vision' && !round.image) throw new Error(t('duel.error.badRequest'))
  if (round.revealed) throw new Error(t('duel.error.alreadyVoted'))
  if (round.sides.a.trouble || round.sides.b.trouble) throw new Error(t('duel.error.trouble'))
  if (!sideFinished(round.sides.a) || !sideFinished(round.sides.b)) throw new Error(t('duel.error.notFinished'))
  const apiKey = await loadClaudeKey()
  if (!apiKey) throw new Error(t('judge.error.noKey'))
  const { a, b } = round.sides
  try {
    // Étape 480 (Léo : « le système demander à Claude, à Code aussi, et à Message et à Vocal, à tout ») : chaque
    // catégorie montre à Claude ce qui compte pour elle. Jamais les noms des modèles (A et B seulement).
    const verdict =
      current.category === 'vision'
        ? await askClaudeVisionAdvice(apiKey, { image: round.image ?? '', a: a.text, b: b.text, model, effort })
        : current.category === 'code'
          ? await adviseCodeDuel(apiKey, {
              prompt: round.prompt,
              followUps: round.followUps,
              a: { html: a.html, error: a.error },
              b: { html: b.html, error: b.error },
              model,
              effort
            })
          : await judgeDuel(apiKey, {
              // Conversation et Vocal : exactement ce que voit le juge automatique (outils appelés et leurs résultats,
              // pas seulement ce que le modèle affirme), plus les tours où Léo a répondu aux deux modèles.
              prompt: round.prompt,
              a: { ...judgedSide(a), earlier: a.earlier.map((turn) => turn.text) },
              b: { ...judgedSide(b), earlier: b.earlier.map((turn) => turn.text) },
              tools: TOOLS.filter((tool) => round.tools?.has(tool.function.name)).map((tool) => ({ name: tool.function.name, description: tool.function.description })),
              followUps: round.followUps,
              spoken: current.category === 'voice',
              model,
              effort
            })
    return { outcome: verdict.outcome, reason: verdict.reason }
  } catch (err) {
    // Les messages du juge parlent des « votes déjà faits » (duels automatiques) : ici, des mots à cet écran.
    if (err instanceof JudgeRefusalError) throw new Error(t(current.category === 'vision' ? 'duel.vision.advice.refused' : 'duel.advice.refused'))
    if (err instanceof JudgeStopError && err.kind === 'rate') throw new Error(t('duel.vision.advice.rate'))
    if (err instanceof JudgeStopError && err.kind === 'network') throw new Error(t('duel.vision.advice.network'))
    if (err instanceof JudgeStopError && err.kind === 'unreadable') throw new Error(t('duel.vision.advice.unreadable'))
    throw err
  }
}

/**
 * Étape 401 : ce qu'un côté doit répondre maintenant (la demande, ou la dernière réponse de Léo), et SA conversation
 * d'avant — chaque modèle ne voit que ses propres réponses, jamais celles de l'autre.
 */
export function sideConversation(round: Pick<RoundState, 'prompt' | 'followUps'>, side: Pick<SideState, 'earlier'>): { ask: string; history: OllamaMessage[] } {
  const asks = [round.prompt ?? '', ...round.followUps]
  const history: OllamaMessage[] = []
  side.earlier.forEach((turn, index) => {
    history.push({ role: 'user', content: asks[index] ?? '' }, { role: 'assistant', content: turn.text })
  })
  return { ask: asks[side.earlier.length] ?? asks[asks.length - 1], history }
}

/**
 * Étape 401 (Léo : « des fois il me demande ma localisation, mais je peux pas renvoyer un message, là on a direct le
 * vote ») : Léo répond aux DEUX modèles avec le même message avant de voter. Chacun garde sa conversation ; A répond
 * d'abord, puis B quand Léo a vérifié ce que A a fait, comme pour la demande. Ni dans une file, ni avec Claude comme
 * juge. Étape 415 (Léo : « un bouton pour envoyer un deuxième prompt, en Code aussi ») : en Code, le message est une
 * modification de l'application que CHAQUE modèle a écrite (la sienne, jamais celle de l'autre).
 */
export function followUpDuel(message: unknown): DuelSessionView {
  const current = session
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const round = current?.round
  if (!current || current.phase !== 'ready' || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  // L'écran ne propose jamais de répondre dans ces cas : une telle demande ne vient pas de lui.
  if (current.batch?.includes(round)) throw new Error(t('duel.error.badRequest'))
  // Étape 475 : un Duel Vision se juge sur la seule description de l'image, sans échange ensuite.
  if (current.category === 'vision') throw new Error(t('duel.error.badRequest'))
  if (round.revealed) throw new Error(t('duel.error.alreadyVoted'))
  if (round.sides.a.trouble || round.sides.b.trouble) throw new Error(t('duel.error.trouble'))
  if (!sideFinished(round.sides.a) || !sideFinished(round.sides.b)) throw new Error(t('duel.error.notFinished'))
  if (round.followUps.length >= DUEL_MAX_FOLLOW_UPS) throw new Error(t('duel.followUp.limit', { count: DUEL_MAX_FOLLOW_UPS }))
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) throw new Error(t('duel.error.emptyPrompt'))
  if (text.length > DUEL_FOLLOW_UP_MAX_CHARS) throw new Error(t('duel.error.badRequest'))
  for (const name of ['a', 'b'] as const) {
    const side = round.sides[name]
    const earlier = [...side.earlier, { text: side.text, actions: side.actions, error: side.error, durationMs: side.durationMs }]
    // Un tour raté en Code (rien d'écrit) : le modèle repart de sa dernière application réussie.
    Object.assign(side, emptySide(), { earlier, baseHtml: side.html ?? side.baseHtml })
  }
  round.followUps.push(text)
  void runSide(current, round, 'a')
  // Étape 379 : quand les deux tiennent ensemble en mémoire (Code), B repart aussi tout de suite, comme pour la demande.
  if (round.together) void runSide(current, round, 'b')
  return getDuelView() as DuelSessionView
}

/** Le tour du modèle B, quand Léo a vérifié ce que A a fait. */
export function runDuelB(): DuelSessionView {
  const current = session
  // Étape 399 : avec Claude comme juge, c'est lui qui pose, lance et vote.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (!sideFinished(round.sides.a) || round.sides.b.status !== 'idle') throw new Error(t('duel.error.notYourTurn'))
  // Étape 381 : dans une file, c'est Jaris qui lance B quand la carte a de la place.
  if (current.batch?.includes(round)) throw new Error(t('duel.error.notYourTurn'))
  void runSide(current, round, 'b')
  return getDuelView() as DuelSessionView
}

/**
 * Étape 381 (Léo : « envoyer par exemple 6 prompts, il tourne 2, 3 ou 4 modèles si il peut, et on vote à la fin ») :
 * plusieurs duels Code d'un coup. Chaque demande devient un duel avec sa paire (choisie comme pour un duel ordinaire,
 * sans répéter la même paire d'affilée), puis Jaris les fait tourner pendant que Léo attend, autant à la fois que la
 * carte peut en tenir (pumpBatch). Léo ouvre ensuite chaque duel terminé et vote ; les noms sont révélés après chaque
 * vote, comme avant. Les demandes viennent de l'écran : revérifiées ici.
 */
export function startDuelBatch(prompts: readonly unknown[]): DuelSessionView {
  const current = session
  if (!current || current.phase !== 'ready') throw new Error(t('duel.error.noRound'))
  if (current.category !== 'code') throw new Error(t('duel.error.batchCodeOnly'))
  if (current.batch || (current.round && current.round.prompt !== null)) throw new Error(t('duel.error.alreadyAsked'))
  const texts = prompts.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
  if (texts.length < DUEL_BATCH_MIN || texts.length > DUEL_BATCH_MAX || texts.some((text) => text.length > 20_000)) {
    throw new Error(t('duel.error.batchCount', { min: DUEL_BATCH_MIN, max: DUEL_BATCH_MAX }))
  }
  // Les paires de la file : comme des duels joués l'un après l'autre (les moins jouées d'abord, jamais deux fois la
  // même d'affilée), sans toucher aux vrais comptes, qui ne bougent qu'au vote.
  const planned = new Map(current.played)
  let last = current.last
  const rounds: RoundState[] = []
  for (const [index, prompt] of texts.entries()) {
    const pair = nextDuelPair(current.models, planned, last)
    if (!pair) break
    planned.set(pairKey(pair[0], pair[1]), (planned.get(pairKey(pair[0], pair[1])) ?? 0) + 1)
    last = pair
    rounds.push({
      number: current.history.length + index + 1,
      pair,
      prompt,
      followUps: [],
      sides: { a: emptySide(), b: emptySide() },
      revealed: null,
      tools: null,
      together: false
    })
  }
  if (rounds.length < DUEL_BATCH_MIN) throw new Error(t('duel.error.noRound'))
  current.batch = rounds
  current.round = null
  pumpBatch(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Étape 381 : lance les côtés en attente de la file, autant que la carte peut en tenir (batchSlotsToStart). */
function pumpBatch(current: Session): void {
  const batch = current.batch
  if (!batch) return
  // Étape 382 : Ollama ne répond plus — rien ne part tant que le gardien de la série ne l'a pas revu.
  if (current.series?.waiting === 'ollama') return
  const running: { model: string; sizeGb: number }[] = []
  const waiting: { key: string; model: string; sizeGb: number }[] = []
  const where = new Map<string, { round: RoundState; side: DuelSide }>()
  for (const round of batch) {
    for (const side of ['a', 'b'] as const) {
      const model = round.pair[side === 'a' ? 0 : 1]
      const sizeGb = current.sizes.get(model) ?? Number.NaN
      const status = round.sides[side].status
      if (status === 'running') running.push({ model, sizeGb })
      else if (status === 'idle') {
        // Étape 382 : dans une série, un côté attend que son modèle soit sur le disque.
        if (current.series && !current.series.present.has(model)) continue
        const key = `${round.number}:${side}`
        waiting.push({ key, model, sizeGb })
        where.set(key, { round, side })
      }
    }
  }
  const series = current.series
  const placement = series?.placement ?? null
  const runningModels = new Set(running.map((r) => r.model))
  for (const key of batchSlotsToStart(running, waiting, current.vramGb, series ? 'series' : 'batch')) {
    const slot = where.get(key)
    if (!slot) continue
    // Étape 456 : un NOUVEAU modèle sur la machine louée ne démarre que s'il tient vraiment (seriesNewModelFits).
    if (series && placement) {
      const model = slot.round.pair[slot.side === 'a' ? 0 : 1]
      if (!runningModels.has(model) && !series.pending.has(model)) {
        const size = current.sizes.get(model) ?? Number.NaN
        const pendingGb = [...series.pending.values()].reduce((sum, gb) => sum + gb, 0)
        // Étape 458 (journal d'Ollama sur l'OVH de Léo : « GPU discovery watchdog timed out ») : chaque chargement fait
        // vérifier les cartes par Ollama ; plusieurs à la fois dépassent son délai, et le modèle part sur le processeur
        // ou reste bloqué. Un seul NOUVEAU modèle à la fois : le suivant attend que celui-ci soit vu chargé.
        if (series.pending.size > 0) continue
        if (!seriesNewModelFits(placement, pendingGb, size, current.vramGb)) continue
        series.pending.set(model, seriesModelNeedGb(size, DUEL_SERIES_SLOTS_PER_MODEL))
      }
      runningModels.add(model)
    }
    void runSide(current, slot.round, slot.side)
  }
}

/** Étape 381 : ouvre un duel de la file (pour le regarder tourner, ou voter quand il est fini). */
export function openBatchRound(number: number): DuelSessionView {
  const current = session
  const round = current?.batch?.find((r) => r.number === number)
  if (!current || !round) throw new Error(t('duel.error.noRound'))
  current.round = round
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Étape 381 : retour à la liste de la file, sans voter. */
export function closeBatchRound(): DuelSessionView {
  const current = session
  if (!current?.batch) throw new Error(t('duel.error.noRound'))
  current.round = null
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Étape 381 : un duel de la file prêt pour le vote (ses deux côtés ont fini sans être arrêtés). */
function batchRoundComplete(round: RoundState): boolean {
  const ok = (side: SideState): boolean => side.status === 'done' || side.status === 'error'
  return ok(round.sides.a) && ok(round.sides.b)
}

/** Étape 381 : quand tous les duels restants de la file sont votés, retour au duel ordinaire. */
function finishBatchIfDone(current: Session): void {
  if (!current.batch || !current.batch.every((r) => r.revealed)) return
  current.batch = null
  // Étape 382 : la série est finie et tout est voté — plus rien à reprendre au prochain lancement.
  if (current.series) {
    current.series.controller.abort()
    current.series = null
    void clearSeries().catch((err) => console.error('[jaris] Série de duels : fichier non effacé —', err))
  }
  if (current.round === null || current.round.revealed) nextRound(current)
}

/** Étape 381 : retire des duels de la file (arrêtés, passés) ; ce qu'ils faisaient encore est arrêté. */
function dropBatchRounds(current: Session, rounds: readonly RoundState[]): void {
  if (!current.batch) return
  for (const round of rounds) {
    for (const side of ['a', 'b'] as const) runControllers.get(`${round.number}:${side}`)?.abort()
  }
  current.batch = current.batch.filter((r) => !rounds.includes(r))
  if (current.round && rounds.includes(current.round)) current.round = null
  finishBatchIfDone(current)
  pumpBatch(current)
  if (current.series) {
    persistSeries(current)
    wakeSeries(current)
  }
}

export function stopDuelRun(): void {
  const current = session
  // Étape 399 : « Arrêter » arrête la suite jugée par Claude ; les votes déjà proposés restent à vérifier.
  if (current?.judge) {
    current.judge.controller.abort()
    abortRuns()
    emitNow()
    return
  }
  if (current?.batch) {
    // Étape 381 : dans un duel ouvert de la file, « Arrêter » abandonne CE duel ; depuis la liste, tout ce qui n'est
    // pas encore prêt pour le vote. Un duel à moitié fait ne se vote pas : il quitte la file.
    const target = current.round && current.batch.includes(current.round) ? [current.round] : current.batch
    // Étape 382 : « Tout arrêter » arrête aussi la série (téléchargement en cours compris) ; ce qui est prêt se vote.
    if (current.series && target === current.batch) current.series.controller.abort()
    dropBatchRounds(
      current,
      target.filter((r) => !r.revealed && !batchRoundComplete(r))
    )
    emitNow()
    return
  }
  abortRuns()
}

// --- Étape 382 : la série de duels Code ------------------------------------------------------------------------------
//
// Léo : « je veux que tu testes tous les modèles au moins 10 fois, ça va désinstaller des modèles et en réinstaller, il
// choisit au hasard dans une liste d'applications à coder, et après j'ai juste à voter ». Les duels sont planifiés d'un
// coup (planDuelSeries), puis un « gardien » télécharge chaque modèle, lui fait écrire TOUS ses côtés de duel d'affilée
// (les deux côtés d'un duel Code sont indépendants : l'adversaire n'a pas besoin d'être là), puis le supprime —
// seulement ceux que la série a téléchargés, jamais un modèle dont Jaris se sert. Un modèle n'est téléchargé qu'une fois. Tout est gardé sur le disque
// à chaque étape (duelSeriesStore.ts) : un redémarrage de Windows pendant la nuit reprend là où ça s'était arrêté.

/** Un côté refait au plus 3 fois après une panne de la machine ; au-delà, l'erreur reste (le vote dira le reste). */
const SERIES_MAX_RETRIES = 3
/**
 * Ollama qui ne répond plus : nouvel essai toutes les minutes, sans fin (le crédit d'une machine louée peut finir).
 * Sans évènement, le gardien regarde quand même où on en est toutes les 30 s. Réglables par les tests seulement.
 */
const seriesDelays = { ollamaRetryMs: 60_000, idleCheckMs: 30_000, stallMs: 10 * 60_000, loadCheckMs: 5_000 }
export function setDuelSeriesDelays(delays: Partial<typeof seriesDelays>): void {
  Object.assign(seriesDelays, delays)
}

/** Les côtés qui peuvent partir tout de suite : au-delà, inutile de télécharger le modèle suivant (le disque se remplirait). */
const SERIES_PREFETCH_READY = 2
/** « model 'x' not found » : le modèle a disparu du disque (ou Ollama regarde le mauvais dossier, étapes 289/313). */
export const SERIES_MODEL_NOT_FOUND = /model ['"]?[^'"\s]*['"]? not found/i
/** Le disque de la machine qui télécharge est plein (Linux, Windows, ou quota d'un conteneur loué). */
export const SERIES_DISK_FULL = /no space left on device|not enough space on the disk|ENOSPC|disk quota exceeded/i

function newSeriesState(createdAt: number, perModel: number): SeriesState {
  return {
    createdAt,
    perModel,
    present: new Set(),
    undeletable: new Set(),
    download: null,
    waiting: null,
    deleted: 0,
    controller: new AbortController(),
    wake: null,
    running: false,
    restart: false,
    diskFullAt: null,
    placement: null,
    pending: new Map(),
    lastProgressAt: Date.now(),
    stalledMinutes: null,
    cpuFallback: false
  }
}

/**
 * Étape 457 (Léo, OVH : LFM2.5 resté « Stopping… » dans Ollama, plus rien ne tournait, la série attendait sans rien dire) :
 * un vrai progrès d'un duel de la série — du texte ou de la réflexion en plus, ou un côté qui finit. Un simple signe de
 * vie (« le modèle répond toujours ») n'en est pas un : Ollama bloqué en envoie aussi.
 */
/** Étape 458 : tant qu'un nouveau modèle se charge, le gardien relit la machine souvent, pour lancer le suivant vite. */
function seriesPause(series: SeriesState): number {
  return series.pending.size ? Math.min(seriesDelays.loadCheckMs, seriesDelays.idleCheckMs) : seriesDelays.idleCheckMs
}

function noteSeriesProgress(): void {
  if (session?.series) session.series.lastProgressAt = Date.now()
}

/**
 * Étape 457 : sur la machine louée, des duels tournent mais rien n'avance depuis SERIES_STALL_MS : Ollama est
 * probablement bloqué là-bas. Jaris ne peut pas le redémarrer lui-même (il n'a que son adresse) : il le dit à Léo.
 */
function checkSeriesStall(current: Session, series: SeriesState): void {
  const before = series.stalledMinutes
  const running = runningSeriesModels(current).size > 0
  if (!current.remote || !running || series.waiting === 'ollama') {
    // Rien ne tourne : rien ne peut être bloqué, et le compteur repart quand un duel démarrera.
    series.lastProgressAt = Date.now()
    series.stalledMinutes = null
  } else {
    const idle = Date.now() - series.lastProgressAt
    series.stalledMinutes = idle >= seriesDelays.stallMs ? Math.max(1, Math.floor(idle / 60_000)) : null
  }
  if (series.stalledMinutes !== before) emitNow()
}

/** Les modèles dont un duel de la série tourne en ce moment. */
function runningSeriesModels(current: Session): Set<string> {
  const models = new Set<string>()
  for (const round of current.batch ?? []) {
    if (round.sides.a.status === 'running') models.add(round.pair[0])
    if (round.sides.b.status === 'running') models.add(round.pair[1])
  }
  return models
}

/** Étape 456 : relit ce que la machine louée a vraiment chargé (rien sur ce PC, ni si elle ne répond pas). */
async function refreshSeriesPlacement(current: Session, series: SeriesState): Promise<void> {
  const remote = current.remote
  if (!remote) return
  // Une lecture ratée ne bloque jamais la série : la dernière place connue reste.
  const loaded = await runWithOllamaHost(remote.host, () => loadedOllamaModels()).catch(() => null)
  if (!loaded) return
  series.placement = seriesPlacementFrom(loaded, runningSeriesModels(current))
  // Étape 458 : débordement alors que moins de la moitié des cartes est prise — ce n'est pas la place, c'est Ollama
  // qui n'a pas pu démarrer les cartes à temps (journal de Léo) : Léo doit le savoir, Jaris n'y peut rien d'ici.
  // Étape 459 (capture de Léo : l'avertissement affiché à tort, 72 Go pris sur 126) : la place prise compte TOUS les
  // modèles chargés (ceux qui finissent ou attendent d'être déchargés aussi), pas seulement ceux de la série qui tournent.
  const loadedGb = loaded.reduce((sum, entry) => sum + entry.vramGb, 0)
  // Étape 461 (Léo : l'avertissement encore affiché avec 61 Go pris sur 126) : « presque libres » = moins d'un quart pris.
  const cpuFallback = Boolean(series.placement.spill) && current.vramGb !== null && loadedGb < current.vramGb / 4
  if (cpuFallback !== series.cpuFallback) {
    series.cpuFallback = cpuFallback
    emitNow()
  }
  // Un modèle lancé maintenant vu chargé : sa vraie place est comptée, plus son estimation.
  const seen = new Set(loaded.map((entry) => baseModelTag(entry.model)))
  // Un modèle lancé dont plus aucun duel ne tourne (fini, ou en erreur avant d'être chargé) ne réserve plus rien.
  const running = runningSeriesModels(current)
  for (const model of [...series.pending.keys()]) if (seen.has(baseModelTag(model)) || !running.has(model)) series.pending.delete(model)
}

/** Les demandes de la série : des applications tirées au hasard dans la liste d'idées, toutes vues avant qu'une revienne. */
function assignSeriesPrompts(rounds: RoundState[], random: () => number = Math.random): void {
  let deck: number[] = []
  for (const round of rounds) {
    if (!deck.length) {
      deck = Array.from({ length: DUEL_CODE_IDEAS }, (_, i) => i + 1)
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
      }
    }
    round.prompt = t(`duel.suggest.code.${deck.pop() as number}` as MessageKey)
  }
}

function wakeSeries(current: Session): void {
  const wake = current.series?.wake
  if (!wake) return
  if (current.series) current.series.wake = null
  wake()
}

/** Attend un évènement (un côté qui finit, un arrêt) ou, au plus tard, `ms`. */
function waitSeries(series: SeriesState, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      series.controller.signal.removeEventListener('abort', done)
      if (series.wake === done) series.wake = null
      resolve()
    }
    const timer = setTimeout(done, ms)
    series.wake = done
    series.controller.signal.addEventListener('abort', done, { once: true })
  })
}

const modelOf = (round: RoundState, side: DuelSide): string => round.pair[side === 'a' ? 0 : 1]
const SIDES: readonly DuelSide[] = ['a', 'b']

/** Les côtés qui restent à faire, dans l'ordre de la série. */
function openSides(current: Session): { round: RoundState; side: DuelSide; model: string; running: boolean }[] {
  const out: { round: RoundState; side: DuelSide; model: string; running: boolean }[] = []
  for (const round of current.batch ?? []) {
    if (round.revealed) continue
    for (const side of SIDES) {
      const status = round.sides[side].status
      if (status === 'idle' || status === 'running') out.push({ round, side, model: modelOf(round, side), running: status === 'running' })
    }
  }
  return out
}

function ollamaResponds(current: Session): Promise<boolean> {
  return onModels(current.remote, () => fetchOllamaVersion(10_000)).then(
    () => true,
    () => false
  )
}

/**
 * Pendant une série, une erreur qui vient de la MACHINE (Ollama arrêté ou injoignable, modèle effacé du disque) n'est
 * pas une faute du modèle : le côté est refait plus tard, au plus SERIES_MAX_RETRIES fois. Le reste (réponse vide,
 * mémoire pleine, code illisible) est une vraie erreur du modèle, gardée telle quelle.
 */
async function seriesMachineFault(current: Session, side: SideState, model: string, message: string): Promise<boolean> {
  const series = current.series
  if (!series || side.retries >= SERIES_MAX_RETRIES) return false
  if (SERIES_MODEL_NOT_FOUND.test(message)) {
    series.present.delete(model)
    return true
  }
  if (await ollamaResponds(current)) return false
  series.waiting = 'ollama'
  return true
}

/** Supprime les modèles téléchargés par la série qui n'ont plus aucun duel à faire. */
async function releaseFinishedModels(current: Session): Promise<void> {
  const series = current.series
  if (!series) return
  const open = new Set(openSides(current).map((s) => s.model))
  const done = [...current.downloaded.keys()].filter((m) => !open.has(m) && !series.undeletable.has(m))
  if (!done.length) return
  // Étape 377 : sur une autre machine, ce PC ne se sert d'aucun de ces modèles.
  const used = current.remote ? [] : jarisModels(await getProfile().catch(() => null))
  for (const model of done) {
    if (used.some((u) => sameModel(u, model))) {
      series.undeletable.add(model)
      continue
    }
    try {
      await deleteModel(model)
      current.downloaded.delete(model)
      series.present.delete(model)
      series.deleted += 1
    } catch (err) {
      // Gardé, et proposé à la suppression à la fin ; jamais retenté en boucle.
      console.error('[jaris] Série de duels : modèle non supprimé —', err)
      series.undeletable.add(model)
    }
  }
  persistSeries(current)
  emitNow()
}

/** Un modèle qui ne peut pas être téléchargé : ses duels quittent la série (son nom n'est jamais affiché). */
function dropSeriesModel(current: Session, model: string, reason: string): void {
  current.dropped += 1
  current.dropReason = reason
  dropBatchRounds(
    current,
    (current.batch ?? []).filter((r) => r.pair.includes(model) && !r.revealed && !batchRoundComplete(r))
  )
}

function startSeriesKeeper(current: Session): void {
  const series = current.series
  if (!series || series.running) return
  series.running = true
  environment.keepAwake?.(true)
  void onModels(current.remote, () => seriesKeeper(current, series))
    .catch((err) => console.error('[jaris] Série de duels arrêtée —', err))
    .finally(() => {
      series.running = false
      series.download = null
      environment.keepAwake?.(false)
      if (series.restart && session === current && current.series === series) {
        series.restart = false
        startSeriesKeeper(current)
      }
      if (session === current) emitNow()
    })
}

async function seriesKeeper(current: Session, series: SeriesState): Promise<void> {
  const signal = series.controller.signal
  const alive = (): boolean => session === current && current.series === series && !signal.aborted && Boolean(current.batch)
  const installed = await installedModelsSeen()
  for (const model of current.models) if (isInstalled(model, installed)) series.present.add(model)
  await refreshSeriesPlacement(current, series)
  pumpBatch(current)
  emitNow()
  while (alive()) {
    // Étape 456 : à chaque passage, la place réelle sur la machine louée, puis les duels qui peuvent partir.
    await refreshSeriesPlacement(current, series)
    if (!alive()) break
    pumpBatch(current)
    checkSeriesStall(current, series)
    if (series.waiting === 'ollama') {
      if (!(await ollamaResponds(current))) {
        emitNow()
        await waitSeries(series, seriesDelays.ollamaRetryMs)
        continue
      }
      series.waiting = null
      pumpBatch(current)
      emitNow()
    }
    await releaseFinishedModels(current)
    if (!alive()) break
    const sides = openSides(current)
    // Plus rien à faire : la série a fini de tourner, il ne reste qu'à voter.
    if (!sides.length) break
    const ready = sides.filter((s) => !s.running && series.present.has(s.model)).length
    const running = sides.filter((s) => s.running).length
    const next = sides.find((s) => !s.running && !series.present.has(s.model))
    // Étape 385 : sur une grosse carte, d'autres modèles tournent EN MÊME TEMPS — on télécharge le suivant tant qu'il
    // tient sur la carte avec ceux déjà là (chacun avec tous ses duels à la fois).
    const active = [...new Set(sides.filter((s) => series.present.has(s.model)).map((s) => s.model))]
    const room =
      next !== undefined &&
      !series.placement?.spill &&
      seriesRoomForModel(
        active.map((m) => current.sizes.get(m) ?? Number.NaN),
        current.sizes.get(next.model) ?? Number.NaN,
        current.vramGb
      )
    if (!next || (ready >= SERIES_PREFETCH_READY && !room)) {
      await waitSeries(series, seriesPause(series))
      continue
    }
    // Le disque était plein au dernier téléchargement : on attend qu'un modèle fini soit supprimé avant de réessayer.
    if (series.diskFullAt !== null && series.deleted === series.diskFullAt && (running > 0 || ready > 0)) {
      series.waiting = 'disk'
      emitNow()
      await waitSeries(series, seriesPause(series))
      continue
    }
    // Le disque de ce PC : un modèle qui ne tient pas attend que d'autres finissent (et soient supprimés).
    if (!current.remote) {
      const free = await detectFreeDiskGb().catch(() => null)
      const size = current.sizes.get(next.model) ?? 0
      if (free !== null && size > free - DISK_SAFETY_MARGIN_GB) {
        if (running > 0 || ready > 0) {
          series.waiting = 'disk'
          emitNow()
          await waitSeries(series, seriesPause(series))
          continue
        }
        // Rien ne libérera de place : ses duels quittent la série plutôt que de bloquer toute la nuit.
        series.waiting = null
        dropSeriesModel(current, next.model, t('duel.series.noDisk', { need: formatGb(size), free: formatGb(Math.max(0, free - DISK_SAFETY_MARGIN_GB)) }))
        emitNow()
        continue
      }
    }
    series.waiting = null
    series.download = { percent: 0 }
    emitNow()
    try {
      const pulled = await pullModelIfMissing(
        next.model,
        undefined,
        (progress) => {
          if (!progress || session !== current) return
          series.download = { percent: progress.percent }
          emitSoon()
        },
        signal
      )
      if (pulled) current.downloaded.set(next.model, current.sizes.get(next.model) ?? 0)
      series.present.add(next.model)
      series.diskFullAt = null
    } catch (err) {
      if (!alive()) break
      const message = err instanceof Error ? err.message : String(err)
      if (!(await ollamaResponds(current))) series.waiting = 'ollama'
      else if (SERIES_DISK_FULL.test(message)) {
        // Disque plein (celui d'une machine louée, souvent) : tant que d'autres modèles ont des duels à faire, ils
        // finiront et seront supprimés, et la place reviendra. Sinon, rien ne la libérera : ses duels partent.
        const others = openSides(current).filter((s) => s.model !== next.model && (s.running || series.present.has(s.model)))
        if (others.length) {
          series.diskFullAt = series.deleted
          series.waiting = 'disk'
        } else {
          series.diskFullAt = null
          dropSeriesModel(current, next.model, t('duel.series.diskFull'))
        }
      } else {
        dropSeriesModel(current, next.model, withoutModelNames(message, current.models, ['', '']).slice(0, 400))
      }
    } finally {
      series.download = null
    }
    if (!alive()) break
    pumpBatch(current)
    persistSeries(current)
    emitNow()
  }
}

const formatGb = (value: number): string => t('unit.gb', { value: formatDecimal(Math.round(value * 10) / 10) })

/** Ce qui est gardé sur le disque : les duels pas encore votés, et ce qu'il faut pour reprendre la série. */
function seriesSnapshot(current: Session, series: SeriesState): SeriesSnapshot {
  const side = (s: SideState): SeriesSideSnapshot =>
    s.status === 'done' || s.status === 'error'
      ? { status: s.status, text: s.text, error: s.error, durationMs: s.durationMs, app: Boolean(s.html) }
      : { status: 'idle', text: '', error: null, durationMs: null, app: false }
  return {
    format: SERIES_FORMAT,
    version: SERIES_VERSION,
    id: current.id,
    createdAt: series.createdAt,
    perModel: series.perModel,
    remote: current.remote ? { host: current.remote.host, vramGb: current.remote.machine.vramGb, ramGb: current.remote.machine.ramGb } : null,
    vramGb: current.vramGb,
    sizes: Object.fromEntries(current.sizes),
    models: current.models,
    downloaded: Object.fromEntries(current.downloaded),
    dropped: current.dropped,
    dropReason: current.dropReason,
    deleted: series.deleted,
    rounds: (current.batch ?? [])
      .filter((r) => !r.revealed)
      .map((r) => ({ number: r.number, pair: r.pair, prompt: r.prompt ?? '', a: side(r.sides.a), b: side(r.sides.b) }))
  }
}

function persistSeries(current: Session): void {
  const series = current.series
  if (!series) return
  void saveSeries(seriesSnapshot(current, series)).catch((err) => console.error('[jaris] Série de duels non gardée —', err))
}

/**
 * Au lancement de Jaris (main.ts) : une série gardée sur le disque reprend — les duels finis attendent le vote, les
 * autres repartent, et les modèles manquants sont retéléchargés. `false` = rien à reprendre.
 */
export async function restoreDuelSeries(): Promise<boolean> {
  if (session) return false
  const snapshot = await loadSeries().catch((err) => {
    console.error('[jaris] Série de duels illisible :', err)
    return null
  })
  if (!snapshot) return false
  if (!snapshot.rounds.length) {
    await clearSeries().catch(() => {})
    return false
  }
  const restoreSide = async (number: number, name: DuelSide, saved: SeriesSideSnapshot): Promise<SideState> => {
    if (saved.status === 'idle') return emptySide()
    const html = saved.app ? await readSeriesApp(number, name) : null
    // L'application n'a pas été gardée : le côté est refait plutôt que voté sans rien à regarder.
    if (saved.app && html === null) return emptySide()
    return {
      ...emptySide(),
      status: saved.status,
      text: saved.text,
      error: saved.error,
      durationMs: saved.durationMs,
      html,
      previewUrl: html ? createGeneratedAppPreview(html) : null
    }
  }
  const rounds: RoundState[] = []
  for (const r of snapshot.rounds) {
    rounds.push({
      number: r.number,
      pair: r.pair,
      prompt: r.prompt,
      followUps: [],
      sides: { a: await restoreSide(r.number, 'a', r.a), b: await restoreSide(r.number, 'b', r.b) },
      revealed: null,
      tools: null,
      together: false
    })
  }
  if (session) return false
  const series = newSeriesState(snapshot.createdAt, snapshot.perModel)
  series.deleted = snapshot.deleted
  session = {
    id: snapshot.id,
    remote: snapshot.remote ? { host: snapshot.remote.host, machine: { vramGb: snapshot.remote.vramGb, ramGb: snapshot.remote.ramGb, ollamaVersion: null } } : null,
    vramGb: snapshot.vramGb,
    sizes: new Map(Object.entries(snapshot.sizes)),
    category: 'code',
    phase: 'ready',
    models: snapshot.models,
    downloaded: new Map(Object.entries(snapshot.downloaded)),
    preparing: null,
    dropped: snapshot.dropped,
    dropReason: snapshot.dropReason,
    played: new Map(),
    last: null,
    round: null,
    batch: rounds,
    series,
    judge: null,
    history: [],
    error: null
  }
  emitNow()
  startSeriesKeeper(session)
  return true
}

async function runSide(current: Session, round: RoundState, sideName: DuelSide): Promise<void> {
  const side = round.sides[sideName]
  const model = round.pair[sideName === 'a' ? 0 : 1]
  // Étape 401 : après une réponse de Léo, le modèle répond à CE message, avec sa propre conversation d'avant.
  const { ask: prompt, history } = sideConversation(round, side)
  const runKey = `${round.number}:${sideName}`
  runControllers.get(runKey)?.abort()
  const controller = new AbortController()
  runControllers.set(runKey, controller)
  side.status = 'running'
  side.startedAt = Date.now()
  let retry = false
  side.activity = { kind: current.category === 'code' ? 'loading' : 'thinking' }
  emitNow()
  try {
    // Ollama arrêté : `null`, et le niveau part tel quel (Ollama le ramène à un niveau du modèle).
    const think = equivalentThink(DUEL_THINK_LEVEL, await onModels(current.remote, () => getModelThinking(model)))
    // Les outils sont ceux de CE PC, même quand les modèles tournent ailleurs.
    if ((current.category === 'conversation' || current.category === 'voice') && !round.tools) round.tools = await duelToolsHere()
    // « Arrêter » pendant ces lectures : le modèle ne doit pas partir quand même (le signal est déjà donné).
    if (!controller.signal.aborted) {
      const tools = round.tools ?? new Set<string>()
      await onModels(
        current.remote,
        () =>
          current.category === 'code'
            ? runCode(current, side, model, codeAsk(round, side, prompt), think, controller.signal)
            : current.category === 'vision'
              ? runVision(side, model, round.image ?? '', think, controller.signal)
              : runConversation(current, side, model, prompt, think, tools, controller.signal, history),
        current.sizes
      )
    }
    if (controller.signal.aborted) side.status = 'stopped'
    else side.status = 'done'
  } catch (err) {
    if (controller.signal.aborted) side.status = 'stopped'
    else {
      const message = err instanceof Error ? err.message : String(err)
      if (await seriesMachineFault(current, side, model, message)) {
        // Étape 382 : la machine, pas le modèle (Ollama arrêté, modèle effacé du disque) — le côté sera refait.
        retry = true
      } else {
        side.status = 'error'
        side.error = withoutModelNames(message, current.models, round.pair)
      }
    }
  } finally {
    side.activity = null
    side.durationMs = side.startedAt === null ? null : Date.now() - side.startedAt
    if (side.status === 'done' || side.status === 'error') noteSeriesProgress()
    if (movingRuns.delete(runKey)) Object.assign(side, emptySide())
    else if (retry) Object.assign(side, { ...emptySide(), retries: side.retries + 1 })
    if (runControllers.get(runKey) === controller) runControllers.delete(runKey)
    if (session === current) {
      // Étape 382 : l'application écrite est gardée sur le disque avant tout, pour survivre à un redémarrage.
      if (current.series && side.status === 'done' && side.html) {
        await saveSeriesApp(round.number, sideName, side.html).catch((err) => console.error('[jaris] Série : application non gardée —', err))
      }
      // Étape 381 : un côté de la file a fini — de la place pour le suivant.
      if (current.batch && current.phase === 'ready') pumpBatch(current)
      if (current.series) {
        persistSeries(current)
        wakeSeries(current)
      }
      emitNow()
    }
  }
}

/**
 * Étape 366 : les outils proposés aux modèles, selon ce que CE PC peut faire tourner (duelOfferedTools). Une lecture qui
 * échoue ne retire rien : on ne retire que ce qui est sûr.
 */
async function duelToolsHere(): Promise<ReadonlySet<string>> {
  const [canDraw, installed, profile] = await Promise.all([
    imageDrawingAvailable().catch(() => true),
    installedModelsSeen(),
    getProfile().catch(() => null)
  ])
  return duelOfferedTools(
    TOOLS.map((tool) => tool.function.name),
    { canDraw, installed: installed.length ? installed : null, visionModels: [profile?.visionModel ?? config.ollama.visionModel, ...imageReadingModels()] }
  )
}

async function runConversation(
  current: Session,
  side: SideState,
  model: string,
  prompt: string,
  think: ThinkValue,
  tools: ReadonlySet<string>,
  signal: AbortSignal,
  history: OllamaMessage[] = []
): Promise<void> {
  const profile = await getProfile()
  // « Arrêter » pendant cette lecture : rien ne part au modèle.
  if (signal.aborted) return
  const channel = current.category === 'voice' ? 'voice' : 'chat'
  let streamed = ''
  const reply = await converse(
    prompt,
    profile?.name ?? null,
    environment.onReminderFire,
    (line) => {
      const action = duelActionFromLog(line)
      if (current.judge && (action || /^Résultat de l'outil/u.test(line)) && side.toolLog.length < 40) {
        side.toolLog.push(withoutModelNames(line, current.models, current.round?.pair ?? ['', '']).slice(0, 600))
      }
      if (action) {
        side.actions.push(action)
        side.activity = { kind: 'action', action }
      } else if (/^Résultat de l'outil/u.test(line)) {
        side.activity = { kind: 'thinking' }
      }
      emitSoon()
    },
    history,
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
    duelRestrictions(model, think, tools, (tool, error) => {
      if (side.trouble) return
      const name = error instanceof Error ? error.name : null
      if (!isJarisToolFailure(tool, name)) return
      const message = error instanceof Error ? error.message : String(error)
      side.trouble = { tool, message: withoutModelNames(message, current.models, current.round?.pair ?? ['', '']).slice(0, 400) }
      emitSoon()
    }, current.remote !== null)
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

/**
 * Étape 475 : la consigne du Duel Vision, la même pour tous. Léo ne pose aucune question : le modèle doit seulement
 * décrire. Écrite en français comme les autres consignes de Jaris ; la langue de la réponse suit celle de Jaris.
 */
export const DUEL_VISION_ASK = 'Décris cette image.'
const DUEL_VISION_SYSTEM_PROMPT =
  "Tu es Jaris. L'utilisateur t'envoie une image, sans question. Décris-la précisément : ce qu'elle montre, les " +
  'personnes, objets et lieux, les textes visibles recopiés tels quels, les couleurs et la disposition. Ne décris que ' +
  "ce qui est réellement visible : si un détail est illisible ou incertain, dis-le au lieu de l'inventer."

/**
 * Étape 475 : un côté du Duel Vision — le modèle du duel lui-même (jamais remplacé par un plus petit comme le fait
 * describeImage), sans outils, la réponse affichée au fil de l'écriture.
 */
async function runVision(side: SideState, model: string, image: string, think: ThinkValue, signal: AbortSignal): Promise<void> {
  if (!image) throw new Error(t('duel.error.badRequest'))
  let streamed = ''
  const message = await chatWithOllama(
    [
      // La langue de la réponse : celle de Jaris (replyLanguageRule) — la consigne ne nomme aucune langue.
      { role: 'system', content: DUEL_VISION_SYSTEM_PROMPT + replyLanguageRule() },
      { role: 'user', content: DUEL_VISION_ASK, images: [image] }
    ],
    undefined,
    model,
    think,
    signal,
    undefined,
    (delta) => {
      streamed += delta
      side.text = streamed
      side.activity = { kind: 'writing' }
      emitSoon()
    }
  )
  side.text = message.content?.trim() || streamed.trim()
  if (!side.text && !signal.aborted) throw new Error(t('vision.empty', { model }))
}

function codeActivity(progress: CodeGenProgress): DuelActivity {
  return {
    kind: progress.phase,
    code: {
      step: progress.stepIndex,
      steps: progress.stepCount,
      charsWritten: progress.charsWritten,
      thinkingChars: progress.thinkingChars ?? 0,
      idleMs: progress.idleMs,
      elapsedMs: progress.elapsedMs
    }
  }
}

/**
 * Étape 415 : ce que le modèle reçoit en Code. Avec une application à modifier, seulement le dernier message (le
 * fichier lui-même donne le contexte, comme dans le mode Code) ; sans (premier tour, ou rien n'a jamais marché), toute
 * la demande, message après message, pour qu'il n'écrive pas une application à partir du seul « ajoute un bouton ».
 */
export function codeAsk(round: Pick<RoundState, 'prompt' | 'followUps'>, side: Pick<SideState, 'baseHtml'>, ask: string): string {
  if (side.baseHtml || !round.followUps.length) return ask
  return [round.prompt ?? '', ...round.followUps].filter((part) => part.trim()).join('\n\n')
}

async function runCode(_current: Session, side: SideState, model: string, prompt: string, think: ThinkValue, signal: AbortSignal): Promise<void> {
  const hurry = new AbortController()
  side.writeNow = hurry
  try {
    await writeCode(side, model, prompt, think, signal, hurry.signal)
  } finally {
    if (side.writeNow === hurry) side.writeNow = null
  }
}

async function writeCode(side: SideState, model: string, prompt: string, think: ThinkValue, signal: AbortSignal, writeNow: AbortSignal): Promise<void> {
  let writtenSoFar = 0
  const app = await generateApp(prompt, () => {}, side.baseHtml ?? undefined, undefined, {
    writeNow,
    model,
    think,
    persist: false,
    minNumCtx: DUEL_CODE_NUM_CTX,
    signal,
    onProgress: (progress) => {
      // Étape 457 : seul du texte ou de la réflexion EN PLUS compte comme un progrès de la série.
      const work = progress.charsWritten + (progress.thinkingChars ?? 0)
      if (work > writtenSoFar) {
        writtenSoFar = work
        noteSeriesProgress()
      }
      side.activity = codeActivity(progress)
      emitSoon()
    }
  })
  side.html = app.html
  side.previewUrl = createGeneratedAppPreview(app.html)
  side.text = app.issues.length ? app.issues.join('\n') : ''
}

/**
 * Étape 416 (Léo : « un bouton : arrête ta réflexion et écris le code ») : le modèle de ce côté arrête de réfléchir et
 * écrit tout de suite (codeGenerator.ts, `writeNow`). Seulement en Code, pendant qu'il travaille, une fois par tour.
 */
export function writeNowDuel(sideName: DuelSide): DuelSessionView {
  const current = session
  const side = current?.round?.sides[sideName]
  if (!current || !side) throw new Error(t('duel.error.noRound'))
  // L'écran ne montre le bouton que dans ce cas : une autre demande ne vient pas de lui.
  if (current.category !== 'code' || side.status !== 'running' || !side.writeNow) throw new Error(t('duel.error.badRequest'))
  side.hurried = true
  side.writeNow.abort()
  emitNow()
  return getDuelView() as DuelSessionView
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
  // Étape 399 : avec Claude comme juge, c'est lui qui pose, lance et vote.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
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
    // Étape 401 : les réponses d'avant (Léo a répondu aux modèles) partent avec le vote, et la durée compte tous les tours.
    const earlier = side.earlier.map((turn) => ({ ...turn, text: turn.text.slice(0, DUEL_HISTORY_TEXT_MAX) }))
    const total = [...side.earlier.map((turn) => turn.durationMs), side.durationMs]
    return {
      text: side.text.slice(0, DUEL_HISTORY_TEXT_MAX),
      actions: side.actions,
      durationMs: total.every((value) => value === null) ? null : total.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      error: side.error,
      app,
      ...(earlier.length ? { earlier } : {})
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
    ...(round.followUps.length ? { followUps: [...round.followUps] } : {}),
    sides
  })
  if (session !== current) return getDuelView() as DuelSessionView
  current.history.push({ prompt: round.prompt, modelA, modelB, outcome })
  const key = pairKey(modelA, modelB)
  current.played.set(key, (current.played.get(key) ?? 0) + 1)
  current.last = round.pair
  round.revealed = { a: modelA, b: modelB, outcome, voteId: id }
  // Étape 382 : un duel voté quitte la série gardée sur le disque (il est maintenant dans les votes).
  if (current.series) persistSeries(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Après la révélation des noms : le duel suivant (une autre paire). */
export function nextDuel(): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || !round.revealed) throw new Error(t('duel.error.noRound'))
  // Étape 381 : dans une file, retour à la liste ; une fois tout voté, retour au duel ordinaire.
  if (current.batch) {
    current.round = null
    finishBatchIfDone(current)
    emitNow()
    return getDuelView() as DuelSessionView
  }
  nextRound(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Modèles de la session qui peuvent remplacer un côté : ni A ni B. */
function swapCandidates(current: Session, round: RoundState): string[] {
  return current.models.filter((model) => !round.pair.includes(model))
}

function swapAllowed(current: Session, round: RoundState): boolean {
  // Après une réponse de Léo, un nouveau modèle n'aurait pas la conversation d'avant ; après le vote, c'est trop tard.
  return !current.judge && !current.series && round.prompt !== null && !round.revealed && round.followUps.length === 0
}

/**
 * Léo (capture d'un duel où B « réfléchit » depuis 39 min : « si le B bugue, on doit tout refaire — mets un bouton
 * changer de modèle pour le B ») : ce côté reçoit un autre modèle de la session, sur la même demande ; l'autre côté
 * garde sa réponse. Le nouveau modèle reste anonyme comme les autres. Ce qui tournait de ce côté est arrêté.
 */
export function swapDuelModel(sideName: DuelSide): DuelSessionView {
  const current = session
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.revealed) throw new Error(t('duel.error.alreadyVoted'))
  if (!swapAllowed(current, round)) throw new Error(t('duel.error.notYourTurn'))
  const candidates = swapCandidates(current, round)
  if (!candidates.length) throw new Error(t('duel.error.noOtherModel'))
  const index = sideName === 'a' ? 0 : 1
  // Comme pour un duel ordinaire, la paire (avec le modèle gardé) la moins jouée passe d'abord.
  const kept = round.pair[1 - index]
  const count = (model: string): number => current.played.get(pairKey(model, kept)) ?? 0
  const least = Math.min(...candidates.map(count))
  const tied = candidates.filter((model) => count(model) === least)
  const model = tied[Math.floor(Math.random() * tied.length)]
  const pair: [string, string] = [...round.pair] as [string, string]
  pair[index] = model
  const together = canRunDuelTogether(current.category, [current.sizes.get(pair[0]) ?? NaN, current.sizes.get(pair[1]) ?? NaN], current.vramGb)
  // Les deux modèles ne tiennent pas ensemble en mémoire : pas de nouveau modèle tant que l'autre côté travaille.
  if (round.sides[sideName === 'a' ? 'b' : 'a'].status === 'running' && !together) throw new Error(t('duel.error.notYourTurn'))
  runControllers.get(`${round.number}:${sideName}`)?.abort()
  round.pair = pair
  round.sides = { ...round.sides, [sideName]: emptySide() }
  round.together = together
  if (current.batch?.includes(round)) {
    pumpBatch(current)
    emitNow()
    return getDuelView() as DuelSessionView
  }
  // A repart tout de suite ; B aussi quand A a fini (ou quand les deux travaillent ensemble), sinon il attend son tour.
  const other = round.sides[sideName === 'a' ? 'b' : 'a']
  if (sideName === 'a' || sideFinished(other) || round.together) void runSide(current, round, sideName)
  emitNow()
  return getDuelView() as DuelSessionView
}

/** Un duel gâché par un outil de Jaris : les deux modèles le refont, même paire, même demande, A d'abord. */
export function retryDuel(): DuelSessionView {
  const current = session
  // Étape 399 : avec Claude comme juge, c'est lui qui pose, lance et vote.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.sides.a.status === 'running' || round.sides.b.status === 'running') throw new Error(t('duel.error.notFinished'))
  if (!round.sides.a.trouble && !round.sides.b.trouble) throw new Error(t('duel.error.badRequest'))
  // Étape 401 : seul le tour en cours est refait ; les réponses d'avant (Léo a répondu aux modèles) restent.
  // Étape 415 : en Code, l'application à modifier reste celle du tour d'avant.
  const again = (side: SideState): SideState => ({ ...emptySide(), earlier: side.earlier, baseHtml: side.baseHtml })
  round.sides = { a: again(round.sides.a), b: again(round.sides.b) }
  // Relus au nouveau tour de A : le modèle d'images a peut-être été installé entre-temps.
  round.tools = null
  if (current.batch?.includes(round)) {
    // Étape 381 : le duel reprend sa place dans la file.
    pumpBatch(current)
    if (current.series) wakeSeries(current)
    emitNow()
    return getDuelView() as DuelSessionView
  }
  void runSide(current, round, 'a')
  if (round.together) void runSide(current, round, 'b')
  return getDuelView() as DuelSessionView
}

/** Passe un duel gâché par un outil de Jaris, sans vote : une autre paire prend sa place. */
export function skipDuel(): DuelSessionView {
  const current = session
  // Étape 399 : avec Claude comme juge, c'est lui qui pose, lance et vote.
  if (current?.judge) throw new Error(t('duel.error.notYourTurn'))
  const round = current?.round
  if (!current || !round || round.prompt === null) throw new Error(t('duel.error.noRound'))
  if (round.sides.a.status === 'running' || round.sides.b.status === 'running') throw new Error(t('duel.error.notFinished'))
  if (!round.sides.a.trouble && !round.sides.b.trouble) throw new Error(t('duel.error.badRequest'))
  current.last = round.pair
  if (current.batch?.includes(round)) {
    // Étape 381 : passé sans vote, il quitte la file.
    dropBatchRounds(current, [round])
    emitNow()
    return getDuelView() as DuelSessionView
  }
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
      followUps: vote.followUps ?? [],
      outcome: vote.outcome,
      modelA: vote.modelA,
      modelB: vote.modelB,
      sides: vote.sides ?? null
    }))
}

/**
 * Étape 398 : supprimer des duels de l'historique (`'all'` : tous). Ce qui vient de l'écran est revérifié : `'all'`, ou
 * une liste d'identifiants de taille raisonnable. Renvoie l'historique à jour.
 */
export async function deleteDuelHistory(which: unknown): Promise<DuelHistoryEntry[]> {
  if (which !== 'all' && !(Array.isArray(which) && which.length <= 10_000 && which.every((id) => typeof id === 'string'))) {
    throw new Error(t('duel.error.badRequest'))
  }
  await deleteDuelVotes(which)
  return duelHistory()
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

interface DuelExportInput {
  category: DuelCategory
  at: number
  prompt: string
  followUps: readonly string[]
  sides: Record<DuelSide, { text: string; earlier: readonly { text: string }[]; error: string | null; html: string | null }>
  /** Les noms et le vote : seulement une fois le vote donné (sinon le fichier reste à l'aveugle). */
  revealed: { a: string; b: string; outcome: DuelOutcome } | null
}

/** Étape 458 : le fichier Markdown d'un duel (demande, réponses de Léo, réponse et code de chaque modèle, vote). */
function duelExportMarkdown(input: DuelExportInput): { fileName: string; text: string } {
  /** Un bloc de code que rien dans le contenu ne peut refermer (des « ``` » dans le code généré). */
  const fenced = (content: string, lang: string): string => {
    const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}${lang}\n${content.trimEnd()}\n${fence}`
  }
  const lines: string[] = [
    `# ${t('duel.export.title', { category: t(`duel.category.${input.category}` as MessageKey) })}`,
    '',
    t(input.revealed ? 'duel.export.intro' : 'duel.export.introBlind'),
    '',
    `## ${t('duel.export.request')}`,
    '',
    input.prompt
  ]
  if (input.followUps.length) {
    lines.push('', `## ${t('duel.export.followUps')}`, '', ...input.followUps.map((reply) => `- ${reply}`))
  }
  for (const name of ['a', 'b'] as const) {
    const side = input.sides[name]
    const letter = name.toUpperCase()
    lines.push('', `## ${input.revealed ? t('duel.export.model', { side: letter, model: input.revealed[name] }) : t('duel.export.modelBlind', { side: letter })}`)
    for (const turn of side.earlier) if (turn.text.trim()) lines.push('', turn.text.trim())
    if (side.text.trim()) lines.push('', side.text.trim())
    if (side.error) lines.push('', side.error)
    if (input.category === 'code') lines.push('', side.html ? fenced(side.html, 'html') : t('duel.export.noCode'))
  }
  if (input.revealed) {
    const outcome = input.revealed.outcome
    const label = outcome === 'a' ? 'duel.vote.a' : outcome === 'b' ? 'duel.vote.b' : outcome === 'tie' ? 'duel.vote.tie' : 'duel.vote.bothBad'
    lines.push('', `## ${t('duel.export.vote')}`, '', t(label))
  }
  const day = new Date(input.at).toISOString().slice(0, 10)
  const slug = input.prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return { fileName: `duel-${input.category}-${day}${slug ? `-${slug}` : ''}.md`, text: `${lines.join('\n')}\n` }
}

/**
 * Étape 458 (Léo : « un bouton pour télécharger le code des deux modèles, avec le prompt, en un fichier, pour l'envoyer
 * rapidement à une IA »), étape 460 (« c'est pas après le vote, c'est pendant ») :
 * - sans `voteId` : le duel ouvert, une fois A et B finis, AVANT le vote — à l'aveugle (« Modèle A », « Modèle B »,
 *   noms masqués jusque dans le code et les réponses, comme à l'écran), pour qu'une IA aide Léo à juger ;
 * - avec `voteId` : un duel de l'historique, avec les noms et le vote.
 */
export async function duelExportFile(voteId?: string): Promise<{ fileName: string; text: string } | null> {
  if (voteId === undefined) {
    const current = session
    const round = current?.round
    if (!current || !round || round.prompt === null || current.judge) return null
    if (!sideFinished(round.sides.a) || !sideFinished(round.sides.b)) return null
    const hide = (text: string): string => withoutModelNames(text, current.models, round.pair)
    const sideOf = (name: DuelSide): DuelExportInput['sides'][DuelSide] => {
      const side = round.sides[name]
      return {
        text: hide(side.text),
        earlier: side.earlier.map((turn) => ({ text: hide(turn.text) })),
        error: side.error ? hide(side.error) : null,
        html: side.html ? hide(side.html) : null
      }
    }
    return duelExportMarkdown({
      category: current.category,
      at: Date.now(),
      prompt: round.prompt,
      followUps: round.followUps,
      sides: { a: sideOf('a'), b: sideOf('b') },
      revealed: round.revealed ? { a: round.revealed.a, b: round.revealed.b, outcome: round.revealed.outcome } : null
    })
  }
  const vote = getAllDuelVotes().find((v) => v.id === voteId)
  if (!vote) return null
  const sideOf = async (name: DuelSide): Promise<DuelExportInput['sides'][DuelSide]> => {
    const kept = vote.sides?.[name]
    return {
      text: kept?.text ?? '',
      earlier: kept?.earlier ?? [],
      error: kept?.error ?? null,
      html: kept?.app ? await readDuelApp(voteId, name).catch(() => null) : null
    }
  }
  return duelExportMarkdown({
    category: vote.category,
    at: vote.at,
    prompt: vote.prompt,
    followUps: vote.followUps ?? [],
    sides: { a: await sideOf('a'), b: await sideOf('b') },
    revealed: { a: vote.modelA, b: vote.modelB, outcome: vote.outcome }
  })
}

/** Étape 388 : les duels d'une file (ou d'une série) que Léo n'a pas encore votés, finis ou pas. */
// --- Étape 399 : Claude écrit les demandes et vote --------------------------------------------------------------------
//
// Léo : « ma clé API Claude ; il pose la question, attend les deux réponses, vote A ou B et continue », puis « je dois
// vérifier à la fin, comme Tinder ». Chaque duel du plan : Claude écrit la demande, A répond (et agit sur le PC), puis
// B, puis Claude vote. Le vote est mis de côté (addDuelReview) : il ne compte qu'une fois validé par Léo. Un outil de
// Jaris en panne fait rejouer le duel une fois, puis le passe — comme les duels joués à la main.

function judgedSide(side: SideState): JudgedSide {
  return { actions: side.actions, toolLog: side.toolLog, error: side.error, text: side.text }
}

function keptSide(side: SideState): DuelVoteSide {
  return { text: side.text.slice(0, DUEL_HISTORY_TEXT_MAX), actions: side.actions, durationMs: side.durationMs, error: side.error, app: false }
}

/** Temps laissé à l'écran avant une capture pour Claude (une fenêtre qui s'ouvre, une animation). */
let judgeScreenSettleMs = 1500

/** Tests : pas d'attente avant une capture. */
export function setJudgeScreenSettleMs(ms: number): void {
  judgeScreenSettleMs = ms
}

/** Laisse à l'écran le temps de se poser (fenêtre qui s'ouvre, texte tapé), puis le photographie. */
async function captureForJudge(): Promise<string | null> {
  if (!environment.captureScreen) return null
  await new Promise((resolve) => setTimeout(resolve, judgeScreenSettleMs))
  try {
    return await environment.captureScreen()
  } catch {
    return null
  }
}

/**
 * Étape 455 (Léo : « gagner du temps sur les séries jugées par Claude ») : les modèles répondent toujours un par un (ils
 * agissent sur le PC), mais Claude ne fait plus attendre. Il écrit la demande du duel suivant pendant que A et B
 * répondent, et il juge un duel pendant que le suivant tourne déjà (ses captures d'écran sont prises avant). Un seul
 * jugement en attente à la fois ; une panne de Claude arrête la série comme avant, un refus passe juste CE duel.
 */
async function runJudgedDuels(current: Session): Promise<void> {
  const judge = current.judge
  if (!judge) return
  const signal = judge.controller.signal
  const stillHere = (): boolean => session === current && !signal.aborted
  const apiKey = await loadClaudeKey()
  if (!apiKey) {
    judge.error = t('judge.error.noKey')
    emitNow()
    return
  }
  /** Une panne de Claude pendant un jugement en arrière-plan : la série s'arrête avec son message. */
  const fail = (err: unknown): void => {
    if (session !== current || signal.aborted) return
    console.error('[jaris] Duels jugés par Claude : arrêt —', err)
    judge.error = err instanceof Error ? err.message : String(err)
    judge.controller.abort()
  }
  const toolsForClaude = async (): Promise<{ name: string; description: string }[]> => {
    const offered = await duelToolsHere()
    return TOOLS.filter((tool) => offered.has(tool.function.name)).map((tool) => ({ name: tool.function.name, description: tool.function.description }))
  }
  /** La demande suivante, demandée à Claude d'avance (jamais une promesse rejetée sans personne pour l'attendre). */
  const askQuestion = (tools: { name: string; description: string }[]): Promise<string> => {
    const asked = writeDuelQuestion(apiKey, tools, judge.prompts, signal)
    asked.catch(() => {})
    return asked
  }
  let nextQuestion: Promise<string> | null = null
  let judging: Promise<void> | null = null
  environment.keepAwake?.(true)
  try {
    while (judge.index < judge.plan.length) {
      if (!stillHere()) return
      const pair = judge.plan[judge.index]
      // Un modèle retiré de la session (téléchargement raté) : ses duels sont passés.
      if (!pair.every((model) => current.models.includes(model))) {
        judge.index += 1
        judge.skipped += 1
        continue
      }
      const round: RoundState = {
        number: judge.index + 1,
        pair,
        prompt: null,
        followUps: [],
        sides: { a: emptySide(), b: emptySide() },
        revealed: null,
        together: false,
        tools: null
      }
      current.round = round
      judge.step = 'question'
      emitNow()
      const tools = await toolsForClaude()
      let prompt: string
      try {
        const asked = nextQuestion ?? askQuestion(tools)
        nextQuestion = null
        prompt = await asked
      } catch (err) {
        if (!stillHere()) return
        if (err instanceof JudgeRefusalError) {
          judge.index += 1
          judge.skipped += 1
          continue
        }
        throw err
      }
      if (!stillHere()) return
      round.prompt = prompt
      judge.prompts.push(prompt)
      // Claude écrit déjà la demande suivante (elle connaît celle-ci : jamais deux fois la même) pendant que A et B répondent.
      if (judge.index + 1 < judge.plan.length) nextQuestion = askQuestion(tools)
      let screens: DuelScreens | null = null
      for (let attempt = 0; ; attempt++) {
        screens = judge.screens ? { before: await captureForJudge(), afterA: null, afterB: null } : null
        judge.step = 'a'
        emitNow()
        await runSide(current, round, 'a')
        if (!stillHere()) return
        if (screens) screens.afterA = await captureForJudge()
        judge.step = 'b'
        emitNow()
        await runSide(current, round, 'b')
        if (!stillHere()) return
        if (screens) screens.afterB = await captureForJudge()
        const trouble = Boolean(round.sides.a.trouble || round.sides.b.trouble)
        if (!trouble || attempt >= 1) break
        round.sides = { a: emptySide(), b: emptySide() }
        round.tools = null
      }
      judge.index += 1
      if (round.sides.a.trouble || round.sides.b.trouble) {
        judge.skipped += 1
        continue
      }
      // Un seul jugement en attente : le précédent doit être fini avant d'en lancer un autre.
      if (judging) await judging
      if (!stillHere()) return
      const judged = { pair, prompt, a: round.sides.a, b: round.sides.b, screens }
      judging = (async () => {
        try {
          const verdict = await judgeDuel(apiKey, { prompt: judged.prompt, a: judgedSide(judged.a), b: judgedSide(judged.b), tools, screens: judged.screens }, signal)
          if (!stillHere()) return
          await addDuelReview({
            id: randomUUID(),
            category: current.category,
            at: Date.now(),
            sessionId: current.id,
            modelA: judged.pair[0],
            modelB: judged.pair[1],
            prompt: judged.prompt,
            sides: { a: keptSide(judged.a), b: keptSide(judged.b) },
            outcome: verdict.outcome,
            reason: verdict.reason,
            judge: JUDGE_MODEL
          })
          judge.judged += 1
          judge.last = verdict
          emitNow()
        } catch (err) {
          if (!stillHere()) return
          if (err instanceof JudgeRefusalError) {
            judge.skipped += 1
            emitNow()
            return
          }
          fail(err)
        }
      })()
    }
    // Le dernier jugement : la série n'est finie qu'avec lui.
    if (judging) {
      judge.step = 'judge'
      emitNow()
      await judging
    }
    if (!stillHere()) return
    judge.finished = true
  } catch (err) {
    fail(err)
  } finally {
    if (session === current) {
      judge.step = null
      current.round = null
      emitNow()
    }
    environment.keepAwake?.(false)
  }
}

/** Les votes de Claude à vérifier, du plus ancien au plus récent, sans les noms des modèles. */
export function duelReviews(): DuelReviewView[] {
  return getDuelReviews().map((review) => ({
    id: review.id,
    at: review.at,
    prompt: review.prompt,
    a: review.sides.a,
    b: review.sides.b,
    outcome: review.outcome,
    reason: review.reason
  }))
}

/** Léo valide (le vote compte) ou refuse (il disparaît) un vote de Claude. Renvoie ce qui reste à vérifier. */
export async function decideDuelReviewFromScreen(id: unknown, accept: unknown): Promise<DuelReviewView[]> {
  if (typeof id !== 'string' || !id || typeof accept !== 'boolean') throw new Error(t('duel.error.badRequest'))
  await decideDuelReview(id, accept)
  return duelReviews()
}

function duelsNotVoted(current: Session): number {
  return current.batch?.filter((r) => !r.revealed).length ?? 0
}

/**
 * Étape 388 (Léo : « si j'ai plus de crédit, un système pour que je reprenne ») : la machine louée s'est arrêtée (crédit
 * épuisé, machine rendue) ; la série reprend sur celle réglée maintenant dans « Sur une autre machine ». Les duels finis
 * restent (ils sont sur ce PC) ; ceux en cours repartent de zéro, et les modèles sont retéléchargés sur la nouvelle
 * machine au fil de la série. Rien n'est effacé sur l'ancienne : elle ne répond plus.
 */
export async function moveDuelSeries(): Promise<DuelSessionView> {
  const current = session
  const series = current?.series
  if (!current || !series || !current.batch || current.phase !== 'ready') throw new Error(t('duel.error.noSeries'))
  const away = await remoteMachine()
  if (!away) throw new Error(t('duel.move.noRemote'))
  if (away.error) throw new Error(t('duel.remote.unreachable', { host: away.remote.host }))
  if (session !== current || current.series !== series) throw new Error(t('duel.error.noSeries'))
  current.remote = away.remote
  current.vramGb = away.remote.machine.vramGb
  // Les modèles de l'ancienne machine n'existent pas sur la nouvelle : rien à y supprimer, tout à retélécharger.
  current.downloaded = new Map()
  series.present = new Set()
  series.undeletable = new Set()
  series.waiting = null
  series.download = null
  series.diskFullAt = null
  for (const round of current.batch) {
    for (const side of SIDES) {
      const state = round.sides[side]
      const key = `${round.number}:${side}`
      const controller = runControllers.get(key)
      if (state.status === 'running' && controller) {
        movingRuns.add(key)
        controller.abort()
      } else if (state.status === 'idle') {
        // Un échec de l'ancienne machine n'était pas la faute du modèle : il a de nouveau tous ses essais.
        state.retries = 0
      }
    }
  }
  // Le gardien parle à l'ancienne adresse : il s'arrête, et repart sur la nouvelle dès qu'il a fini.
  const old = series.controller
  series.controller = new AbortController()
  if (series.running) {
    series.restart = true
    old.abort()
  } else {
    old.abort()
    startSeriesKeeper(current)
  }
  persistSeries(current)
  emitNow()
  return getDuelView() as DuelSessionView
}

const ROLES = ['flash', 'medium', 'large'] as const

/**
 * Fin de session : les noms sont révélés, le classement est recalculé, et le choix de Jaris suit les votes — tout de
 * suite pour un modèle déjà installé (ceux de la session le sont), sinon au prochain « Retester la configuration ».
 */
export async function endDuel(force = false): Promise<DuelSummary> {
  const current = session
  if (!current) throw new Error(t('duel.error.noSession'))
  // Étape 388 (Léo, après avoir perdu une série de 2 h sur ce bouton) : terminer une file qui a encore des duels pas
  // votés les efface. Jamais sans un « Terminer quand même » explicite de l'écran.
  const unvoted = duelsNotVoted(current)
  if (unvoted > 0 && !force) throw new Error(t('duel.endConfirm.needed', { count: unvoted }))
  prepareController?.abort()
  current.judge?.controller.abort()
  abortRuns()
  // Étape 382 : « Terminer » arrête la série pour de bon — les duels non votés sont abandonnés.
  if (current.series) {
    current.series.controller.abort()
    current.series = null
    await clearSeries().catch((err) => console.error('[jaris] Série de duels : fichier non effacé —', err))
  }
  current.phase = 'ended'
  current.preparing = null
  current.round = null
  current.batch = null
  emitNow()

  const profile = await getProfile()
  const installed = await installedModelsSeen()
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
    } else if (current.category === 'vision') {
      // Étape 475 : les votes Vision choisissent le modèle du rôle Vision, comme ceux du Code choisissent le modèle Code.
      if (!profile.visionModel || !sameModel(profile.visionModel, picks.vision)) {
        const applied = isInstalled(picks.vision, installed)
        changes.push({ role: 'vision', from: profile.visionModel ?? null, to: picks.vision, applied })
        if (applied) await patchProfile({ visionModel: picks.vision })
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
      // Étape 377 : supprimer un modèle de l'autre machine ne retire rien à ce PC.
      inUse: current.remote === null && [...used].some((u) => sameModel(u, model))
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
  const used = jarisModels(await getProfile())
  const deleted: string[] = []
  const failed: { model: string; error: string }[] = []
  for (const model of models) {
    if (!current.downloaded.has(model) || (current.remote === null && used.some((u) => sameModel(u, model)))) continue
    try {
      await onModels(current.remote, () => deleteModel(model))
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
  session?.judge?.controller.abort()
  // Étape 382 : la série s'arrête, mais reste gardée sur le disque — elle reprend au prochain lancement.
  if (session?.series) {
    const current = session
    current.series?.controller.abort()
    abortRuns()
    persistSeries(current)
    return
  }
  abortRuns()
}

/** Les modèles dont Jaris se sert (profil) : jamais supprimés par un duel. */
function jarisModels(profile: Profile | null): string[] {
  return [
    ...Object.values(profile?.models ?? {}),
    ...Object.values(profile?.voiceModels ?? {}),
    profile?.visionModel,
    profile?.codeModel,
    profile?.pilotModel,
    ...Object.values(profile?.modelChoices ?? {})
  ].filter((m): m is string => Boolean(m))
}
