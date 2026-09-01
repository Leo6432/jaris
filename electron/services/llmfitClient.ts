import { execFile, execSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { createWriteStream, existsSync } from 'fs'
import { chmod, copyFile, mkdir, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { config } from '../config'
import { isUp, waitUntil } from './dependencyServices'

const execFileAsync = promisify(execFile)

type LogFn = (message: string) => void

const REPO = 'AlexsJones/llmfit'
const BINARY_NAME = process.platform === 'win32' ? 'llmfit.exe' : 'llmfit'
const INSTALL_DIR = join(app.getPath('userData'), 'llmfit')
const BINARY_PATH = join(INSTALL_DIR, BINARY_NAME)

/** Process `llmfit serve` lancé par Jaris lui-même — voir stopLlmfitIfStartedByJaris, même logique que ollamaProcessStartedByJaris dans dependencyServices.ts. */
let llmfitProcessStartedByJaris: ChildProcess | null = null

/** Triplet Rust ciblé par les binaires publiés (voir .github/workflows/release.yml du dépôt llmfit) : seuls x86_64/aarch64 sur Windows/macOS/Linux ont un binaire précompilé. */
function targetTriple(): string | null {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  if (!arch) return null
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'linux') return `${arch}-unknown-linux-musl`
  return null
}

/**
 * Résout le tag de la dernière release via la redirection HTTP de /releases/latest (comme le fait
 * l'installeur officiel install.sh) plutôt que l'API GitHub, limitée à 60 requêtes/heure sans
 * authentification — `response.url` reflète l'URL finale une fois la redirection suivie.
 */
async function fetchLatestTag(): Promise<string> {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`)
  const match = response.url.match(/\/tag\/([^/]+)$/)
  if (!match) throw new Error('Impossible de déterminer la dernière version de llmfit.')
  return match[1]
}

async function findFileRecursive(dir: string, fileName: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, fileName)
      if (found) return found
    } else if (entry.name === fileName) {
      return full
    }
  }
  return null
}

/**
 * Télécharge et installe llmfit une seule fois (rien à refaire au lancement suivant, voir existsSync en
 * tête de fonction) : l'archive de release contient un sous-dossier (nom de l'asset) avec le binaire dedans
 * plus README/LICENSE — findFileRecursive retrouve le binaire quel que soit ce sous-dossier plutôt que de
 * supposer une structure figée.
 */
async function ensureLlmfitDownloaded(log: LogFn): Promise<boolean> {
  if (existsSync(BINARY_PATH)) return true

  const triple = targetTriple()
  if (!triple) {
    log(`llmfit ne propose pas de binaire précompilé pour cette plateforme (${process.platform}/${process.arch}) : estimation rapide indisponible.`)
    return false
  }

  const isWindows = process.platform === 'win32'
  let archivePath: string | null = null
  let extractDir: string | null = null

  try {
    log('Téléchargement de llmfit (estimation rapide de vitesse, une seule fois)…')
    const tag = await fetchLatestTag()
    const asset = `llmfit-${tag}-${triple}${isWindows ? '.zip' : '.tar.gz'}`
    const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`

    await mkdir(INSTALL_DIR, { recursive: true })
    archivePath = join(INSTALL_DIR, asset)
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`téléchargement échoué (HTTP ${response.status}) — vérifie ${url}`)
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath))

    extractDir = join(INSTALL_DIR, 'extract')
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })

    if (isWindows) {
      // PowerShell plutôt qu'une dépendance npm de décompression : déjà présent sur tout Windows, aucune
      // brique de plus à installer/empaqueter.
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`],
        { windowsHide: true }
      )
    } else {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir])
    }

    const found = await findFileRecursive(extractDir, BINARY_NAME)
    if (!found) throw new Error("binaire introuvable dans l'archive téléchargée")
    await copyFile(found, BINARY_PATH)
    if (!isWindows) await chmod(BINARY_PATH, 0o755)

    log('llmfit téléchargé.')
    return true
  } catch (err) {
    log(`Échec du téléchargement de llmfit : ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    if (archivePath) await rm(archivePath, { force: true })
    if (extractDir) await rm(extractDir, { recursive: true, force: true })
  }
}

/** Démarre `llmfit serve` si l'API ne répond pas déjà, en téléchargeant le binaire au besoin. */
async function ensureLlmfitRunning(log: LogFn): Promise<boolean> {
  const healthUrl = `http://127.0.0.1:${config.llmfit.port}/health`
  if (await isUp(healthUrl)) return true

  const downloaded = await ensureLlmfitDownloaded(log)
  if (!downloaded) return false

  log('Démarrage de llmfit…')
  const proc = spawn(BINARY_PATH, ['serve', '--port', String(config.llmfit.port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  proc.on('error', (err) => log(`Échec du démarrage de llmfit : ${err.message}`))
  proc.unref()
  llmfitProcessStartedByJaris = proc

  const up = await waitUntil(() => isUp(healthUrl), 15000)
  log(up ? 'llmfit démarré.' : 'llmfit ne répond pas : estimation rapide indisponible pour cette fois.')
  return up
}

/** Arrête llmfit uniquement si c'est cette instance de Jaris qui l'a démarré — même logique que stopOllamaIfStartedByJaris. */
export function stopLlmfitIfStartedByJaris(): void {
  const pid = llmfitProcessStartedByJaris?.pid
  llmfitProcessStartedByJaris = null
  if (pid === undefined) return

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid)
    }
  } catch {
    // Rien de plus à faire : au pire llmfit continue de tourner en arrière-plan.
  }
}

interface LlmfitApiSystemResponse {
  system?: {
    total_ram_gb?: number
    gpu_vram_gb?: number | null
    gpu_name?: string | null
    has_gpu?: boolean
  }
}

interface LlmfitApiModelRow {
  name: string
  fit_label: string
  estimated_tps: number | null
  estimate_confidence_label: string
  capability_ids?: string[]
  memory_required_gb: number
  ollama_name: string | null
}

interface LlmfitApiModelsResponse {
  models: LlmfitApiModelRow[]
}

/**
 * Familles Ollama vérifiées à la main (badge "tools" réel sur ollama.com/library/<nom>) plutôt que la
 * devinette de llmfit par le nom du modèle (capability_ids "tool_use", voir llmfit-core/src/models.rs :
 * `name.contains("qwen3") || name.contains("gemma-3")...`). Vérification exhaustive faite le 2026-09-01 :
 * les 61 familles Ollama présentes dans le catalogue llmfit complet (8271 modèles scannés, --memory 999G
 * --ram 999G pour ignorer tout filtre matériel) ont chacune été vérifiées une par une contre le vrai badge
 * "tools" de leur page ollama.com/library — 29 confirmées ci-dessous, 32 rejetées (voir le tableau dans la
 * conversation/commit pour le détail des rejetées, notamment les faux positifs chez llmfit : gemma3,
 * gemma3n, codellama, qwen2.5vl, llama3.2-vision, nous-hermes2-mixtral disent "tool_use" chez llmfit mais
 * n'ont aucun badge réel). À réviser si Ollama publie de nouvelles familles pertinentes.
 */
const OLLAMA_VERIFIED_TOOL_FAMILIES = new Set([
  'command-a',
  'command-r',
  'command-r-plus',
  'deepseek-r1',
  'devstral',
  'hermes3',
  'lfm2',
  'lfm2.5',
  'lfm2.5-thinking',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'mistral',
  'mistral-large',
  'mistral-nemo',
  'mistral-small',
  'mistral-small3.1',
  'mixtral',
  'nemotron',
  'phi4-mini',
  'qwen2',
  'qwen2.5',
  'qwen2.5-coder',
  'qwen3',
  'qwen3-coder',
  'qwen3-coder-next',
  'qwen3.5',
  'qwen3.8',
  'qwq'
])

/** Famille = tout avant les ":" (ex: "qwen2.5-coder:7b" -> "qwen2.5-coder"), la granularité à laquelle Ollama partage un même template de conversation entre tailles. */
function ollamaFamily(ollamaName: string): string {
  return ollamaName.split(':')[0]
}

export interface QuickEstimateModel {
  name: string
  ollamaName: string
  estimatedTokPerSec: number | null
  confidence: string
  fitLabel: string
  memoryRequiredGb: number
}

export interface QuickEstimateResult {
  available: boolean
  /** Raison de l'indisponibilité (téléchargement/démarrage échoué), affichée telle quelle à l'utilisateur — null si available. */
  reason: string | null
  gpuName: string | null
  vramGb: number | null
  ramGb: number | null
  models: QuickEstimateModel[]
}

const EMPTY_RESULT: Omit<QuickEstimateResult, 'available' | 'reason'> = {
  gpuName: null,
  vramGb: null,
  ramGb: null,
  models: []
}

/**
 * Estimation instantanée (sans rien télécharger ni exécuter, voir README) de ce qui tourne bien sur le
 * matériel détecté. Filtre volontairement le catalogue llmfit (~13 000 entrées auto-découvertes sur
 * HuggingFace, en grande partie du bruit — voir hf_models.json dans le dépôt) à ce qui est réellement
 * utilisable par Jaris : installable via Ollama (ollama_name renseigné) ET dans OLLAMA_VERIFIED_TOOL_FAMILIES
 * — jamais le champ capability_ids "tool_use" de llmfit tel quel, deviné par le nom du modèle et confirmé
 * faux positif sur plusieurs familles (gemma3, codellama...), voir le commentaire de la constante.
 */
export async function getQuickEstimate(log: LogFn, limit = 20): Promise<QuickEstimateResult> {
  const up = await ensureLlmfitRunning(log)
  if (!up) {
    return { available: false, reason: "llmfit n'a pas pu démarrer.", ...EMPTY_RESULT }
  }

  try {
    const base = `http://127.0.0.1:${config.llmfit.port}`
    const [systemRes, modelsRes] = await Promise.all([
      fetch(`${base}/api/v1/system`),
      fetch(`${base}/api/v1/models/top?min_fit=good&sort=score&limit=100`)
    ])
    if (!systemRes.ok || !modelsRes.ok) {
      throw new Error(`llmfit a répondu ${systemRes.status}/${modelsRes.status}`)
    }

    const systemData = (await systemRes.json()) as LlmfitApiSystemResponse
    const modelsData = (await modelsRes.json()) as LlmfitApiModelsResponse

    const models: QuickEstimateModel[] = modelsData.models
      .filter((m) => m.ollama_name && OLLAMA_VERIFIED_TOOL_FAMILIES.has(ollamaFamily(m.ollama_name)))
      .slice(0, limit)
      .map((m) => ({
        name: m.name,
        ollamaName: m.ollama_name as string,
        estimatedTokPerSec: m.estimated_tps,
        confidence: m.estimate_confidence_label,
        fitLabel: m.fit_label,
        memoryRequiredGb: m.memory_required_gb
      }))

    return {
      available: true,
      reason: null,
      gpuName: systemData.system?.gpu_name ?? null,
      vramGb: systemData.system?.gpu_vram_gb ?? null,
      ramGb: systemData.system?.total_ram_gb ?? null,
      models
    }
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      ...EMPTY_RESULT
    }
  }
}
