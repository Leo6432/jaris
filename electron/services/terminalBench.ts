import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { powerSaveBlocker } from 'electron'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'
import { getDataRoot } from './dataLocation'
import { resolvePythonBin, PIP_INSTALL } from './pythonRuntime'
import {
  fitToModelContext,
  loadedOllamaModels,
  modelNativeContext,
  modelPlacement,
  preloadModel,
  pullModelIfMissing,
  unloadOllamaModels
} from './ollama'
import { CONTEXT_LENGTH_STEPS, estimateContextOnCard } from './hardwareScan'
import { writeFileAtomic } from './atomicFile'
import {
  TERMINAL_BENCH_TASK_COUNT,
  type TerminalBenchLive,
  type TerminalBenchProgress,
  type TerminalBenchRun,
  type TerminalBenchStatus
} from '../../shared/ipc'
import { t } from '../../shared/i18n'

/**
 * Étape 349, Léo : « on peut tester de faire Terminal-Bench 2.1 avec granite4.2:3b pour voir la différence entre nous
 * et Artificial Analysis », puis « ajoute un bouton test, en bas, faut pas que ça mélange tout, avec le score, le temps
 * estimé ». Ce test se lance sur le PC de Léo : sa carte graphique fait tourner un petit modèle à peu près à la vitesse
 * mesurée par Artificial Analysis, ce qui rend la comparaison juste (sur un serveur sans carte, granite était 10 fois
 * plus lent : il aurait manqué de temps sur chaque tâche).
 *
 * Mêmes options qu'Artificial Analysis (page « Intelligence Benchmarking », relue le 23/10/2026) :
 * agent Terminus 2, les 89 tâches de Terminal-Bench 2.1, 3 essais par tâche, 250 étapes au plus, 2 h par tâche
 * (ou le délai de la tâche s'il est plus long), réussite seulement si TOUS les tests passent, score = moyenne des
 * essais. Température 0,6 : leur règle pour un modèle qui réfléchit quand le créateur n'en donne pas.
 * Différences assumées : Docker sur le PC au lieu de leur bac à sable E2B, la version Q4 d'Ollama au lieu de la
 * version d'origine chez un fournisseur, et une fenêtre limitée à ce qui tient sur la carte graphique (Terminus 2
 * résume la conversation au-delà) : voir chooseContext, étape 351.
 *
 * L'outil officiel du test, Harbor (Laude Institute, auteurs de Terminal-Bench), est installé dans le Python de
 * Jaris avec `pip --target` : de simples fichiers, qui restent valables quand « Déplacer » change le dossier de place
 * (un environnement virtuel garde des chemins absolus et casserait). Rien de ce test n'entre dans le choix des
 * modèles : ses résultats restent dans leur propre carte.
 *
 * Docker n'est jamais installé par Jaris (retiré à l'étape 337) : la carte dit quoi faire s'il manque.
 */

export const TERMINAL_BENCH_DIR = 'terminal-bench'
/** Version de Harbor vérifiée de bout en bout le 23/10/2026 (tâche fix-git, granite4.2:3b, Ollama). */
export const HARBOR_VERSION = '0.24.0'
export const TERMINAL_BENCH_DATASET = 'terminal-bench/terminal-bench-2-1'
/** Les réglages d'Artificial Analysis pour Terminal-Bench 2.1. */
export const AA_SETTINGS = {
  attempts: 3,
  maxTurns: 250,
  minAgentTimeoutSec: 7200,
  temperature: 0.6
} as const
/**
 * Étape 351 (Léo : « mémoire on peut pas changer ça ? ») : la fenêtre n'est plus fixe. Avant chaque NOUVEAU test,
 * Jaris prend la plus grande qui tient entièrement sur la carte graphique (voir chooseContext), jamais moins que
 * MIN_BENCH_CTX : la fenêtre fixe des versions 0.38.0 et 0.38.1, gardée quand la carte n'en permet pas plus — moins
 * de mémoire ferait résumer la conversation sans arrêt. Plus que la carte ne tient ferait passer une partie du
 * modèle sur le processeur : plusieurs fois plus lent, donc plus de tâches coupées par la limite de 2 h.
 */
export const MIN_BENCH_CTX = 32768
/** Premier essai quand l'architecture du modèle n'est pas lisible : au-delà, aucune carte grand public ne suit. */
export const UNKNOWN_ARCH_START = 131072
/** Un modèle entièrement posé sur la carte : Ollama donne alors la même taille totale et sur la carte. */
const ON_CARD_TOLERANCE_BYTES = 16 * 1024 ** 2
/** Chargement d'un essai de fenêtre : un gros modèle, en partie sur le processeur, peut mettre plusieurs minutes. */
const CALIBRATION_LOAD_MS = 5 * 60_000
/**
 * Rythme de mise à jour de la carte pendant une tâche : le temps restant (Léo : « dis-moi toutes les minutes le temps
 * restant ») et ce qui se passe dans l'essai en cours (étape, dernière activité), relus dans les fichiers de Harbor.
 */
const TICK_MS = 10_000
const RESULTS_VERSION = 1

function rootDir(): string {
  return join(getDataRoot(), TERMINAL_BENCH_DIR)
}
const libDir = (): string => join(rootDir(), 'harbor')
const tasksParent = (): string => join(rootDir(), 'tasks')
const tasksDir = (): string => join(tasksParent(), 'terminal-bench-2-1')
const jobsDir = (): string => join(rootDir(), 'jobs')
const resultsPath = (): string => join(rootDir(), 'results.json')
const harborStamp = (): string => join(libDir(), '.jaris-harbor-version')
const tasksStamp = (): string => join(tasksDir(), '.jaris-timeouts')

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures (testées à part)

/**
 * Donne à l'agent au moins `minSec` secondes, comme Artificial Analysis (2 h, ou le délai de la tâche s'il est plus
 * long). Seule la ligne `timeout_sec` de la section [agent] change : celle du correcteur ([verifier]) reste celle de la
 * tâche.
 */
export function patchAgentTimeout(toml: string, minSec: number): string {
  const lines = toml.split(/\r?\n/)
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i])
    if (header) {
      section = header[1].trim()
      continue
    }
    const m = /^(\s*timeout_sec\s*=\s*)([0-9.]+)\s*$/.exec(lines[i])
    if (m && section === 'agent') lines[i] = `${m[1]}${Math.max(minSec, Number(m[2])).toFixed(1)}`
  }
  return lines.join('\n')
}

/** L'image Docker d'une tâche (effacée après la tâche : 89 images ne tiendraient pas sur le disque). */
export function dockerImageOf(toml: string): string | null {
  return /^\s*docker_image\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null
}

/** Arguments de `harbor run` pour UNE tâche, avec les réglages d'Artificial Analysis. */
export function harborRunArgs(opts: {
  tasksDir: string
  task: string
  model: string
  attempts: number
  ollamaHost: string
  numCtx: number
  jobsDir: string
  jobName: string
}): string[] {
  return [
    'run',
    '-p',
    opts.tasksDir,
    '-i',
    opts.task,
    '-a',
    'terminus-2',
    '-m',
    `ollama_chat/${opts.model}`,
    '--ak',
    `api_base=${opts.ollamaHost}`,
    '--ak',
    `temperature=${AA_SETTINGS.temperature}`,
    '--ak',
    `max_turns=${AA_SETTINGS.maxTurns}`,
    // Sans num_ctx, Ollama coupe la conversation à sa fenêtre par défaut, sans rien dire (vérifié : avec, le modèle
    // est bien chargé avec la fenêtre demandée).
    '--ak',
    `llm_call_kwargs=${JSON.stringify({ num_ctx: opts.numCtx })}`,
    // Terminus 2 résume la conversation quand elle approche de cette limite, au lieu de la laisser déborder. Sans
    // litellm_provider, LiteLLM n'associe pas ces chiffres au modèle et prend une limite d'un million (vérifié).
    '--ak',
    `model_info=${JSON.stringify({
      max_input_tokens: opts.numCtx,
      max_output_tokens: 8192,
      input_cost_per_token: 0,
      output_cost_per_token: 0,
      litellm_provider: 'ollama_chat'
    })}`,
    '-k',
    String(opts.attempts),
    '-n',
    '1',
    '-o',
    opts.jobsDir,
    '--job-name',
    opts.jobName,
    '-y',
    '-q'
  ]
}

/**
 * Les fenêtres à essayer, de la plus grande à la plus petite, toujours terminées par le plancher (essayé sans
 * vérification : il était déjà utilisé avant l'étape 351, même quand le modèle débordait de la carte).
 * `native` : le maximum du modèle lui-même (null = inconnu). `upper` : la plus grande fenêtre qui devrait tenir
 * sur la carte (estimateContextOnCard ; null = carte inconnue, 0 = le modèle seul ne tient pas).
 */
export function benchContextCandidates(native: number | null, upper: number | null, ladder: readonly number[]): number[] {
  if (native !== null && native <= MIN_BENCH_CTX) return [native]
  if (native === null || upper === null) return [MIN_BENCH_CTX]
  const top = Math.min(native, upper)
  const tries = ladder.filter((size) => size > MIN_BENCH_CTX && size <= top)
  // Un maximum qui n'est pas un palier (40 960 pour Qwen3, par exemple) est essayé tel quel.
  if (native <= top && !tries.includes(native)) tries.push(native)
  return [...tries.sort((a, b) => b - a), MIN_BENCH_CTX]
}

/** Vrai si Ollama a posé TOUT le modèle sur la carte graphique, avec au moins la fenêtre demandée. */
export function fullyOnCard(
  placement: { sizeBytes: number; vramBytes: number; contextLength: number | null } | null,
  numCtx: number
): boolean {
  if (!placement || placement.sizeBytes <= 0) return false
  if (placement.contextLength !== null && placement.contextLength < numCtx) return false
  return placement.vramBytes + ON_CARD_TOLERANCE_BYTES >= placement.sizeBytes
}

/** Écriture courte d'une fenêtre, comme le curseur de mémoire d'Options (src/lib/formatContextLength.ts) : 65536 → « 64k ». */
export function shortContext(tokens: number): string {
  return tokens < 1024 ? String(tokens) : `${Math.round(tokens / 1024)}k`
}

/** Un nom de dossier sûr pour une tâche d'un modèle (« hf.co/a/b:Q4 » contient des caractères interdits). */
export function jobNameFor(model: string, task: string, attempts: number): string {
  return `${model.replace(/[^A-Za-z0-9._-]+/g, '_')}__${attempts}x__${task}`
}

export interface TrialOutcome {
  passed: boolean
  /** Type d'erreur de Harbor, ou null si l'essai s'est déroulé normalement. */
  exception: string | null
}

/**
 * Une erreur qui vient du MODÈLE (temps de l'agent dépassé, comme chez Artificial Analysis) compte comme un échec.
 * Toute autre erreur de Harbor (y compris ses autres délais : installation de l'agent, démarrage du conteneur,
 * correcteur — lu dans harbor/trial/errors.py) peut venir de la machine : le lanceur vérifie alors que Docker et
 * Ollama répondent avant d'enregistrer la tâche.
 */
export function isModelFailure(exception: string | null): boolean {
  return exception === null || exception === 'AgentTimeoutError'
}

/** Lit le résultat de chaque essai d'un « job » Harbor (un sous-dossier par essai, avec son result.json). */
export async function readTrialOutcomes(jobDir: string): Promise<TrialOutcome[]> {
  const out: TrialOutcome[] = []
  let entries: string[] = []
  try {
    entries = await readdir(jobDir)
  } catch {
    return out
  }
  for (const entry of entries.sort()) {
    const file = join(jobDir, entry, 'result.json')
    if (!existsSync(file)) continue
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as {
        verifier_result?: { rewards?: Record<string, number> | null } | null
        exception_info?: { exception_type?: string } | null
      }
      const reward = data.verifier_result?.rewards?.reward
      out.push({
        passed: typeof reward === 'number' && reward >= 1,
        exception: data.exception_info?.exception_type ?? null
      })
    } catch {
      // Un essai interrompu en pleine écriture : ignoré, la tâche sera refaite si elle n'a pas tous ses essais.
    }
  }
  return out
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

/** Nombre d'étapes du modèle déjà gardées par Harbor, relu seulement quand le fichier a changé. */
const stepsCache = new Map<string, { mtime: number; steps: number }>()

async function agentSteps(trajectory: string, mtime: number | null): Promise<number> {
  if (mtime === null) return 0
  const cached = stepsCache.get(trajectory)
  if (cached && cached.mtime === mtime) return cached.steps
  try {
    const data = JSON.parse(await readFile(trajectory, 'utf8')) as { steps?: Array<{ source?: string }> }
    const steps = (data.steps ?? []).filter((step) => step?.source === 'agent').length
    stepsCache.set(trajectory, { mtime, steps })
    return steps
  } catch {
    // Fichier en pleine écriture : on garde le dernier nombre lu.
    return cached?.steps ?? 0
  }
}

/**
 * Ce qui se passe dans la tâche en cours, lu dans le dossier que Harbor écrit au fil de l'essai : un sous-dossier par
 * essai (config.json dès le début, result.json à la fin), le fichier agent/trajectory.json réécrit après CHAQUE étape
 * du modèle, le journal de l'essai, l'enregistrement du terminal, et verifier/ quand les tests de la tâche tournent.
 * Rien d'inventé : sans fichier, l'essai est « en démarrage ».
 */
export async function readLiveTrial(jobDir: string, attempts: number): Promise<TerminalBenchLive> {
  let lastActivityAt = await mtimeOf(join(jobDir, 'job.log'))
  const seen = (t: number | null): void => {
    if (t !== null && (lastActivityAt === null || t > lastActivityAt)) lastActivityAt = t
  }
  let names: string[] = []
  try {
    names = (await readdir(jobDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    // Harbor n'a pas encore créé le dossier.
  }
  let trialsDone = 0
  let current: string | null = null
  for (const name of names.sort()) {
    if (existsSync(join(jobDir, name, 'result.json'))) trialsDone++
    else current ??= join(jobDir, name)
  }
  const trial = Math.min(trialsDone + 1, attempts)
  if (!current) {
    return {
      trial,
      trialsDone,
      stage: trialsDone >= attempts ? 'verifying' : 'starting',
      steps: 0,
      trialStartedAt: null,
      lastActivityAt
    }
  }
  const trajectory = join(current, 'agent', 'trajectory.json')
  const trajectoryAt = await mtimeOf(trajectory)
  seen(trajectoryAt)
  for (const file of ['trial.log', join('agent', 'recording.cast'), join('agent', 'terminus_2.pane')]) {
    seen(await mtimeOf(join(current, file)))
  }
  let verifying = false
  try {
    const files = await readdir(join(current, 'verifier'))
    for (const file of files) seen(await mtimeOf(join(current, 'verifier', file)))
    verifying = files.length > 0
  } catch {
    // Pas encore de vérification.
  }
  const steps = await agentSteps(trajectory, trajectoryAt)
  return {
    trial,
    trialsDone,
    stage: verifying ? 'verifying' : steps > 0 ? 'agent' : 'environment',
    steps,
    trialStartedAt: (await mtimeOf(join(current, 'config.json'))) ?? null,
    lastActivityAt
  }
}

/** Score affiché : part des essais réussis, comme Artificial Analysis (moyenne des 3 essais de chaque tâche). */
export function scoreOf(run: TerminalBenchRun): {
  passed: number
  trials: number
  percent: number | null
} {
  let passed = 0
  let trials = 0
  for (const task of Object.values(run.tasks)) {
    passed += task.passed
    trials += task.trials
  }
  return { passed, trials, percent: trials ? (passed / trials) * 100 : null }
}

/**
 * Temps restant : temps moyen des tâches déjà faites (dans CE lancement ou un précédent du même test) × tâches qui
 * restent. Null tant qu'aucune tâche n'est finie : un chiffre inventé avant serait faux de plusieurs jours.
 */
export function remainingMs(run: TerminalBenchRun, totalTasks: number, currentTaskElapsedMs = 0): number | null {
  const done = Object.values(run.tasks)
  if (!done.length) return null
  const avg = done.reduce((sum, task) => sum + task.seconds * 1000, 0) / done.length
  const left = Math.max(0, totalTasks - done.length)
  return Math.max(0, left * avg - Math.min(currentTaskElapsedMs, avg))
}

// ---------------------------------------------------------------------------------------------------------------
// Résultats enregistrés

interface ResultsFile {
  version: number
  runs: Record<string, TerminalBenchRun>
}

function runKey(model: string, attempts: number): string {
  return `${model}|${attempts}`
}

async function readResults(): Promise<ResultsFile> {
  try {
    const data = JSON.parse(await readFile(resultsPath(), 'utf8')) as ResultsFile
    if (data?.version === RESULTS_VERSION && data.runs && typeof data.runs === 'object') return data
  } catch {
    // Pas encore de test.
  }
  return { version: RESULTS_VERSION, runs: {} }
}

async function writeResults(data: ResultsFile): Promise<void> {
  await mkdir(rootDir(), { recursive: true })
  await writeFileAtomic(resultsPath(), JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------------------------------------------------------
// Docker, Harbor, tâches

function execQuiet(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; missing: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code
      resolve({
        ok: !err,
        missing: code === 'ENOENT',
        out: `${stdout ?? ''}${stderr ?? ''}`.trim()
      })
    })
  })
}

export async function dockerState(): Promise<TerminalBenchStatus['docker']> {
  const res = await execQuiet('docker', ['info', '--format', '{{.ServerVersion}}'], 20_000)
  if (res.ok) return 'ready'
  return res.missing ? 'notInstalled' : 'notRunning'
}

function pythonEnv(): NodeJS.ProcessEnv {
  const temp = join(rootDir(), '.temp')
  return {
    ...process.env,
    PYTHONPATH: libDir(),
    // Sortie en UTF-8 même sous un Windows en cp1252 (étape 121 : sinon chaque accent devient « � »).
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp
  }
}

/** Lance Harbor depuis ses fichiers (`pip --target`), sans le petit exécutable qui garderait un chemin absolu. */
const HARBOR_BOOT = "import sys; sys.argv[0] = 'harbor'; from harbor.cli.main import app; app()"

function runPython(
  args: string[],
  onLine?: (line: string) => void,
  track?: (proc: ChildProcess) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolvePythonBin(), args, {
      windowsHide: true,
      env: pythonEnv()
    })
    track?.(proc)
    let buffer = ''
    const relay = (chunk: string): void => {
      buffer += chunk
      let i: number
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (line) onLine?.(line)
      }
    }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', relay)
    proc.stderr?.on('data', relay)
    proc.on('error', reject)
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

/** Versions exactes des dépendances de Harbor, résolues une fois pour toutes (python/terminal-bench-constraints.txt). */
const constraintsPath = (): string => join(pythonScriptsDir(), 'terminal-bench-constraints.txt')

async function ensureHarbor(onStep: (step: string) => void, track: (proc: ChildProcess) => void): Promise<void> {
  // La marque retient la version de Harbor ET les versions figées : une nouvelle version de Jaris qui les change
  // réinstalle Harbor au lieu de garder l'ancien ensemble.
  const constraints = await readFile(constraintsPath(), 'utf8')
  const wanted = `${HARBOR_VERSION}\n${createHash('sha256').update(constraints).digest('hex')}`
  const stamp = await readFile(harborStamp(), 'utf8').catch(() => '')
  if (stamp.trim() === wanted && existsSync(join(libDir(), 'harbor'))) return
  onStep(t('tbench.installing'))
  await rm(libDir(), { recursive: true, force: true })
  await mkdir(join(rootDir(), '.temp'), { recursive: true })
  let last = ''
  const code = await runPython(
    [...PIP_INSTALL, '--target', libDir(), '-c', constraintsPath(), `harbor==${HARBOR_VERSION}`],
    (line) => (last = line),
    track
  )
  if (stopRequested) return
  if (code !== 0) throw new Error(t('tbench.installFailed', { error: last || String(code) }))
  await writeFile(harborStamp(), wanted)
}

async function listTasks(): Promise<string[]> {
  const entries = await readdir(tasksDir(), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(tasksDir(), e.name, 'task.toml')))
    .map((e) => e.name)
    .sort()
}

async function ensureTasks(onStep: (step: string) => void, track: (proc: ChildProcess) => void): Promise<string[]> {
  let tasks = await listTasks()
  if (tasks.length < TERMINAL_BENCH_TASK_COUNT) {
    onStep(t('tbench.downloadingTasks'))
    let last = ''
    const code = await runPython(
      ['-c', HARBOR_BOOT, 'dataset', 'download', TERMINAL_BENCH_DATASET, '-o', tasksParent()],
      (line) => (last = line),
      track
    )
    if (stopRequested) return []
    tasks = await listTasks()
    if (code !== 0 || tasks.length < TERMINAL_BENCH_TASK_COUNT) {
      throw new Error(
        t('tbench.tasksFailed', {
          count: tasks.length,
          total: TERMINAL_BENCH_TASK_COUNT,
          error: last
        })
      )
    }
    await rm(tasksStamp(), { force: true })
  }
  if (!existsSync(tasksStamp())) {
    for (const task of tasks) {
      const file = join(tasksDir(), task, 'task.toml')
      await writeFile(file, patchAgentTimeout(await readFile(file, 'utf8'), AA_SETTINGS.minAgentTimeoutSec))
    }
    await writeFile(tasksStamp(), String(AA_SETTINGS.minAgentTimeoutSec))
  }
  return tasks
}

async function ollamaResponds(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ollama.host}/api/version`, {
      signal: AbortSignal.timeout(10_000)
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lancement

let progress: TerminalBenchProgress | null = null
let current: ChildProcess | null = null
let stopRequested = false
let running: Promise<void> | null = null
const listeners = new Set<(p: TerminalBenchProgress) => void>()

export function onTerminalBenchProgress(cb: (p: TerminalBenchProgress) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(patch: Partial<TerminalBenchProgress>): void {
  if (!progress) return
  progress = { ...progress, ...patch }
  for (const cb of listeners) cb(progress)
}

export async function getTerminalBenchStatus(): Promise<TerminalBenchStatus> {
  const [docker, results] = await Promise.all([dockerState(), readResults()])
  return { docker, runs: Object.values(results.runs), progress }
}

/** Attend qu'Ollama ait vraiment rendu la mémoire (`keep_alive: 0` répond avant la fin du déchargement). */
async function waitUntilUnloaded(timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const loaded = await loadedOllamaModels()
    if (!loaded || loaded.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Étape 351 : la plus grande fenêtre qui tient ENTIÈREMENT sur la carte graphique avec ce modèle. Le calcul
 * (estimateContextOnCard) ne sert qu'à choisir par où commencer : chaque fenêtre est vérifiée en chargeant
 * vraiment le modèle, seul sur la carte, puis en lisant où Ollama l'a rangé (/api/ps) — le calcul ignore la
 * mémoire de travail d'Ollama et peut se tromper dans les deux sens, le chargement réel non. Le modèle reste
 * chargé avec la fenêtre retenue : Harbor s'en sert tel quel, sans rechargement.
 */
async function chooseContext(model: string): Promise<number> {
  const [native, upper] = await Promise.all([
    modelNativeContext(model),
    estimateContextOnCard(model, UNKNOWN_ARCH_START).catch(() => null)
  ])
  const candidates = benchContextCandidates(native, upper, CONTEXT_LENGTH_STEPS)
  const floor = candidates[candidates.length - 1]
  for (const numCtx of candidates.slice(0, -1)) {
    if (stopRequested) break
    emit({ step: t('tbench.tryingContext', { size: shortContext(numCtx) }) })
    // Seul sur la carte : un autre modèle de Jaris (ou l'essai précédent) fausserait la mesure.
    await unloadOllamaModels()
    await waitUntilUnloaded()
    if (!(await preloadModel(model, numCtx, CALIBRATION_LOAD_MS))) continue
    if (fullyOnCard(await modelPlacement(model), numCtx)) return numCtx
  }
  return floor
}

/** Arrête le test en cours (bouton « Arrêter », fermeture de Jaris) ; il reprendra à la tâche en cours. */
export async function stopTerminalBench(): Promise<void> {
  stopRequested = true
  current?.kill()
  await running?.catch(() => {})
}

export function startTerminalBench(model: string, attempts: number): void {
  if (running) throw new Error(t('tbench.alreadyRunning'))
  if (attempts !== 1 && attempts !== AA_SETTINGS.attempts) throw new Error(t('tbench.badAttempts'))
  stopRequested = false
  const startedAt = Date.now()
  progress = {
    model,
    attempts,
    phase: 'preparing',
    step: t('tbench.checkingDocker'),
    startedAt,
    live: null,
    tasksDone: 0,
    tasksTotal: TERMINAL_BENCH_TASK_COUNT,
    passed: 0,
    trials: 0,
    currentTask: null,
    elapsedMs: 0,
    remainingMs: null,
    error: null
  }
  emit({})
  running = runAll(model, attempts, startedAt).finally(() => {
    running = null
    current = null
  })
}

async function runAll(model: string, attempts: number, started: number): Promise<void> {
  const awake = powerSaveBlocker.start('prevent-app-suspension')
  let taskStarted = 0
  /** Dossier de la tâche en cours, relu à chaque mise à jour de la carte. */
  let liveJobDir: string | null = null
  let liveBusy = false
  let run: TerminalBenchRun | null = null
  let tasks: string[] = []
  const refresh = (): void => {
    if (!run) return emit({ elapsedMs: Date.now() - started })
    const s = scoreOf(run)
    emit({
      elapsedMs: Date.now() - started,
      tasksDone: Object.keys(run.tasks).length,
      passed: s.passed,
      trials: s.trials,
      remainingMs: remainingMs(
        run,
        tasks.length || TERMINAL_BENCH_TASK_COUNT,
        taskStarted ? Date.now() - taskStarted : 0
      )
    })
  }
  const tickLive = async (): Promise<void> => {
    const dir = liveJobDir
    if (!dir || liveBusy) return refresh()
    liveBusy = true
    try {
      const live = await readLiveTrial(dir, attempts)
      // La tâche a pu se terminer pendant la lecture : jamais l'état d'une tâche affiché sur la suivante.
      if (dir === liveJobDir) emit({ live })
    } finally {
      liveBusy = false
    }
    refresh()
  }
  const tick = setInterval(() => void tickLive(), TICK_MS)
  try {
    const docker = await dockerState()
    if (docker !== 'ready')
      throw new Error(t(docker === 'notInstalled' ? 'tbench.dockerMissing' : 'tbench.dockerStopped'))
    await mkdir(jobsDir(), { recursive: true })
    // Le bouton « Arrêter » doit aussi interrompre l'installation de Harbor et le téléchargement des tâches
    // (plusieurs minutes) : sinon « Déplacer », qui attend la fin du test, attendrait avec lui.
    const track = (proc: ChildProcess): void => {
      current = proc
    }
    await ensureHarbor((step) => emit({ step }), track)
    if (!stopRequested) tasks = await ensureTasks((step) => emit({ step }), track)
    current = null
    if (!stopRequested) {
      emit({ step: t('tbench.preparingModel'), tasksTotal: tasks.length })
      await pullModelIfMissing(model, (line) => emit({ step: line }))
    }

    const results = await readResults()
    const key = runKey(model, attempts)
    const previous = results.runs[key]
    // Une reprise garde la fenêtre de son premier lancement, même si la carte est plus chargée ce jour-là : jamais
    // deux réglages différents dans un même score.
    let numCtx = previous?.numCtx ?? null
    if (numCtx === null && !stopRequested) {
      emit({ step: t('tbench.fittingContext') })
      numCtx = await chooseContext(model)
    }
    // Un test commencé avant l'étape 351 (fenêtre fixe, rien d'enregistré) ne continue que si la nouvelle fenêtre
    // est la même ; sinon il repart de zéro (Léo : « oui », en sachant qu'il faut relancer depuis le début).
    const legacyCtx = await fitToModelContext(model, MIN_BENCH_CTX)
    numCtx ??= legacyCtx
    const keep = previous !== undefined && (previous.numCtx ?? legacyCtx) === numCtx
    run = keep
      ? previous
      : {
          model,
          attempts,
          numCtx,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          seconds: 0,
          tasks: {}
        }
    run.numCtx = numCtx
    results.runs[key] = run
    emit({ numCtx })
    refresh()

    for (const task of tasks) {
      if (stopRequested) break
      if (run.tasks[task]) continue
      taskStarted = Date.now()
      const jobName = jobNameFor(model, task, attempts)
      const jobDir = join(jobsDir(), jobName)
      // Un essai interrompu (Jaris fermé, PC éteint) est refait en entier : jamais un mélange de deux lancements.
      await rm(jobDir, { recursive: true, force: true })
      liveJobDir = jobDir
      emit({
        phase: 'running',
        currentTask: task,
        step: t('tbench.runningTask', { task }),
        live: {
          trial: 1,
          trialsDone: 0,
          stage: 'starting',
          steps: 0,
          trialStartedAt: null,
          lastActivityAt: taskStarted
        }
      })
      refresh()
      const code = await runPython(
        [
          '-c',
          HARBOR_BOOT,
          ...harborRunArgs({
            tasksDir: tasksDir(),
            task,
            model,
            attempts,
            ollamaHost: config.ollama.host,
            numCtx,
            jobsDir: jobsDir(),
            jobName
          })
        ],
        undefined,
        (proc) => (current = proc)
      )
      current = null
      liveJobDir = null
      emit({ live: null })
      const toml = await readFile(join(tasksDir(), task, 'task.toml'), 'utf8').catch(() => '')
      const image = dockerImageOf(toml)
      if (stopRequested) {
        await removeTaskContainers(image)
        break
      }
      const outcomes = await readTrialOutcomes(jobDir)
      const machineError = outcomes.find((o) => !isModelFailure(o.exception))
      if (code !== 0 || outcomes.length < attempts || machineError) {
        // Docker ou Ollama tombé : jamais compté comme une erreur du modèle (même règle que le test des modèles).
        const [dockerOk, ollamaOk] = await Promise.all([dockerState().then((s) => s === 'ready'), ollamaResponds()])
        if (!dockerOk || !ollamaOk || outcomes.length < attempts) {
          throw new Error(
            t('tbench.machineError', {
              task,
              reason: !dockerOk
                ? t('tbench.dockerStopped')
                : !ollamaOk
                  ? t('tbench.ollamaDown')
                  : (machineError?.exception ?? String(code))
            })
          )
        }
      }
      const seconds = Math.round((Date.now() - taskStarted) / 1000)
      run.tasks[task] = {
        passed: outcomes.filter((o) => o.passed).length,
        trials: outcomes.length,
        seconds
      }
      run.seconds += seconds
      await writeResults(results)
      await removeImage(image)
      taskStarted = 0
      refresh()
    }

    if (!stopRequested && Object.keys(run.tasks).length >= tasks.length) {
      run.finishedAt = new Date().toISOString()
      await writeResults(results)
      refresh()
      emit({
        phase: 'done',
        currentTask: null,
        step: t('tbench.done'),
        remainingMs: 0
      })
    } else {
      emit({ phase: 'stopped', currentTask: null, step: t('tbench.stopped') })
    }
  } catch (err) {
    emit({
      phase: 'error',
      currentTask: null,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    liveJobDir = null
    stepsCache.clear()
    clearInterval(tick)
    if (powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake)
  }
}

async function removeImage(image: string | null): Promise<void> {
  if (image) await execQuiet('docker', ['image', 'rm', '-f', image], 120_000)
}

/** Après un arrêt : Harbor n'a pas eu le temps de ranger, ses conteneurs de la tâche sont retirés ici. */
async function removeTaskContainers(image: string | null): Promise<void> {
  if (!image) return
  const list = await execQuiet('docker', ['ps', '-aq', '--filter', `ancestor=${image}`], 30_000)
  const ids = list.ok ? list.out.split(/\s+/).filter(Boolean) : []
  if (ids.length) await execQuiet('docker', ['rm', '-f', ...ids], 120_000)
}
