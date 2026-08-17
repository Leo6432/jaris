import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * VRAM réservée en permanence par le sidecar STT (Cohere Transcribe, chargé une fois au démarrage de
 * Jaris et jamais déchargé) + petite marge de sécurité pour le pilote/l'OS. À soustraire du total avant
 * de choisir des modèles Ollama, sinon on risque de dépasser la VRAM réellement disponible.
 *
 * Volontairement basé sur la VRAM *totale* de la carte (fixe), pas sur la VRAM libre à l'instant du
 * scan : cette dernière varie selon ce qui tourne au même moment (jeu, navigateur...), ce qui donnerait
 * un résultat différent à chaque scan pour la même machine. Le bouton "relancer l'analyse" du menu
 * Options sert à re-choisir les modèles si la config matérielle change (nouvelle carte...), pas à
 * s'adapter à l'usage instantané du GPU.
 */
const STT_RESERVED_GB = 4.5

interface ModelCandidate {
  model: string
  vramGb: number
}

// Tailles approximatives (poids seuls, quantization par défaut) - source: ollama.com/library/qwen3.5.
// Triées du plus gros au plus petit : on prend le premier qui tient dans le budget dispo.
const FLASH_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]
const MEDIUM_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.5:9b', vramGb: 6.6 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]
const LARGE_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.5:35b', vramGb: 24 },
  { model: 'qwen3.5:27b', vramGb: 17 },
  { model: 'qwen3.5:9b', vramGb: 6.6 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]

function pickForBudget(candidates: ModelCandidate[], budgetGb: number): string {
  const fit = candidates.find((c) => c.vramGb <= budgetGb)
  return (fit ?? candidates[candidates.length - 1]).model
}

async function detectGpu(): Promise<{ name: string | null; vramGb: number | null }> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits')
    const firstLine = stdout.trim().split('\n')[0] ?? ''
    const [name, mibRaw] = firstLine.split(',').map((s) => s.trim())
    const mib = parseInt(mibRaw, 10)
    return { name: name || null, vramGb: Number.isFinite(mib) ? Math.round((mib / 1024) * 10) / 10 : null }
  } catch {
    return { name: null, vramGb: null }
  }
}

export interface CapacityScanResult {
  gpuName: string | null
  vramGb: number | null
  models: { flash: string; medium: string; large: string }
}

/**
 * Détecte la VRAM totale de la carte et choisit 3 modèles (rapide/médium/puissant) qui tiennent dedans,
 * en réservant de la place pour le STT permanent. Sans GPU NVIDIA détecté (ou en cas d'erreur), part du
 * principe le plus prudent : budget nul, donc les plus petits modèles de chaque palier.
 */
export async function scanCapacity(): Promise<CapacityScanResult> {
  const { name, vramGb } = await detectGpu()
  const budgetGb = vramGb !== null ? Math.max(0, vramGb - STT_RESERVED_GB) : 0

  return {
    gpuName: name,
    vramGb,
    models: {
      flash: pickForBudget(FLASH_CANDIDATES, budgetGb),
      medium: pickForBudget(MEDIUM_CANDIDATES, budgetGb),
      large: pickForBudget(LARGE_CANDIDATES, budgetGb)
    }
  }
}
