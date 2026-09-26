import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from './dataLocation'
import { downloadToFile } from './download'
import { unloadOllamaModels } from './ollama'
import { formatBytes } from '../../shared/formatBytes'

/**
 * Génération d'images en local (étape 173, Léo : « existe-t-il des modèles locaux image » puis « oui » à
 * stable-diffusion.cpp + FLUX.2 [klein] 4B).
 *
 * Choix vérifiés sur les sources primaires avant d'écrire ce fichier, jamais sur un article :
 * - **stable-diffusion.cpp** (licence MIT) : un seul programme en ligne de commande (`sd-cli.exe`), publié
 *   tout compilé pour Windows. La version Vulkan marche sur les cartes NVIDIA, AMD et Intel avec leur pilote
 *   normal — pas de CUDA à installer, 32 Mo à télécharger.
 * - **FLUX.2 [klein] 4B** (licence Apache 2.0, utilisable librement) : 4 étapes de dessin seulement, et avec
 *   `--offload-to-cpu` il tient sur une carte 8 Go. Wan2GP a été écarté pour sa licence (Léo : « il vont
 *   devoir avoir une licence »), Qwen-Image pour une licence réservée à la recherche.
 *
 * Tout est figé : version exacte du programme, révision exacte de chaque fichier de modèle sur Hugging Face,
 * et leur empreinte SHA-256 (lue sur Hugging Face et recalculée ici sur le fichier réellement téléchargé).
 * Un fichier corrompu ou remplacé en ligne est refusé plutôt que lancé.
 *
 * Premier usage : environ 5 Go à télécharger (une seule fois), avec l'avancement dans le journal du Chat.
 */

const SD_TAG = 'master-920-2f88688'
const SD_BASE_URL = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_TAG}`

export const SD_ENGINE = {
  tag: SD_TAG,
  url: `${SD_BASE_URL}/sd-master-2f88688-bin-win-vulkan-x64.zip`,
  bytes: 31_998_883,
  sha256: '63e84439c20dde75487a933066318ae01353e9e80ee70e031acad48e857e1cb9'
}

export interface ImageModelFile {
  /** Rôle dans la ligne de commande de sd-cli. */
  role: 'diffusion' | 'vae' | 'llm'
  fileName: string
  label: string
  url: string
  bytes: number
  sha256: string
}

export const IMAGE_MODEL_FILES: ImageModelFile[] = [
  {
    role: 'diffusion',
    fileName: 'flux-2-klein-4b-Q4_0.gguf',
    label: 'le modèle de dessin (FLUX.2 klein)',
    url: 'https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/3b1f5a9dc3abb32238b053aeb3d823c30afdacbd/flux-2-klein-4b-Q4_0.gguf',
    bytes: 2_460_378_560,
    sha256: 'd1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4'
  },
  {
    role: 'vae',
    fileName: 'flux2-vae.safetensors',
    label: "le décodeur d'image",
    url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/vae/diffusion_pytorch_model.safetensors',
    bytes: 168_120_878,
    sha256: 'ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04'
  },
  {
    role: 'llm',
    fileName: 'Qwen3-4B-Q4_K_M.gguf',
    label: 'le lecteur de description (Qwen3 4B)',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a5a1ad1120/Qwen3-4B-Q4_K_M.gguf',
    bytes: 2_497_281_312,
    sha256: 'f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a'
  }
]

/** Taille native de FLUX.2 klein. */
export const IMAGE_SIZE = 1024
/** 4 étapes : c'est le réglage prévu pour la version « klein » distillée (docs/flux2.md de sd.cpp). */
export const IMAGE_STEPS = 4
/** Plus rien sur la sortie de sd-cli pendant ce délai : il est considéré comme bloqué et arrêté. */
export const ENGINE_STALL_MS = 5 * 60_000
const MAX_PROMPT_CHARS = 1000

/**
 * `%LOCALAPPDATA%\Jaris\image-generation` : à côté de l'environnement Python, et déclaré comme brique dans
 * modelsLocation.ts pour suivre « Déplacer » (5 Go ne doivent pas rester sur C quand tout le reste est sur D).
 */
export function imageEngineRoot(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'Jaris', 'image-generation')
}

/** Les images dessinées sont des données de Léo : elles suivent ses conversations (OWNED_ENTRIES). */
export function generatedImagesDir(): string {
  return join(getDataRoot(), 'generated-images')
}

/**
 * La description vient du modèle de conversation, donc d'une phrase dictée : elle n'est JAMAIS passée à un
 * shell (tableau d'arguments). Les chevrons sont retirés parce que sd.cpp interprète `<lora:nom:poids>` dans
 * le texte comme une instruction de chargement de fichier, pas comme du texte à dessiner.
 */
export function cleanPrompt(prompt: string): string {
  return prompt.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS)
}

export interface SdArgsInput {
  models: Record<ImageModelFile['role'], string>
  prompt: string
  output: string
  seed: number
}

/** Ligne de commande de sd-cli pour FLUX.2 klein, telle que documentée par sd.cpp (docs/flux2.md). */
export function buildSdArgs({ models, prompt, output, seed }: SdArgsInput): string[] {
  return [
    '--diffusion-model', models.diffusion,
    '--vae', models.vae,
    '--llm', models.llm,
    '-p', prompt,
    '--cfg-scale', '1.0',
    '--steps', String(IMAGE_STEPS),
    '-W', String(IMAGE_SIZE),
    '-H', String(IMAGE_SIZE),
    '-s', String(seed),
    // Poids en RAM, montés sur la carte graphique au moment où ils servent : c'est ce qui fait tenir le
    // dessin sur une carte 8 Go. Décodage par tuiles pour la même raison (1024 px d'un coup déborderait).
    '--offload-to-cpu',
    '--diffusion-fa',
    '--vae-tiling',
    '-o', output
  ]
}

/**
 * Avancement du dessin, lu sur la sortie de sd-cli (« | 2/4 - 3.10s/it »). Le chargement des poids affiche
 * aussi des compteurs (« 67/149 - 3.31GB/s ») : seul le suffixe s/it ou it/s désigne une étape de dessin.
 */
export function parseSdProgress(line: string): { step: number; total: number } | null {
  const match = /(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:s\/it|it\/s)/.exec(line)
  if (!match) return null
  return { step: Number(match[1]), total: Number(match[2]) }
}

/** Échec de sd-cli, traduit en phrase lisible par Léo (affichée telle quelle, jamais reformulée). */
export function describeEngineFailure(code: number | null, lastLines: string[]): string {
  const text = lastLines.join('\n')
  if (/out of (device )?memory|ErrorOutOfDeviceMemory|failed to allocate/i.test(text)) {
    return "Pas assez de mémoire pour dessiner l'image (carte graphique ou RAM) : ferme les jeux ou logiciels lourds ouverts, puis redemande."
  }
  if (/vulkan/i.test(text) && /(fail|error|not found|no device)/i.test(text)) {
    return "Ta carte graphique n'a pas pu être utilisée pour dessiner (Vulkan) : mets à jour le pilote de ta carte graphique, puis redemande."
  }
  const last = lastLines.filter((l) => l.trim()).slice(-1)[0]?.trim()
  return `Le moteur d'images s'est arrêté sans finir l'image (code ${code ?? 'inconnu'})${last ? ` : ${last}` : ''}.`
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

type Log = (message: string) => void

/**
 * Télécharge `url` dans `destination` et vérifie son empreinte AVANT de le mettre à sa place définitive : un
 * fichier présent sous son nom final est donc toujours un fichier complet et vérifié.
 */
async function downloadVerified(
  url: string,
  destination: string,
  expected: { bytes: number; sha256: string },
  label: string,
  onLog: Log
): Promise<void> {
  const temporary = `${destination}.download`
  let lastLoggedPercent = -10
  await downloadToFile(url, temporary, {
    onProgress: ({ receivedBytes, percent }) => {
      if (percent === null || percent - lastLoggedPercent < 10) return
      lastLoggedPercent = percent
      onLog(`Téléchargement de ${label} : ${percent} % (${formatBytes(receivedBytes)} sur ${formatBytes(expected.bytes)})`)
    }
  })
  onLog(`Vérification de ${label}…`)
  const digest = await sha256OfFile(temporary)
  if (digest !== expected.sha256) {
    await rm(temporary, { force: true })
    throw new Error(
      `Le fichier téléchargé pour ${label} ne correspond pas à l'original (fichier abîmé pendant le téléchargement) : ` +
        'il a été effacé, redemande l’image pour le retélécharger.'
    )
  }
  await rename(temporary, destination)
}

function runExecFile(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
}

/** Programme sd-cli prêt à l'emploi (téléchargé, vérifié, décompressé au besoin). */
async function ensureEngine(onLog: Log): Promise<string> {
  const binDir = join(imageEngineRoot(), 'bin')
  const exe = join(binDir, 'sd-cli.exe')
  const stamp = join(binDir, '.version')
  if (existsSync(exe) && (await readFile(stamp, 'utf-8').catch(() => '')) === SD_ENGINE.tag) return exe

  await mkdir(imageEngineRoot(), { recursive: true })
  const zip = join(imageEngineRoot(), 'sd-cli.zip')
  onLog('Premier dessin : installation du moteur d’images (une seule fois)…')
  await downloadVerified(SD_ENGINE.url, zip, SD_ENGINE, 'le moteur d’images', onLog)
  const staging = `${binDir}.new`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // tar.exe est livré avec Windows 10 et 11 (bsdtar, qui lit les .zip) : aucun PowerShell, aucun texte à
  // interpréter, juste deux chemins passés en arguments.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  try {
    await runExecFile(tar, ['-xf', zip, '-C', staging])
  } catch (err) {
    throw new Error(`Impossible de décompresser le moteur d’images : ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!existsSync(join(staging, 'sd-cli.exe'))) {
    throw new Error("Le moteur d'images téléchargé ne contient pas sd-cli.exe : téléchargement refusé.")
  }
  await writeFile(join(staging, '.version'), SD_ENGINE.tag, 'utf-8')
  await rm(binDir, { recursive: true, force: true })
  await rename(staging, binDir)
  await rm(zip, { force: true })
  return exe
}

/** Les trois fichiers du modèle, téléchargés au besoin. Un fichier à la bonne taille a déjà été vérifié. */
async function ensureModels(onLog: Log): Promise<Record<ImageModelFile['role'], string>> {
  const dir = join(imageEngineRoot(), 'models')
  await mkdir(dir, { recursive: true })
  const paths = {} as Record<ImageModelFile['role'], string>
  const missing = []
  for (const file of IMAGE_MODEL_FILES) {
    const path = join(dir, file.fileName)
    paths[file.role] = path
    if ((await sizeOf(path)) !== file.bytes) missing.push(file)
  }
  if (missing.length) {
    const total = missing.reduce((sum, f) => sum + f.bytes, 0)
    onLog(`Premier dessin : ${formatBytes(total)} à télécharger une seule fois, ça peut prendre plusieurs minutes.`)
  }
  for (const file of missing) {
    await downloadVerified(file.url, paths[file.role], file, file.label, onLog)
  }
  return paths
}

function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    kill()
  }
}

function runEngine(exe: string, args: string[], onLog: Log, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Dessin annulé.'))
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const lastLines: string[] = []
    let lastStep = 0
    let settled = false
    let stall: ReturnType<typeof setTimeout>

    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(stall)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    const armStall = (): void => {
      clearTimeout(stall)
      stall = setTimeout(() => {
        killTree(proc.pid, () => proc.kill())
        finish(new Error(`Le moteur d'images ne donne plus signe de vie depuis ${ENGINE_STALL_MS / 60_000} minutes : arrêté.`))
      }, ENGINE_STALL_MS)
    }
    const onAbort = (): void => {
      killTree(proc.pid, () => proc.kill())
      finish(new Error('Dessin annulé.'))
    }
    signal?.addEventListener('abort', onAbort)
    armStall()

    const onData = (chunk: Buffer): void => {
      armStall()
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
        if (!line.trim()) continue
        lastLines.push(line)
        if (lastLines.length > 20) lastLines.shift()
        const progress = parseSdProgress(line)
        if (progress && progress.step !== lastStep) {
          lastStep = progress.step
          onLog(`Dessin : étape ${progress.step} sur ${progress.total}`)
          if (progress.step === progress.total) onLog("Finition de l'image…")
        }
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => finish(new Error(`Impossible de lancer le moteur d'images : ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(describeEngineFailure(code, lastLines)))
    })
  })
}

/** Nom de fichier lisible : date + début de la description. */
export function imageFileName(prompt: string, now: Date): string {
  const slug = prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${stamp}-${slug || 'image'}.png`
}

export interface GeneratedImage {
  path: string
  fileName: string
}

let busy = false

/**
 * Dessine l'image décrite par `prompt` et renvoie le fichier PNG créé. Lève une erreur au message déjà
 * lisible par Léo en cas d'échec (le court-circuit d'assistant.ts l'affiche tel quel).
 */
export async function generateImage(prompt: string, onLog: Log = () => {}, signal?: AbortSignal): Promise<GeneratedImage> {
  if (process.platform !== 'win32') throw new Error("La génération d'images n'est disponible que sur Windows pour l'instant.")
  const text = cleanPrompt(prompt)
  if (!text) throw new Error("Je n'ai pas de description de l'image à dessiner : dis-moi ce que tu veux voir.")
  if (busy) throw new Error("Je suis déjà en train de dessiner une image : attends qu'elle soit finie, puis redemande.")
  busy = true
  try {
    const exe = await ensureEngine(onLog)
    const models = await ensureModels(onLog)
    if (signal?.aborted) throw new Error('Dessin annulé.')

    // Le modèle de conversation est encore chargé sur la carte graphique (il vient de décider de dessiner) :
    // sans ce déchargement, les deux ne tiennent pas ensemble sur une carte 8 Go.
    const unloaded = await unloadOllamaModels()
    if (unloaded.length) onLog(`Carte graphique libérée pour le dessin (${unloaded.join(', ')} déchargé).`)

    const dir = generatedImagesDir()
    await mkdir(dir, { recursive: true })
    const fileName = imageFileName(text, new Date())
    const output = join(dir, fileName)
    onLog('Préparation du dessin…')
    await runEngine(exe, buildSdArgs({ models, prompt: text, output, seed: Math.floor(Math.random() * 2 ** 31) }), onLog, signal)
    if ((await sizeOf(output)) === null) {
      throw new Error("Le moteur d'images a terminé sans créer d'image.")
    }
    return { path: output, fileName }
  } finally {
    busy = false
  }
}

/** Lecture d'une image dessinée pour l'afficher dans le Chat (null si le fichier a été effacé depuis). */
export async function readGeneratedImageDataUrl(fileName: string): Promise<string | null> {
  // Seul un NOM de fichier est accepté (il vient de l'historique sur le disque) : jamais un chemin.
  if (!/^[\w.-]+\.png$/.test(fileName)) return null
  try {
    const data = await readFile(join(generatedImagesDir(), fileName))
    return `data:image/png;base64,${data.toString('base64')}`
  } catch {
    return null
  }
}
