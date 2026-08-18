import { exec } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { ModelOverviewEntry, ModelTiers } from '../../shared/ipc'

const execAsync = promisify(exec)

type Tier = keyof ModelTiers

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
// Triées du plus gros au plus petit : on prend le premier qui tient dans le budget dispo. Important pour
// pickForBudget (premier candidat qui tient qui gagne) : un candidat plus petit ET plus VRAM-économe qu'un
// autre plus haut dans la liste rendrait cet autre inatteignable, donc l'ordre doit rester strictement
// décroissant en VRAM, jamais juste "par préférence".
//
// qwen3:1.7b remplace qwen3.5:2b ici (retiré, pas juste ajouté) : au benchmark local
// (scripts/benchmark-models.mjs) il s'est montré à la fois plus rapide ET plus fiable en tool-calling que
// qwen3.5:2b tout en demandant moins de VRAM (~2 Go contre 2,7 Go) — qwen3.5:2b devenait donc de toute
// façon inatteignable dans la liste une fois qwen3:1.7b ajouté avant lui.
const FLASH_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3:1.7b', vramGb: 2 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]
// gemma4:e4b et granite4:3b ajoutés suite au même benchmark local : gemma4:e4b (6/6 en tool-calling, bien
// plus rapide que qwen3.5:9b) en tête si la VRAM le permet, granite4:3b (6/6 aussi, ~2,1 Go) comme palier
// intermédiaire léger avant le repli ultime. granite4:3b rejette le paramètre `think` (contrairement à
// qwen3.5/gemma4:e4b, qui le supportent tous les deux) : voir le filet de sécurité "sans think" dans
// chatWithOllama (electron/services/ollama.ts).
const MEDIUM_CANDIDATES: ModelCandidate[] = [
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3.5:9b', vramGb: 6.6 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'granite4:3b', vramGb: 2.1 },
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

const TIER_CANDIDATES: Record<Tier, ModelCandidate[]> = {
  flash: FLASH_CANDIDATES,
  medium: MEDIUM_CANDIDATES,
  large: LARGE_CANDIDATES
}

// Le modèle de vision (étape 6) était fixe (qwen3-vl:8b, ~8 Go de VRAM) pour tout le monde : sur une carte
// contrainte, il ne tient pas à côté du modèle de conversation déjà chargé, forçant Ollama à décharger/
// recharger à chaque appel (des dizaines de secondes). Mêmes tailles/logique que les paliers de conversation
// ci-dessus, source : ollama.com/library/qwen3-vl.
const VISION_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3-vl:8b', vramGb: 8 },
  { model: 'qwen3-vl:4b', vramGb: 5 },
  { model: 'qwen3-vl:2b', vramGb: 3 }
]

function pickForBudget(candidates: ModelCandidate[], budgetGb: number): string {
  const fit = candidates.find((c) => c.vramGb <= budgetGb)
  return (fit ?? candidates[candidates.length - 1]).model
}

async function detectGpu(): Promise<{ name: string | null; vramGb: number | null }> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
      windowsHide: true
    })
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
  visionModel: string
}

/**
 * Détecte la VRAM totale de la carte et choisit 3 modèles de conversation (rapide/médium/puissant) plus un
 * modèle de vision qui tiennent dedans, en réservant de la place pour le STT permanent. Sans GPU NVIDIA
 * détecté (ou en cas d'erreur), part du principe le plus prudent : budget nul, donc les plus petits modèles
 * de chaque palier.
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
    },
    visionModel: pickForBudget(VISION_CANDIDATES, budgetGb)
  }
}

/**
 * Au-delà de cette température (°C), la RTX 3070 (et la plupart des cartes grand public) commence à
 * throttler : c'est le signal qu'on utilise pour économiser le GPU le temps qu'il refroidisse, pas une
 * limite de sécurité matérielle en soi.
 */
export const GPU_TEMP_LIMIT_C = 83

/** Petite marge en plus du modèle lui-même (contexte, activations...) avant de le considérer "à sa place". */
const LIVE_SAFETY_MARGIN_GB = 0.5

export interface LiveGpuStatus {
  freeVramGb: number | null
  tempC: number | null
}

/**
 * Contrairement à `scanCapacity` (VRAM totale, fixe, pour définir une fois pour toutes les 3 paliers),
 * cette fonction lit l'état réel du GPU à l'instant présent (VRAM libre, température) : elle sert à
 * vérifier, juste avant chaque question, que le modèle normalement choisi tient encore la route compte
 * tenu de ce qui tourne en parallèle (jeu, navigateur...) sur la machine, sans jamais changer les paliers
 * eux-mêmes.
 */
export async function getLiveGpuStatus(): Promise<LiveGpuStatus> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.free,temperature.gpu --format=csv,noheader,nounits', {
      windowsHide: true
    })
    const firstLine = stdout.trim().split('\n')[0] ?? ''
    const [freeRaw, tempRaw] = firstLine.split(',').map((s) => s.trim())
    const freeMib = parseInt(freeRaw, 10)
    const temp = parseInt(tempRaw, 10)
    return {
      freeVramGb: Number.isFinite(freeMib) ? Math.round((freeMib / 1024) * 10) / 10 : null,
      tempC: Number.isFinite(temp) ? temp : null
    }
  } catch {
    return { freeVramGb: null, tempC: null }
  }
}

/**
 * Dans les candidats du palier donné, choisit le plus gros qui tient dans la VRAM *libre* à l'instant
 * présent — mais uniquement parmi les modèles réellement installés (`installedModels`, via `ollama list`) :
 * seul le modèle normalement configuré pour ce palier a été téléchargé pendant le scan de capacité, les
 * autres candidats du palier n'ont peut-être jamais été récupérés. Se replier dessus provoquerait un
 * "model not found" en pleine conversation. Si aucun candidat du palier n'est installé, on garde
 * `fallbackModel` (celui normalement configuré) tel quel plutôt que de risquer un modèle absent.
 */
export function pickSafeModel(tier: Tier, freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  const installedCandidates = TIER_CANDIDATES[tier].filter((c) => installedModels.includes(c.model))
  if (installedCandidates.length === 0) return fallbackModel
  return pickForBudget(installedCandidates, Math.max(0, freeVramGb - LIVE_SAFETY_MARGIN_GB))
}

/**
 * Même logique que pickSafeModel ci-dessus, mais pour le modèle de vision (liste de candidats séparée, pas
 * un palier de ModelTiers) : le modèle choisi une fois pour toutes au scan de capacité peut ne plus tenir
 * dans la VRAM *libre* à l'instant présent (conversation déjà chargée, jeu ou navigateur en parallèle...),
 * ce qui forcerait sinon Ollama à décharger/recharger un gros modèle et ferait traîner look_at_screen.
 */
export function pickSafeVisionModel(freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  const installedCandidates = VISION_CANDIDATES.filter((c) => installedModels.includes(c.model))
  if (installedCandidates.length === 0) return fallbackModel
  return pickForBudget(installedCandidates, Math.max(0, freeVramGb - LIVE_SAFETY_MARGIN_GB))
}

/**
 * Score MMLU-Pro publié (fiche modèle officielle / éditeur), pour donner une idée de l'"intelligence"
 * générale de chaque candidat dans l'onglet Modèles du menu Options — en complément de la vitesse et de la
 * fiabilité d'appel d'outils, qui elles viennent du benchmark local (voir parseLocalBenchmark ci-dessous),
 * pas d'un score publié. Absent = pas de chiffre MMLU-Pro publié trouvé pour ce modèle.
 */
const INTELLIGENCE_MMLU_PRO: Record<string, number> = {
  'qwen3.5:0.8b': 29.7,
  'qwen3.5:2b': 55.3,
  'qwen3.5:4b': 79.1,
  'qwen3.5:9b': 82.5,
  'qwen3.5:27b': 86.1,
  'qwen3.5:35b': 85.3,
  'granite4:3b': 44.5,
  'gemma4:e4b': 69.4
}

interface LocalBenchmarkEntry {
  speedTokPerSec: number | null
  toolCalling: string | null
}

/**
 * Relit scripts/benchmark-results.md (généré par `npm run benchmark:models`, voir ce script) s'il existe,
 * pour remonter de vraies mesures faites sur LA machine de l'utilisateur plutôt que des chiffres publiés
 * génériques. Absent (jamais lancé) : renvoie une map vide, sans faire échouer l'aperçu pour autant.
 */
function parseLocalBenchmark(): Map<string, LocalBenchmarkEntry> {
  const results = new Map<string, LocalBenchmarkEntry>()
  let raw: string
  try {
    raw = readFileSync(join(process.cwd(), 'scripts', 'benchmark-results.md'), 'utf-8')
  } catch {
    return results
  }

  for (const line of raw.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('Modèle')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length !== 4) continue

    const [model, , speed, tool] = cells
    const speedNum = parseFloat(speed)
    results.set(model, {
      speedTokPerSec: Number.isFinite(speedNum) ? speedNum : null,
      toolCalling: tool === '—' ? null : tool
    })
  }
  return results
}

const TIER_LABELS: Record<Tier, string> = { flash: 'Rapide', medium: 'Médium', large: 'Puissant' }

/**
 * Vue d'ensemble de tous les modèles candidats (tous paliers + vision confondus), pour l'onglet Modèles du
 * menu Options : VRAM nécessaire, vitesse et fiabilité d'appel d'outils mesurées localement si
 * `npm run benchmark:models` a déjà tourné, "intelligence" générale (MMLU-Pro publié) sinon. Un même
 * modèle candidat à plusieurs paliers (ex: qwen3.5:0.8b, repli de tous les paliers) n'apparaît qu'une
 * seule fois, avec la liste de tous les paliers concernés.
 */
export function getModelOverview(): ModelOverviewEntry[] {
  const byModel = new Map<string, ModelOverviewEntry>()

  const addCandidate = (model: string, vramGb: number, tierLabel: string): void => {
    const existing = byModel.get(model)
    if (existing) {
      if (!existing.tiers.includes(tierLabel)) existing.tiers.push(tierLabel)
      return
    }
    byModel.set(model, {
      model,
      tiers: [tierLabel],
      vramGb,
      speedTokPerSec: null,
      toolCalling: null,
      intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null
    })
  }

  for (const tier of Object.keys(TIER_CANDIDATES) as Tier[]) {
    for (const c of TIER_CANDIDATES[tier]) addCandidate(c.model, c.vramGb, TIER_LABELS[tier])
  }
  for (const c of VISION_CANDIDATES) addCandidate(c.model, c.vramGb, 'Vision')

  const localBenchmark = parseLocalBenchmark()
  for (const entry of byModel.values()) {
    const local = localBenchmark.get(entry.model)
    if (local) {
      entry.speedTokPerSec = local.speedTokPerSec
      entry.toolCalling = local.toolCalling
    }
  }

  return [...byModel.values()].sort((a, b) => b.vramGb - a.vramGb)
}
