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

const FASTWAN_REPO = 'https://huggingface.co/Green-Sky/FastWan2.2-TI2V-5B-FullAttn-GGUF/resolve/3e8fe5537b1200654868aa24ea8d0f4012fb3a1e'
const UMT5_REPO = 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7'
/** Étape 207, cran « Original » : FastWan non compressé (bf16) et lecteur UMT5 non compressé (fp16). */
const KIJAI_REPO = 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/8260d429d19fd7a72304cad059160b95d843913f'
const COMFY_WAN21_REPO = 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d'

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
 * Étape 206 (Léo, après une vraie vidéo de 5 s : « attendre 1h05 pour ça c'est chiant », et un rendu granuleux) :
 * le modèle vidéo est FastWan 2.2 TI2V 5B — le MÊME Wan 2.2 5B, distillé par FastVideo (Apache 2.0) pour produire
 * en 3 étapes et sans double passage (CFG 1) au lieu de 20 × 2. Conseillé par un contributeur de sd.cpp face au
 * même rendu « poubelle » du 5B de base (discussion leejet/stable-diffusion.cpp#1243). MESURÉ ici sur le même
 * processeur, même description, même graine : calcul de la vidéo 214 s (Wan, 10 étapes) → 41 s (FastWan, 3), soit
 * ~10× moins qu'avec les 20 étapes d'avant ; et en 832x480, un chat roux net dans la neige, sans le grain du 5B.
 * GGUF de Green-Sky (contributeur de sd.cpp), publiés en Q6 et Q8 seulement. Lecteur de description : mêmes
 * dépôt et révision que l'étape 205. Tailles et SHA-256 lues sur l'API Hugging Face, recalculées au téléchargement.
 */
export const VIDEO_QUALITY_FILES: Record<VideoQuality, { diffusion: VideoModelFile; t5xxl: VideoModelFile }> = {
  q6: {
    diffusion: {
      role: 'diffusion',
      fileName: 'FastWan2.2-TI2V-5B-q6_k.gguf',
      label: 'le modèle vidéo (FastWan 2.2 TI2V 5B, Q6)',
      url: `${FASTWAN_REPO}/FastWan2.2-TI2V-5B-q6_k.gguf`,
      bytes: 4_210_247_200,
      sha256: '416a87e30f2328dbefd7666ac90b395ead74f443748ff31c83483ac4ac6121cc'
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
      fileName: 'FastWan2.2-TI2V-5B-q8_0.gguf',
      label: 'le modèle vidéo (FastWan 2.2 TI2V 5B, Q8)',
      url: `${FASTWAN_REPO}/FastWan2.2-TI2V-5B-q8_0.gguf`,
      bytes: 5_412_844_128,
      sha256: 'b62f50ff87c4dfa2910c6883d45015e05b709366581698b302e259e7f25c9208'
    },
    t5xxl: {
      role: 't5xxl',
      fileName: 'umt5-xxl-encoder-Q8_0.gguf',
      label: 'le lecteur de description (UMT5, Q8)',
      url: `${UMT5_REPO}/umt5-xxl-encoder-Q8_0.gguf`,
      bytes: 6_043_068_256,
      sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc'
    }
  },
  /**
   * Sans compression (étape 207). Le FastWan bf16 de Kijai est la conversion d'où viennent les GGUF de Green-Sky
   * (même nom) ; sa table des tenseurs, lue ici, est IDENTIQUE à celle du Wan 2.2 5B officiel de Comfy-Org que
   * cite la doc de sd.cpp (825 tenseurs, mêmes noms, mêmes formes — seul bf16/fp16 change) : sd.cpp le lit.
   * Le dépôt de Kijai n'affiche pas de licence ; le modèle converti est celui de FastVideo, sous Apache 2.0.
   */
  original: {
    diffusion: {
      role: 'diffusion',
      fileName: 'Wan2_2-TI2V-5B-FastWanFullAttn_bf16.safetensors',
      label: 'le modèle vidéo (FastWan 2.2 TI2V 5B, original)',
      url: `${KIJAI_REPO}/FastWan/Wan2_2-TI2V-5B-FastWanFullAttn_bf16.safetensors`,
      bytes: 9_999_659_744,
      sha256: '5f464f043fab64d43e61d6ee162316a445209c066027c4d8082d265b74ecd328'
    },
    t5xxl: {
      role: 't5xxl',
      fileName: 'umt5_xxl_fp16.safetensors',
      label: 'le lecteur de description (UMT5, original)',
      url: `${COMFY_WAN21_REPO}/split_files/text_encoders/umt5_xxl_fp16.safetensors`,
      bytes: 11_366_399_385,
      sha256: '7b8850f1961e1cf8a77cca4c964a358d303f490833c6c087d0cff4b2f99db2af'
    }
  }
}

/**
 * Fichiers des versions précédentes (Wan 2.2 5B de base en Q4/Q6/Q8, lecteur Q4) : plus jamais lus. Effacés au
 * démarrage — jusqu'à ~15 Go sinon perdus. Seuls ces NOMS exacts, dans le dossier des modèles vidéo, jamais autre chose.
 */
export const OBSOLETE_VIDEO_FILES = [
  'Wan2.2-TI2V-5B-Q4_K_M.gguf',
  'Wan2.2-TI2V-5B-Q6_K.gguf',
  'Wan2.2-TI2V-5B-Q8_0.gguf',
  'umt5-xxl-encoder-Q4_K_M.gguf'
]

export async function removeObsoleteVideoFiles(): Promise<string[]> {
  const removed: string[] = []
  for (const name of OBSOLETE_VIDEO_FILES) {
    const path = join(videoModelsDir(), name)
    if ((await sizeOf(path)) === null) continue
    await rm(path, { force: true })
    removed.push(name)
  }
  return removed
}

/** Les trois fichiers d'une qualité : son modèle vidéo, le décodeur commun, son lecteur de description. */
export function videoFilesFor(quality: VideoQuality): VideoModelFile[] {
  const { diffusion, t5xxl } = VIDEO_QUALITY_FILES[quality]
  return [diffusion, VIDEO_VAE, t5xxl]
}

/** Tous les fichiers possibles, sans doublon (le décodeur une seule fois). */
export const VIDEO_MODEL_FILES: VideoModelFile[] = [VIDEO_VAE, ...Object.values(VIDEO_QUALITY_FILES).flatMap((q) => [q.diffusion, q.t5xxl])]

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

/**
 * Ligne de commande de sd-cli pour FastWan (étape 206) : celle donnée par un contributeur de sd.cpp
 * (discussion #1243) — 3 étapes, CFG 1, planificateur lcm. Avec CFG 1, pas de second passage « négatif » :
 * le prompt négatif de Wan ne sert plus à rien, il n'est plus passé.
 */
export function buildVideoArgs({ models, prompt, output, seed, seconds, initImage }: VideoArgsInput): string[] {
  return [
    '-M', 'vid_gen',
    '--diffusion-model', models.diffusion,
    '--vae', models.vae,
    '--t5xxl', models.t5xxl,
    '-p', prompt,
    '--cfg-scale', '1.0',
    '--sampling-method', 'euler',
    '--scheduler', 'lcm',
    '--steps', '3',
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
export async function installVideoModel(quality: VideoQuality = 'q6', onLog: Log = () => {}): Promise<void> {
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
  quality: VideoQuality = 'q6'
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
