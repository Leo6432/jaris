import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { downloadToFile } from './download'
import { resourcesRoot } from '../paths'
import { MONTAGE_PACK_ASSET, REMOTION_VERSION } from '../../shared/montage'
import type { MontageInstallProgress, MontageStatus } from '../../shared/ipc'

/**
 * Montage vidéo (étape 189, Léo : « un bouton montage à gauche qui n'est pas installé par défaut, faut cliquer
 * et il te dit que c'est lourd, et ça fait avec Remotion »).
 *
 * Remotion est un ensemble de paquets npm (plus webpack, esbuild et un navigateur pour filmer chaque image) :
 * Léo n'a ni Node ni npm. La CI Windows installe donc le paquet exact (montage/package-lock.json) et le publie
 * en .zip avec la Release ; Jaris le télécharge à la demande, puis Remotion télécharge son propre navigateur
 * (Chrome Headless Shell). Le rendu tourne ensuite avec le Node embarqué dans Electron
 * (`ELECTRON_RUN_AS_NODE=1`), via montage/render.cjs livré avec Jaris.
 *
 * Licence de Remotion (vérifiée sur son LICENSE.md) : gratuite pour un particulier, une entreprise de 3
 * personnes au plus ou une association ; ce n'est PAS un logiciel libre. L'écran d'installation le dit.
 */

const REPO = 'Leo6432/jaris'

/** `%LOCALAPPDATA%\Jaris\montage`, à côté du moteur d'images, et suivi par « Déplacer » (modelsLocation.ts). */
export function montageRoot(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'Jaris', 'montage')
}

function packNodeModules(): string {
  return join(montageRoot(), 'node_modules')
}

/** Marqueur écrit en DERNIER : un paquet présent sans lui est une installation interrompue, à refaire. */
function installedMarker(): string {
  return join(montageRoot(), '.installed')
}

/** render.cjs est livré avec Jaris (extraResources), pas dans le paquet : il peut évoluer sans retéléchargement. */
export function montageRunnerScript(): string {
  return join(resourcesRoot(), 'montage', 'render.cjs')
}

export function montagePackUrl(appVersion: string): string {
  return `https://github.com/${REPO}/releases/download/v${appVersion}/${MONTAGE_PACK_ASSET}`
}

export async function getMontageStatus(): Promise<MontageStatus> {
  const supported = process.platform === 'win32'
  const marker = await readFile(installedMarker(), 'utf-8').catch(() => '')
  return { supported, installed: supported && marker.trim() === REMOTION_VERSION && existsSync(packNodeModules()) }
}

/** Un évènement du programme de rendu (une ligne JSON sur sa sortie, voir montage/render.cjs). */
export type RunnerEvent =
  | { event: 'progress'; stage: 'browser' | 'bundle' | 'render'; progress: number }
  | { event: 'metadata'; items: VideoFileMetadata[] }
  | { event: 'done' }
  | { event: 'error'; stage: 'browser' | 'bundle' | 'render' | 'probe'; message: string }

/** Durée et format d'une vidéo de Léo (étape 190), lus par le compositeur de Remotion. */
export interface VideoFileMetadata {
  file: string
  durationInSeconds: number | null
  width: number
  height: number
  fps: number
}

export interface RunnerJob {
  action: 'ensure-browser' | 'render' | 'probe'
  projectDir?: string
  output?: string
  files?: string[]
}

/** Levée quand Léo arrête lui-même le rendu : même nom que les autres arrêts, reconnu sans `instanceof`. */
function stoppedError(): Error {
  const err = new Error('Rendu arrêté.')
  err.name = 'AbortError'
  return err
}

function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    kill()
  }
}

/**
 * Lance montage/render.cjs sur une tâche. La tâche passe par un fichier JSON, jamais par la ligne de
 * commande : le chemin du projet vient des données de Léo et n'a pas à être interprété par qui que ce soit.
 * Rejette avec le message RÉEL de Remotion (l'étape en cause est dans `stage`).
 */
export async function runMontageRunner(
  job: RunnerJob,
  onProgress: (stage: 'browser' | 'bundle' | 'render', progress: number) => void,
  signal?: AbortSignal,
  onEvent?: (event: RunnerEvent) => void
): Promise<void> {
  if (signal?.aborted) throw stoppedError()
  await mkdir(montageRoot(), { recursive: true })
  const jobFile = join(montageRoot(), `job-${process.pid}-${Date.now()}.json`)
  await writeFile(jobFile, JSON.stringify({ ...job, nodeModules: packNodeModules() }), 'utf-8')

  try {
    await new Promise<void>((resolve, reject) => {
      // Le dossier courant décide où Remotion range son navigateur (node_modules/.remotion du paquet).
      const proc = spawn(process.execPath, [montageRunnerScript(), jobFile], {
        cwd: montageRoot(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let settled = false
      let failure: { stage: string; message: string } | null = null
      const stderrTail: string[] = []

      const onAbort = (): void => {
        if (settled) return
        settled = true
        killTree(proc.pid, () => proc.kill())
        reject(stoppedError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      createInterface({ input: proc.stdout }).on('line', (line) => {
        let payload: RunnerEvent
        try {
          payload = JSON.parse(line)
        } catch {
          return
        }
        onEvent?.(payload)
        if (payload.event === 'progress') onProgress(payload.stage, payload.progress)
        else if (payload.event === 'error') failure = { stage: payload.stage, message: payload.message }
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        stderrTail.push(chunk)
        if (stderrTail.length > 20) stderrTail.shift()
      })
      proc.on('error', (err) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Le programme de rendu n'a pas pu démarrer : ${err.message}`))
      })
      proc.on('close', (code) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (code === 0 && !failure) return resolve()
        const error = new MontageRunnerError(
          failure?.stage ?? 'render',
          failure?.message ?? (stderrTail.join('').trim().slice(-1500) || `le programme de rendu s'est arrêté (code ${code})`)
        )
        reject(error)
      })
    })
  } finally {
    await rm(jobFile, { force: true })
  }
}

/**
 * Étape 190 : durée et format des vidéos que Léo joint au Montage. Le modèle ne voit pas les images : ces
 * chiffres sont tout ce qu'il sait d'une vidéo, et c'est ce qui lui permet de couper au bon endroit.
 */
export async function probeMontageVideos(files: string[]): Promise<VideoFileMetadata[]> {
  if (!files.length) return []
  let items: VideoFileMetadata[] = []
  try {
    await runMontageRunner({ action: 'probe', files }, () => {}, undefined, (event) => {
      if (event.event === 'metadata') items = event.items
    })
  } catch (err) {
    throw new Error(`Cette vidéo n'a pas pu être lue (format non reconnu ou fichier abîmé) : ${err instanceof Error ? err.message : String(err)}`)
  }
  return items
}

/** Échec rapporté par Remotion lui-même, avec l'étape en cause : le code (bundle/render) ou le navigateur. */
export class MontageRunnerError extends Error {
  constructor(
    readonly stage: string,
    message: string
  ) {
    super(message)
    this.name = 'MontageRunnerError'
  }
}

function runExecFile(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Installe le Montage : paquet Remotion (Release GitHub de CETTE version de Jaris), puis navigateur de rendu.
 * Tout passe par un dossier temporaire : un paquet à moitié décompressé ne remplace jamais un paquet valide,
 * et le marqueur n'est écrit qu'à la toute fin.
 */
export async function installMontage(onProgress: (progress: MontageInstallProgress) => void): Promise<void> {
  if (process.platform !== 'win32') throw new Error("Le Montage n'est disponible que sur Windows pour l'instant.")
  const root = montageRoot()
  await mkdir(root, { recursive: true })
  const zip = join(root, 'pack.zip.download')

  onProgress({ phase: 'download', percent: 0 })
  await downloadToFile(montagePackUrl(app.getVersion()), zip, {
    onProgress: ({ percent }) => onProgress({ phase: 'download', percent })
  })

  onProgress({ phase: 'extract', percent: null })
  const staging = join(root, 'pack.new')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // tar.exe (bsdtar, livré avec Windows 10 et 11) lit les .zip : deux chemins en arguments, aucun shell.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  try {
    await runExecFile(tar, ['-xf', zip, '-C', staging])
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(`Impossible de décompresser le Montage : ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await rm(zip, { force: true })
  }
  if (!existsSync(join(staging, 'node_modules', '@remotion', 'renderer', 'package.json'))) {
    await rm(staging, { recursive: true, force: true })
    throw new Error('Le paquet Montage téléchargé est incomplet (Remotion introuvable dedans) : réessaie.')
  }

  await rm(installedMarker(), { force: true })
  await rm(packNodeModules(), { recursive: true, force: true })
  await rename(join(staging, 'node_modules'), packNodeModules())
  await rename(join(staging, 'package.json'), join(root, 'package.json')).catch(() => {})
  await rm(staging, { recursive: true, force: true })

  onProgress({ phase: 'browser', percent: 0 })
  try {
    await runMontageRunner({ action: 'ensure-browser' }, (_stage, progress) => onProgress({ phase: 'browser', percent: Math.round(progress * 100) }))
  } catch (err) {
    throw new Error(`Le navigateur qui filme les vidéos n'a pas pu être téléchargé : ${err instanceof Error ? err.message : String(err)}`)
  }
  await writeFile(installedMarker(), REMOTION_VERSION, 'utf-8')
}

/** Retire le Montage (paquet + navigateur). Les vidéos déjà faites restent : ce sont des données de Léo. */
export async function uninstallMontage(): Promise<void> {
  await rm(montageRoot(), { recursive: true, force: true })
}
