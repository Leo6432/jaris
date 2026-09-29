import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from './dataLocation'
import { unloadOllamaModels } from './ollama'
import { detectGpu } from './hardwareScan'
import { detectRamGb } from './systemResources'
import {
  SD_ENGINE,
  claimEngine,
  cleanPrompt,
  downloadVerified,
  engineExe,
  engineReady,
  ensureEngine,
  imageEngineRoot,
  mediaFileName,
  releaseEngine,
  runEngine,
  sizeOf,
  type Log
} from './imageGenerator'
import {
  DEFAULT_VIDEO_SECONDS,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_MODEL,
  VIDEO_WIDTH,
  normalizeVideoSeconds,
  pickVideoModel,
  videoFramesFor,
  type VideoSeconds
} from '../../shared/videoModel'
import { imageLabelFromFileName, imageTimestampFromFileName, isGeneratedVideoFileName } from '../../shared/imageGallery'
import { formatBytes } from '../../shared/formatBytes'
import type { GeneratedVideoSummary, VideoStudioStatus } from '../../shared/ipc'

/**
 * Mode Vidéo (étape 203, Léo : « ajoute vidéo : Wan 2.2-TI2V-5B »). Même moteur que les images (sd-cli de
 * stable-diffusion.cpp, déjà installé et vérifié par imageGenerator.ts), avec le mode `-M vid_gen` documenté dans
 * docs/wan.md. Vérifié AVANT d'écrire ce fichier :
 * - la version figée du moteur (SD_ENGINE) contient bien la vidéo ET l'écriture WebM (chaîne « WebM muxer » et
 *   webm.dll présentes dans le vrai sd-cli.exe téléchargé) — sans WebM compilé, sd-cli écrirait un AVI sous un
 *   nom .webm, illisible par l'écran ;
 * - les trois fichiers sont sous licence Apache 2.0, figés à une révision exacte, avec leur empreinte SHA-256
 *   lue sur Hugging Face et recalculée ici après téléchargement (downloadVerified).
 *
 * Environ 8,5 Go : jamais installé avec les autres modèles, seulement quand Léo clique « Installer » dans le
 * mode Vidéo.
 */

export interface VideoModelFile {
  role: 'diffusion' | 'vae' | 't5xxl'
  fileName: string
  label: string
  url: string
  bytes: number
  sha256: string
}

export const VIDEO_MODEL_FILES: VideoModelFile[] = [
  {
    role: 'diffusion',
    fileName: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
    label: 'le modèle vidéo (Wan 2.2 TI2V 5B)',
    url: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/57437632ddd08bdcbd1508c866aa22e126ed51d2/Wan2.2-TI2V-5B-Q4_K_M.gguf',
    bytes: 3_433_116_000,
    sha256: '95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2'
  },
  {
    role: 'vae',
    fileName: 'wan2.2_vae.safetensors',
    label: 'le décodeur vidéo',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/ee6f4a40737a995bf5818954cfce6d59443b0f04/split_files/vae/wan2.2_vae.safetensors',
    bytes: 1_409_400_960,
    sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156'
  },
  {
    role: 't5xxl',
    fileName: 'umt5-xxl-encoder-Q4_K_M.gguf',
    label: 'le lecteur de description (UMT5)',
    url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7/umt5-xxl-encoder-Q4_K_M.gguf',
    bytes: 3_655_145_312,
    sha256: '17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40'
  }
]

/**
 * Le « prompt négatif » officiel de Wan (celui des exemples de sd.cpp, écrit en chinois par Alibaba) : ce que la
 * vidéo doit éviter (flou, image figée, mains mal dessinées…). Le modèle a été entraîné avec lui.
 */
export const WAN_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

export function videoModelsDir(): string {
  return join(imageEngineRoot(), 'models', 'video')
}

/** Les vidéos créées sont des données de Léo : elles suivent ses conversations (OWNED_ENTRIES). */
export function generatedVideosDir(): string {
  return join(getDataRoot(), 'generated-videos')
}

function modelPaths(): Record<VideoModelFile['role'], string> {
  return Object.fromEntries(VIDEO_MODEL_FILES.map((f) => [f.role, join(videoModelsDir(), f.fileName)])) as Record<VideoModelFile['role'], string>
}

export interface VideoArgsInput {
  models: Record<VideoModelFile['role'], string>
  prompt: string
  output: string
  seed: number
  /** Durée choisie dans l'écran (1 à 5 s). */
  seconds: VideoSeconds
  /** Image à animer (image → vidéo), sinon la vidéo part du texte seul. */
  initImage?: string
}

/** Ligne de commande de sd-cli pour Wan 2.2 TI2V 5B, d'après l'exemple officiel de sd.cpp (docs/wan.md). */
export function buildVideoArgs({ models, prompt, output, seed, seconds, initImage }: VideoArgsInput): string[] {
  return [
    '-M', 'vid_gen',
    '--diffusion-model', models.diffusion,
    '--vae', models.vae,
    '--t5xxl', models.t5xxl,
    '-p', prompt,
    '-n', WAN_NEGATIVE_PROMPT,
    '--cfg-scale', '6.0',
    '--sampling-method', 'euler',
    '--flow-shift', '3.0',
    '-W', String(VIDEO_WIDTH),
    '-H', String(VIDEO_HEIGHT),
    '--video-frames', String(videoFramesFor(normalizeVideoSeconds(seconds))),
    '--fps', String(VIDEO_FPS),
    '-s', String(seed),
    // Mêmes économies de mémoire que les images : poids en RAM montés au besoin, décodage par morceaux.
    '--diffusion-fa',
    '--offload-to-cpu',
    '--vae-tiling',
    ...(initImage ? ['-i', initImage] : []),
    // .webm : lisible directement par l'écran de Jaris (un .avi MJPEG ne l'est pas).
    '-o', output
  ]
}

const VIDEO_WORDING = { step: 'Vidéo', finishing: 'Assemblage de la vidéo…', cancelled: 'Vidéo annulée.' }

async function ensureVideoModels(onLog: Log): Promise<void> {
  await mkdir(videoModelsDir(), { recursive: true })
  const paths = modelPaths()
  const missing = []
  for (const file of VIDEO_MODEL_FILES) {
    if ((await sizeOf(paths[file.role])) !== file.bytes) missing.push(file)
  }
  if (missing.length) {
    const total = missing.reduce((sum, f) => sum + f.bytes, 0)
    onLog(`Modèle vidéo (${VIDEO_MODEL}) : ${formatBytes(total)} à télécharger, ça peut prendre un moment.`)
  }
  for (const file of missing) {
    await downloadVerified(file.url, paths[file.role], file, file.label, onLog)
  }
}

/** Installé à la demande, depuis le mode Vidéo : le moteur (s'il manque) puis les trois fichiers du modèle. */
export async function installVideoModel(onLog: Log = () => {}): Promise<void> {
  if (process.platform !== 'win32') throw new Error("La création de vidéos n'est disponible que sur Windows pour l'instant.")
  await ensureEngine(onLog)
  await ensureVideoModels(onLog)
}

export async function isVideoModelInstalled(): Promise<boolean> {
  if (!(await engineReady())) return false
  const paths = modelPaths()
  const sizes = await Promise.all(VIDEO_MODEL_FILES.map((file) => sizeOf(paths[file.role])))
  return sizes.every((size, i) => size === VIDEO_MODEL_FILES[i].bytes)
}

export interface GeneratedVideoFile {
  path: string
  fileName: string
}

/**
 * Crée la vidéo décrite par `prompt` (et anime `initImage` s'il est donné : une image jointe). Mêmes règles que
 * les images : refus lisible avant tout calcul si le PC est trop faible ou le modèle absent, une seule chose à
 * la fois sur la carte graphique, arrêt réel sur « Arrêter ».
 */
export async function generateVideo(
  prompt: string,
  onLog: Log = () => {},
  signal?: AbortSignal,
  initImage?: { bytes: Uint8Array; extension: 'png' | 'jpg' },
  seconds: VideoSeconds = DEFAULT_VIDEO_SECONDS
): Promise<GeneratedVideoFile> {
  if (process.platform !== 'win32') throw new Error("La création de vidéos n'est disponible que sur Windows pour l'instant.")
  const text = cleanPrompt(prompt)
  if (!text) throw new Error("Je n'ai pas de description de la vidéo : dis-moi ce que tu veux voir.")
  const { vramGb } = await detectGpu()
  const pick = pickVideoModel(vramGb, detectRamGb())
  if (!pick.model) throw new Error(`Ton PC n'a pas assez de puissance pour créer des vidéos : ${pick.reason}.`)
  claimEngine('video')
  let initPath: string | undefined
  try {
    if (!(await isVideoModelInstalled())) {
      throw new Error("Le modèle vidéo n'est pas encore installé : clique « Installer le modèle vidéo » dans le mode Vidéo.")
    }
    if (signal?.aborted) throw new Error('Vidéo annulée.')

    const unloaded = await unloadOllamaModels()
    if (unloaded.length) onLog(`Carte graphique libérée pour la vidéo (${unloaded.join(', ')} déchargé).`)

    const dir = generatedVideosDir()
    await mkdir(dir, { recursive: true })
    const fileName = mediaFileName(text, new Date(), 'webm', 'video')
    const output = join(dir, fileName)
    if (initImage) {
      // Fichier temporaire à côté de la vidéo, effacé à la fin quoi qu'il arrive (finally ci-dessous).
      initPath = join(dir, `.depart-${fileName}.${initImage.extension}`)
      await writeFile(initPath, initImage.bytes)
    }
    onLog('Préparation de la vidéo…')
    await runEngine(
      engineExe(),
      buildVideoArgs({
        models: modelPaths(),
        prompt: text,
        output,
        seed: Math.floor(Math.random() * 2 ** 31),
        seconds: normalizeVideoSeconds(seconds),
        initImage: initPath
      }),
      onLog,
      signal,
      VIDEO_WORDING
    )
    if (!((await sizeOf(output)) ?? 0)) throw new Error("Le moteur a terminé sans créer de vidéo.")
    return { path: output, fileName }
  } finally {
    if (initPath) await rm(initPath, { force: true })
    releaseEngine()
  }
}

/** Les vidéos créées, les plus récentes d'abord (les anciens dossiers du Montage, eux, ne sont pas des .webm). */
export async function listGeneratedVideos(): Promise<GeneratedVideoSummary[]> {
  let names: string[]
  try {
    names = await readdir(generatedVideosDir())
  } catch {
    return []
  }
  const videos = await Promise.all(
    names.filter(isGeneratedVideoFileName).map(async (fileName) => ({
      fileName,
      label: imageLabelFromFileName(fileName),
      timestamp: imageTimestampFromFileName(fileName) ?? (await stat(join(generatedVideosDir(), fileName)).then((s) => s.mtimeMs, () => 0))
    }))
  )
  return videos.sort((a, b) => b.timestamp - a.timestamp)
}

/** Le nom vient de l'écran : revérifié ici, jamais un chemin. */
export function generatedVideoPath(fileName: string): string {
  if (!isGeneratedVideoFileName(fileName)) throw new Error('Vidéo inconnue.')
  return join(generatedVideosDir(), fileName)
}

export async function readGeneratedVideo(fileName: string): Promise<Buffer> {
  return readFile(generatedVideoPath(fileName))
}

export async function deleteGeneratedVideo(fileName: string): Promise<void> {
  await rm(generatedVideoPath(fileName), { force: true })
}

export async function getVideoStudioStatus(): Promise<VideoStudioStatus> {
  const supported = process.platform === 'win32'
  const { vramGb } = await detectGpu()
  const pick = pickVideoModel(vramGb, detectRamGb())
  const engineMissing = !(await engineReady())
  const total = VIDEO_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0) + (engineMissing ? SD_ENGINE.bytes : 0)
  return {
    supported,
    capable: pick.model !== null,
    reason: pick.reason,
    installed: supported && (await isVideoModelInstalled()),
    downloadLabel: formatBytes(total)
  }
}
