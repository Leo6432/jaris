import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readdirSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'

/**
 * Installe et gère le Python de Jaris (étape 16 du roadmap).
 *
 * En développement, Python est installé à la main par le développeur (`python -m venv`, `pip install -r
 * python/requirements.txt`) et `PYTHON_BIN` du .env pointe dessus. Pour le public, ces commandes n'existent
 * pas : l'application télécharge elle-même un Python autonome et y installe ses dépendances au premier
 * lancement, sans jamais ouvrir de terminal.
 *
 * "Autonome" (python-build-standalone, le même que celui utilisé par `uv`) veut dire un Python complet qui
 * se décompresse dans un dossier et fonctionne tel quel : rien à installer sur la machine, rien qui touche
 * au Python que l'utilisateur a peut-être déjà, et donc aucun risque de casser un environnement existant
 * ou d'entrer en conflit avec lui.
 */

/** Dossier de travail de Jaris hors du dossier d'installation : survit à une mise à jour de l'application. */
function jarisDataDir(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'Jaris')
}

function runtimeDir(): string {
  return join(jarisDataDir(), 'python-runtime')
}

/**
 * Marque une installation terminée ET à jour : contient l'empreinte de requirements.txt au moment de
 * l'installation. Comparer cette empreinte (plutôt que de simplement tester l'existence du dossier) fait
 * que l'ajout d'une dépendance dans une future version de Jaris redéclenche tout seul l'installation des
 * paquets manquants, sans que l'utilisateur ait à s'en rendre compte (voir aussi étape 20, mise à jour
 * automatique de l'application).
 */
function stampPath(): string {
  return join(runtimeDir(), '.jaris-deps')
}

function requirementsPath(): string {
  return join(pythonScriptsDir(), 'requirements.txt')
}

/** Cherche python.exe dans l'arborescence extraite plutôt que de supposer où l'archive l'a placé. */
function findPythonExe(dir: string, depth = 0): string | null {
  if (depth > 3 || !existsSync(dir)) return null
  const entries = readdirSync(dir, { withFileTypes: true })
  const exe = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'python.exe')
  if (exe) return join(dir, exe.name)
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const found = findPythonExe(join(dir, entry.name), depth + 1)
    if (found) return found
  }
  return null
}

/** Le Python installé par Jaris, ou `null` s'il n'a pas encore été installé sur cette machine. */
export function managedPythonExe(): string | null {
  return findPythonExe(runtimeDir())
}

/**
 * Le Python à utiliser pour lancer les sidecars : celui installé par Jaris s'il existe, sinon `PYTHON_BIN`
 * du .env (le cas du développement, où l'environnement est monté à la main). Jamais l'inverse : une
 * installation gérée par Jaris a forcément les bonnes dépendances, alors qu'un `python` du PATH peut être
 * n'importe quelle version sans rien d'installé.
 */
export function resolvePythonBin(): string {
  return managedPythonExe() ?? config.python.bin
}

async function requirementsHash(): Promise<string> {
  const content = await readFile(requirementsPath(), 'utf8')
  return createHash('sha256').update(content).digest('hex')
}

/** true si Python ET les dépendances de la version actuelle de Jaris sont déjà installés. */
export async function isPythonRuntimeReady(): Promise<boolean> {
  if (!managedPythonExe()) return false
  try {
    return (await readFile(stampPath(), 'utf8')).trim() === (await requirementsHash())
  } catch {
    // Pas de marqueur (installation interrompue en plein milieu, par exemple) : à refaire.
    return false
  }
}

export type InstallProgress = (message: string, percent?: number) => void

/** Lance une commande en relayant sa sortie ligne par ligne, pour que l'utilisateur voie que ça avance. */
function run(exe: string, args: string[], onProgress: InstallProgress): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true })
    const relay = (chunk: Buffer): void => {
      const line = chunk.toString().trim().split('\n').pop()?.trim()
      if (line) onProgress(line)
    }
    proc.stdout?.on('data', relay)
    proc.stderr?.on('data', relay)
    // spawn() signale un exécutable introuvable de façon asynchrone via 'error', jamais en levant
    // directement : sans ce listener, Node en ferait une exception non rattrapée qui planterait Jaris.
    proc.on('error', reject)
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

const PYTHON_RELEASES_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'

/**
 * Version de Python visée. Volontairement pas la toute dernière : les paquets scientifiques (torch en
 * tête) publient leurs versions compilées pour Windows avec plusieurs mois de retard sur une nouvelle
 * version de Python, et `pip install` échouerait faute de version compatible.
 */
const PYTHON_SERIES = '3.12'

/**
 * L'archive Windows autonome de la dernière publication : son nom contient la date de publication
 * (ex: `cpython-3.12.11+20250630-x86_64-pc-windows-msvc-install_only.tar.gz`), impossible à deviner à
 * l'avance — d'où la recherche dans la liste publiée plutôt qu'une URL écrite en dur, qui deviendrait
 * fausse à la prochaine publication. `install_only` est la variante "prête à l'emploi" (pip inclus, sans
 * les fichiers de compilation dont Jaris n'a aucun usage).
 */
async function findPythonArchiveUrl(): Promise<string> {
  const response = await fetch(PYTHON_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`liste des versions de Python inaccessible (HTTP ${response.status})`)
  const release = (await response.json()) as { assets?: { name: string; browser_download_url: string }[] }
  const pattern = new RegExp(`^cpython-${PYTHON_SERIES.replace('.', '\\.')}\\.\\d+\\+.*-x86_64-pc-windows-msvc-install_only\\.tar\\.gz$`)
  const asset = release.assets?.find((a) => pattern.test(a.name))
  if (!asset) throw new Error(`aucune version de Python ${PYTHON_SERIES} pour Windows dans la dernière publication`)
  return asset.browser_download_url
}

/** Télécharge en signalant l'avancement : l'archive fait quelques dizaines de Mo, c'est déjà une attente. */
async function download(url: string, onProgress: InstallProgress): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`téléchargement impossible (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length') ?? 0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total > 0) {
      onProgress(`Téléchargement de Python : ${Math.round((received / total) * 100)} %`, (received / total) * 100)
    }
  }
  return Buffer.concat(chunks)
}

/** true si une carte NVIDIA est présente : décide des paquets PyTorch à installer (voir installDependencies). */
async function hasNvidiaGpu(): Promise<boolean> {
  return (await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], () => {}).catch(() => 1)) === 0
}

/**
 * Version de CUDA visée pour les paquets PyTorch. Les pilotes NVIDIA sont rétrocompatibles (un pilote
 * récent fait tourner des paquets compilés pour une version de CUDA plus ancienne), donc viser une
 * version éprouvée plutôt que la toute dernière est le choix le plus sûr : ça marche sur une machine à
 * jour comme sur une machine dont le pilote a un peu de retard.
 */
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu126'

/**
 * Installe les dépendances Python. PyTorch est traité à part et en premier : sur Windows, le paquet
 * `torch` publié sur PyPI (celui qu'installerait un simple `pip install -r requirements.txt`) est une
 * version SANS support GPU. L'installer tel quel ferait tourner la transcription sur le processeur, des
 * secondes au lieu d'une fraction de seconde sur une machine qui a pourtant une carte graphique — ce que
 * l'étape 16 interdit explicitement ("jamais une version allégée ou dégradée" par rapport au dev).
 * Si l'installation GPU échoue malgré tout (pilote trop ancien, dépôt PyTorch injoignable), on retombe
 * sur la version processeur : Jaris marchera plus lentement, mais il marchera.
 */
async function installDependencies(python: string, onProgress: InstallProgress): Promise<void> {
  if (await hasNvidiaGpu()) {
    onProgress('Carte graphique NVIDIA détectée : installation de PyTorch avec accélération GPU…')
    const code = await run(python, ['-m', 'pip', 'install', 'torch', '--index-url', TORCH_CUDA_INDEX], onProgress)
    if (code !== 0) {
      onProgress("L'installation GPU de PyTorch a échoué : repli sur la version processeur, plus lente.")
    }
  }

  onProgress('Installation des dépendances Python (plusieurs minutes)…')
  const code = await run(python, ['-m', 'pip', 'install', '-r', requirementsPath()], onProgress)
  if (code !== 0) throw new Error(`installation des dépendances Python échouée (code ${code})`)
}

/**
 * Installe Python et ses dépendances de bout en bout. Rejette avec un message lisible en cas d'échec : il
 * est affiché tel quel à l'utilisateur, qui n'a aucun terminal où aller lire une erreur.
 */
export async function installPythonRuntime(onProgress: InstallProgress): Promise<void> {
  const dir = runtimeDir()
  // Repart d'un dossier propre : une installation précédente interrompue en plein milieu laisserait une
  // arborescence à moitié extraite, dont on ne peut rien conclure de fiable.
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  onProgress('Recherche de la dernière version de Python…', 0)
  const archive = await download(await findPythonArchiveUrl(), onProgress)
  const archivePath = join(dir, 'python.tar.gz')
  await writeFile(archivePath, archive)

  onProgress('Décompression de Python…')
  // `tar` est fourni avec Windows depuis Windows 10 (build 17063) et sait lire un .tar.gz : évite
  // d'embarquer une librairie de décompression rien que pour cette étape unique.
  const extractCode = await run('tar', ['-xzf', archivePath, '-C', dir], onProgress)
  if (extractCode !== 0) throw new Error(`décompression de Python échouée (code ${extractCode})`)
  await rm(archivePath, { force: true })

  const python = findPythonExe(dir)
  if (!python) throw new Error("python.exe est introuvable dans l'archive téléchargée")

  await installDependencies(python, onProgress)
  await writeFile(stampPath(), await requirementsHash())
  onProgress('Python et ses dépendances sont installés.', 100)
}
