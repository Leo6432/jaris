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
  availableVideoQualities,
  normalizeVideoSeconds,
  videoQualityLabel,
  VIDEO_QUALITIES,
  type VideoQuality,
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

const WAN_REPO = 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/57437632ddd08bdcbd1508c866aa22e126ed51d2'
const UMT5_REPO = 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7'

/** Le décodeur n'existe qu'en version originale : le même pour toutes les qualités. */
const VIDEO_VAE: VideoModelFile = {
  role: 'vae',
  fileName: 'wan2.2_vae.safetensors',
  label: 'le décodeur vidéo',
  url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/ee6f4a40737a995bf5818954cfce6d59443b0f04/split_files/vae/wan2.2_vae.safetensors',
  bytes: 1_409_400_960,
  sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156'
}

/**
 * Étape 205 : le modèle vidéo et le lecteur de description, à chaque niveau de compression. Mêmes dépôts et mêmes
 * révisions figées que Q4 (étape 203), tailles et SHA-256 lues sur l'API Hugging Face (licence Apache 2.0 des deux
 * dépôts vérifiée). Les noms de fichiers Q4 n'ont pas changé : une installation existante reste valable.
 */
export const VIDEO_QUALITY_FILES: Record<VideoQuality, { diffusion: VideoModelFile; t5xxl: VideoModelFile }> = {
  q4: {
    diffusion: {
      role: 'diffusion',
      fileName: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
      label: 'le modèle vidéo (Wan 2.2 TI2V 5B, Q4)',
      url: `${WAN_REPO}/Wan2.2-TI2V-5B-Q4_K_M.gguf`,
      bytes: 3_433_116_000,
      sha256: '95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2'
    },
    t5xxl: {
      role: 't5xxl',
      fileName: 'umt5-xxl-encoder-Q4_K_M.gguf',
      label: 'le lecteur de description (UMT5, Q4)',
      url: `${UMT5_REPO}/umt5-xxl-encoder-Q4_K_M.gguf`,
      bytes: 3_655_145_312,
      sha256: '17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40'
    }
  },
  q6: {
    diffusion: {
      role: 'diffusion',
      fileName: 'Wan2.2-TI2V-5B-Q6_K.gguf',
      label: 'le modèle vidéo (Wan 2.2 TI2V 5B, Q6)',
      url: `${WAN_REPO}/Wan2.2-TI2V-5B-Q6_K.gguf`,
      bytes: 4_211_683_680,
      sha256: '355f6bee35c4c6cbd0f275112619fe8ac6f7b9b067b885723667b3bde29497c3'
    },
    t5xxl: {
      role: 't5xxl',
      fileName: 'umt5-xxl-encoder-Q6_K.gguf',
      label: 'le lecteur de description (UMT5, Q6)',
      url: `${UMT5_REPO}/umt5-xxl-encoder-Q6_K.gguf`,
      bytes: 4_667_283_296,
      sha256: '9209b4c77b34ad8cf3f06b04c6eaa27e7beeebb348a31f85e3b38a1d719b09ed'
    }
  },
  q8: {
    diffusion: {
      role: 'diffusion',
      fileName: 'Wan2.2-TI2V-5B-Q8_0.gguf',
      label: 'le modèle vidéo (Wan 2.2 TI2V 5B, Q8)',
      url: `${WAN_REPO}/Wan2.2-TI2V-5B-Q8_0.gguf`,
      bytes: 5_400_179_040,
      sha256: '57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f'
    },
    t5xxl: {
      role: 't5xxl',
      fileName: 'umt5-xxl-encoder-Q8_0.gguf',
      label: 'le lecteur de description (UMT5, Q8)',
      url: `${UMT5_REPO}/umt5-xxl-encoder-Q8_0.gguf`,
      bytes: 6_043_068_256,
      sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc'
    }
  }
}

/** Les trois fichiers d'une qualité : son modèle vidéo, le décodeur commun, son lecteur de description. */
export function videoFilesFor(quality: VideoQuality): VideoModelFile[] {
  const { diffusion, t5xxl } = VIDEO_QUALITY_FILES[quality]
  return [diffusion, VIDEO_VAE, t5xxl]
}

/** Tous les fichiers possibles, sans doublon (le décodeur une seule fois). */
export const VIDEO_MODEL_FILES: VideoModelFile[] = [VIDEO_VAE, ...Object.values(VIDEO_QUALITY_FILES).flatMap((q) => [q.diffusion, q.t5xxl])]

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

function modelPaths(quality: VideoQuality): Record<VideoModelFile['role'], string> {
  return Object.fromEntries(videoFilesFor(quality).map((f) => [f.role, join(videoModelsDir(), f.fileName)])) as Record<VideoModelFile['role'], string>
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

/** Ce qui manque sur le disque pour une qualité (fichier absent ou pas à la bonne taille). */
async function missingFiles(quality: VideoQuality): Promise<VideoModelFile[]> {
  const missing: VideoModelFile[] = []
  for (const file of videoFilesFor(quality)) {
    if ((await sizeOf(join(videoModelsDir(), file.fileName))) !== file.bytes) missing.push(file)
  }
  return missing
}

async function ensureVideoModels(quality: VideoQuality, onLog: Log): Promise<void> {
  await mkdir(videoModelsDir(), { recursive: true })
  const missing = await missingFiles(quality)
  if (missing.length) {
    const total = missing.reduce((sum, f) => sum + f.bytes, 0)
    onLog(`Modèle vidéo (${VIDEO_MODEL}, ${videoQualityLabel(quality)}) : ${formatBytes(total)} à télécharger, ça peut prendre un moment.`)
  }
  for (const file of missing) {
    await downloadVerified(file.url, join(videoModelsDir(), file.fileName), file, file.label, onLog)
  }
}

/** Refus lisible si la qualité demandée ne tient pas sur CETTE machine (revérifié côté main, jamais cru sur parole). */
async function assertQualityFits(quality: VideoQuality): Promise<void> {
  const { vramGb } = await detectGpu()
  const pick = availableVideoQualities(vramGb, detectRamGb())
  if (!pick.qualities.length) throw new Error(`Ton PC n'a pas assez de puissance pour créer des vidéos : ${pick.reason}.`)
  if (!pick.qualities.includes(quality)) {
    const level = VIDEO_QUALITIES.find((q) => q.id === quality)
    throw new Error(
      `La qualité ${videoQualityLabel(quality)} demande une carte graphique de ${level?.vramLabel} Go et ${level?.ramLabel} Go de RAM : choisis une qualité plus légère.`
    )
  }
}

/** Installé à la demande, depuis le mode Vidéo : le moteur (s'il manque) puis les fichiers de la qualité choisie. */
export async function installVideoModel(quality: VideoQuality = 'q4', onLog: Log = () => {}): Promise<void> {
  if (process.platform !== 'win32') throw new Error("La création de vidéos n'est disponible que sur Windows pour l'instant.")
  await assertQualityFits(quality)
  await ensureEngine(onLog)
  await ensureVideoModels(quality, onLog)
}

export async function isVideoQualityInstalled(quality: VideoQuality): Promise<boolean> {
  if (!(await engineReady())) return false
  return (await missingFiles(quality)).length === 0
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
  seconds: VideoSeconds = DEFAULT_VIDEO_SECONDS,
  quality: VideoQuality = 'q4'
): Promise<GeneratedVideoFile> {
  if (process.platform !== 'win32') throw new Error("La création de vidéos n'est disponible que sur Windows pour l'instant.")
  const text = cleanPrompt(prompt)
  if (!text) throw new Error("Je n'ai pas de description de la vidéo : dis-moi ce que tu veux voir.")
  await assertQualityFits(quality)
  claimEngine('video')
  let initPath: string | undefined
  try {
    if (!(await isVideoQualityInstalled(quality))) {
      throw new Error(
        `La qualité ${videoQualityLabel(quality)} n'est pas encore téléchargée : télécharge-la depuis le bouton de qualité du mode Vidéo.`
      )
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
        models: modelPaths(quality),
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
  const pick = availableVideoQualities(vramGb, detectRamGb())
  const engineMissing = !(await engineReady())
  const qualities = await Promise.all(
    pick.qualities.map(async (id) => {
      const missing = await missingFiles(id)
      const bytes = missing.reduce((sum, f) => sum + f.bytes, 0) + (engineMissing ? SD_ENGINE.bytes : 0)
      return { id, label: videoQualityLabel(id), installed: supported && !engineMissing && missing.length === 0, downloadLabel: formatBytes(bytes) }
    })
  )
  return { supported, capable: pick.qualities.length > 0, reason: pick.reason, qualities }
}
