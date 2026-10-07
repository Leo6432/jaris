import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { pythonScriptsDir } from '../paths'
import { detectGpu } from './hardwareScan'
import { claimEngine, imageEngineRoot, releaseEngine } from './imageGenerator'
import { unloadOllamaModels } from './ollama'
import { managedPythonExe, PIP_INSTALL } from './pythonRuntime'
import { generateVideo, getVideoStudioStatus } from './videoGenerator'
import { VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, videoFramesFor, videoQualityLabel, type VideoQuality } from '../../shared/videoModel'
import { formatBytes } from '../../shared/formatBytes'
import {
  DUEL_PROMPTS,
  DUEL_SECONDS,
  DUEL_SEED,
  drawDuelOrder,
  duelVideoFile,
  formatDuelDuration,
  isDuelVideoFile,
  parseDuelLine,
  type DuelChoice,
  type DuelModel,
  type DuelPromptId,
  type VideoDuelResults,
  type VideoDuelStatus
} from '../../shared/videoDuel'

/**
 * Étape 257 — duel vidéo, outil de développement (voir shared/videoDuel.ts pour le pourquoi). FastWan passe par le
 * VRAI chemin de Jaris (generateVideo, même moteur, même qualité que le mode Vidéo) ; Kandinsky 6.0 Video Lite par
 * python/video_duel.py, dans un environnement Python À PART (torch CUDA + diffusers de développement) : la voix de
 * Jaris n'utilise plus PyTorch depuis l'étape 158, et lui imposer ces versions risquerait de la casser.
 *
 * Tout est sous le dossier des modèles d'image/vidéo (donc sur le disque choisi par Léo) et effaçable d'un bouton,
 * sauf les vidéos et les résultats, qu'il garde.
 */

/** Révision exacte du dépôt Hugging Face, lue sur son API : un modèle mis à jour ne change pas le duel en silence. */
export const KANDINSKY_REPO = 'kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers'
export const KANDINSKY_REVISION = 'efbaeb9961770cc82fece5b9cb2197049d8c983c'
/** Total des fichiers de cette révision (API Hugging Face) : 16,6 Go de lecteur de description, 6,4 Go de modèle vidéo… */
const KANDINSKY_BYTES = 26_700_000_000
/** PyTorch CUDA 12.6 : le seul index qui publie torch 2.14.1 pour Windows et Python 3.12 (vérifié sur l'index). */
export const TORCH_INSTALL = ['torch==2.14.1', '--index-url', 'https://download.pytorch.org/whl/cu126'] as const
const ENV_BYTES = 4_500_000_000

export function videoDuelDir(): string {
  return join(imageEngineRoot(), 'video-duel')
}
const envDir = (): string => join(videoDuelDir(), 'python')
const envPython = (): string => join(envDir(), 'Scripts', 'python.exe')
const modelDir = (): string => join(videoDuelDir(), 'kandinsky6-lite')
const modelStamp = (): string => join(modelDir(), '.jaris-complet')
const envStamp = (): string => join(envDir(), '.jaris-deps')
export const duelOutputDir = (): string => join(videoDuelDir(), 'resultats')
const resultsPath = (): string => join(duelOutputDir(), 'resultats.json')
const requirementsPath = (): string => join(pythonScriptsDir(), 'video-duel-requirements.txt')

async function envHash(): Promise<string> {
  return createHash('sha256').update(TORCH_INSTALL.join(' ')).update(await readFile(requirementsPath(), 'utf8')).digest('hex')
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

async function envReady(): Promise<boolean> {
  return existsSync(envPython()) && (await readText(envStamp())) === (await envHash())
}

async function modelReady(): Promise<boolean> {
  return (await readText(modelStamp())) === KANDINSKY_REVISION
}

export async function readDuelResults(): Promise<VideoDuelResults | null> {
  const text = await readText(resultsPath())
  if (!text) return null
  try {
    return JSON.parse(text) as VideoDuelResults
  } catch {
    return null
  }
}

async function saveResults(results: VideoDuelResults): Promise<void> {
  await mkdir(duelOutputDir(), { recursive: true })
  await writeFile(resultsPath(), JSON.stringify(results, null, 2))
}

/** La meilleure qualité FastWan DÉJÀ téléchargée : le duel ne télécharge pas FastWan à la place du mode Vidéo. */
async function installedFastWanQuality(): Promise<VideoQuality | null> {
  const status = await getVideoStudioStatus()
  const installed = status.qualities.filter((q) => q.installed)
  return installed.length ? installed[installed.length - 1].id : null
}

let running: AbortController | null = null

export async function getVideoDuelStatus(): Promise<VideoDuelStatus> {
  const supported = process.platform === 'win32'
  const [env, model, quality, results] = await Promise.all([envReady(), modelReady(), supported ? installedFastWanQuality() : null, readDuelResults()])
  const blocker = !supported
    ? 'Le duel vidéo ne fonctionne que sous Windows.'
    : !managedPythonExe()
      ? "Le Python de Jaris n'est pas encore installé (il s'installe avec la voix)."
      : !quality
        ? "Télécharge d'abord FastWan dans le mode Vidéo : le duel utilise la qualité que tu as déjà."
        : null
  const remaining = (env ? 0 : ENV_BYTES) + (model ? 0 : KANDINSKY_BYTES)
  return {
    supported,
    blocker,
    ready: env && model,
    downloadLabel: remaining ? `environ ${formatBytes(remaining)}` : '',
    running: running !== null,
    results
  }
}

/** Lance une commande ; chaque ligne de sortie part dans `onLine`. Un arrêt demandé tue tout l'arbre de processus. */
function runProcess(exe: string, args: string[], onLine: (line: string) => void, signal: AbortSignal): Promise<{ code: number; tail: string[] }> {
  return new Promise((resolve, reject) => {
    // Les grosses roues PyTorch se désarchivent dans le TEMP : gardé sur le disque du duel, pas sur C.
    const temp = join(videoDuelDir(), '.temp')
    const proc: ChildProcess = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, TEMP: temp, TMP: temp, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' }
    })
    const tail: string[] = []
    const take = (line: string): void => {
      const text = line.trim()
      if (!text) return
      tail.push(text)
      if (tail.length > 20) tail.shift()
      onLine(text)
    }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    if (proc.stdout) createInterface({ input: proc.stdout }).on('line', take)
    if (proc.stderr) createInterface({ input: proc.stderr }).on('line', take)
    const stop = (): void => {
      if (proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => proc.kill())
      else proc.kill()
    }
    signal.addEventListener('abort', stop, { once: true })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal.removeEventListener('abort', stop)
      resolve({ code: code ?? 1, tail })
    })
  })
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Duel vidéo arrêté.')
}

async function ensureEnv(onLog: (message: string) => void, signal: AbortSignal): Promise<void> {
  if (await envReady()) return
  const python = managedPythonExe()
  if (!python) throw new Error("Le Python de Jaris n'est pas encore installé (il s'installe avec la voix).")
  await mkdir(join(videoDuelDir(), '.temp'), { recursive: true })
  await rm(envDir(), { recursive: true, force: true })
  onLog('Duel vidéo : création de son environnement Python (à part de celui de la voix)…')
  let result = await runProcess(python, ['-m', 'venv', envDir()], () => {}, signal)
  checkAborted(signal)
  if (result.code !== 0) throw new Error(`Création de l'environnement Python impossible : ${result.tail.at(-1) ?? `code ${result.code}`}`)
  onLog('Duel vidéo : installation de PyTorch pour carte NVIDIA (environ 2,5 Go, plusieurs minutes)…')
  result = await runProcess(envPython(), [...PIP_INSTALL, ...TORCH_INSTALL], (line) => onLog(`PyTorch : ${line}`), signal)
  checkAborted(signal)
  if (result.code !== 0) throw new Error(`Installation de PyTorch impossible : ${result.tail.at(-1) ?? `code ${result.code}`}`)
  onLog('Duel vidéo : installation de diffusers et de ses dépendances…')
  result = await runProcess(envPython(), [...PIP_INSTALL, '-r', requirementsPath()], (line) => onLog(`Dépendances : ${line}`), signal)
  checkAborted(signal)
  if (result.code !== 0) throw new Error(`Installation des dépendances impossible : ${result.tail.at(-1) ?? `code ${result.code}`}`)
  await writeFile(envStamp(), await envHash())
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await folderBytes(path)
    else total += await stat(path).then((s) => s.size, () => 0)
  }
  return total
}

async function ensureModel(onLog: (message: string) => void, signal: AbortSignal): Promise<void> {
  if (await modelReady()) return
  onLog(`Duel vidéo : téléchargement de Kandinsky 6 Lite (${formatBytes(KANDINSKY_BYTES)})…`)
  // L'avancement se lit sur le disque : la barre de Hugging Face, elle, réécrit sa ligne et ne donne rien de lisible.
  const timer = setInterval(() => {
    void folderBytes(modelDir()).then((bytes) => onLog(`Kandinsky : ${formatBytes(bytes)} / ${formatBytes(KANDINSKY_BYTES)} téléchargés`))
  }, 5000)
  try {
    const code =
      'import sys\nfrom huggingface_hub import snapshot_download\n' +
      'snapshot_download(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3])\n'
    const result = await runProcess(envPython(), ['-c', code, KANDINSKY_REPO, KANDINSKY_REVISION, modelDir()], () => {}, signal)
    checkAborted(signal)
    if (result.code !== 0) throw new Error(`Téléchargement de Kandinsky impossible : ${result.tail.at(-1) ?? `code ${result.code}`}`)
  } finally {
    clearInterval(timer)
  }
  await mkdir(modelDir(), { recursive: true })
  await writeFile(modelStamp(), KANDINSKY_REVISION)
}

function describeMachine(gpu: { name: string | null; vramGb: number | null }): string {
  return gpu.name ? `${gpu.name}${gpu.vramGb ? ` (${gpu.vramGb} Go)` : ''}` : 'carte graphique inconnue'
}

/**
 * Le duel complet : préparation (une seule fois), 3 vidéos FastWan, puis 3 vidéos Kandinsky. Les résultats sont
 * enregistrés après CHAQUE vidéo : un arrêt ou une panne en route garde ce qui est déjà fait.
 */
export async function runVideoDuel(onLog: (message: string) => void): Promise<VideoDuelResults> {
  if (running) throw new Error('Le duel vidéo est déjà en cours.')
  const status = await getVideoDuelStatus()
  if (status.blocker) throw new Error(status.blocker)
  const controller = new AbortController()
  running = controller
  const signal = controller.signal
  const quality = (await installedFastWanQuality()) as VideoQuality
  const results: VideoDuelResults = {
    date: new Date().toISOString(),
    machine: describeMachine(await detectGpu().catch(() => ({ name: null, vramGb: null }))),
    fastwanQuality: videoQualityLabel(quality),
    kandinsky: { encodeSeconds: null, loadSeconds: null, offload: null, peakVramGb: null },
    videos: [],
    order: drawDuelOrder(),
    choices: {}
  }
  try {
    await mkdir(duelOutputDir(), { recursive: true })
    for (const model of ['fastwan', 'kandinsky'] as DuelModel[]) {
      for (const prompt of DUEL_PROMPTS) await rm(join(duelOutputDir(), duelVideoFile(model, prompt.id)), { force: true })
    }
    await saveResults(results)
    await ensureEnv(onLog, signal)
    await ensureModel(onLog, signal)

    for (const prompt of DUEL_PROMPTS) {
      checkAborted(signal)
      onLog(`FastWan : vidéo « ${prompt.label} »…`)
      const started = Date.now()
      await generateVideo(prompt.prompt, (line) => onLog(`FastWan « ${prompt.label} » : ${line}`), signal, undefined, DUEL_SECONDS, quality, {
        seed: DUEL_SEED,
        output: join(duelOutputDir(), duelVideoFile('fastwan', prompt.id))
      })
      const seconds = (Date.now() - started) / 1000
      results.videos.push({ prompt: prompt.id, model: 'fastwan', file: duelVideoFile('fastwan', prompt.id), seconds })
      await saveResults(results)
      onLog(`FastWan « ${prompt.label} » : faite en ${formatDuelDuration(seconds)}.`)
    }

    checkAborted(signal)
    // Une seule chose à la fois sur la carte graphique, comme pour les images et les vidéos de Jaris.
    claimEngine('video')
    try {
      const unloaded = await unloadOllamaModels()
      if (unloaded.length) onLog(`Carte graphique libérée pour Kandinsky (${unloaded.join(', ')} déchargé).`)
      const jobsPath = join(duelOutputDir(), 'descriptions.json')
      await writeFile(jobsPath, JSON.stringify(DUEL_PROMPTS.map((p) => ({ name: p.id, prompt: p.prompt }))))
      let failure: string | null = null
      const result = await runProcess(
        envPython(),
        [
          join(pythonScriptsDir(), 'video_duel.py'),
          '--model', modelDir(),
          '--out', duelOutputDir(),
          '--jobs', jobsPath,
          '--width', String(VIDEO_WIDTH),
          '--height', String(VIDEO_HEIGHT),
          '--frames', String(videoFramesFor(DUEL_SECONDS)),
          '--fps', String(VIDEO_FPS),
          '--seed', String(DUEL_SEED)
        ],
        (line) => {
          const event = parseDuelLine(line)
          if (!event) return
          if (event.event === 'progress') onLog(event.message)
          else if (event.event === 'error') failure = event.message
          else if (event.event === 'result') {
            results.videos.push({ prompt: event.name, model: 'kandinsky', file: duelVideoFile('kandinsky', event.name), seconds: event.seconds })
            results.kandinsky.offload = event.offload
            results.kandinsky.peakVramGb = Math.max(results.kandinsky.peakVramGb ?? 0, event.peak_vram_gb ?? 0) || null
            void saveResults(results)
            onLog(`Kandinsky « ${event.name} » : faite en ${formatDuelDuration(event.seconds)}.`)
          } else if (event.event === 'done') {
            results.kandinsky.encodeSeconds = event.encode_seconds
            results.kandinsky.loadSeconds = event.load_seconds
          }
        },
        signal
      )
      checkAborted(signal)
      if (result.code !== 0) throw new Error(`Kandinsky s'est arrêté : ${failure ?? result.tail.at(-1) ?? `code ${result.code}`}`)
    } finally {
      releaseEngine()
    }
    await saveResults(results)
    return results
  } catch (err) {
    results.error = err instanceof Error ? err.message : String(err)
    await saveResults(results).catch(() => {})
    throw err
  } finally {
    running = null
  }
}

export function cancelVideoDuel(): void {
  running?.abort()
}

/** Le nom vient de l'écran : revérifié ici, jamais un chemin. */
export async function readDuelVideo(file: string): Promise<Buffer> {
  if (!isDuelVideoFile(file)) throw new Error('Vidéo du duel inconnue.')
  return readFile(join(duelOutputDir(), file))
}

export async function setDuelChoice(prompt: DuelPromptId, choice: DuelChoice): Promise<VideoDuelResults | null> {
  const results = await readDuelResults()
  if (!results) return null
  results.choices[prompt] = choice
  await saveResults(results)
  return results
}

/** Efface ce qui ne sert qu'à relancer le duel (environnement Python et Kandinsky, ~31 Go) ; garde vidéos et résultats. */
export async function deleteVideoDuelFiles(): Promise<void> {
  if (running) throw new Error('Arrête le duel vidéo avant d’effacer ses fichiers.')
  await rm(envDir(), { recursive: true, force: true })
  await rm(modelDir(), { recursive: true, force: true })
  await rm(join(videoDuelDir(), '.temp'), { recursive: true, force: true })
}
