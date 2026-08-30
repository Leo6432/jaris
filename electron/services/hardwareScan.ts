import { exec } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { CODE_MODEL_FAST, CODE_MODEL_QUALITY } from './codeGenerator'
import { listInstalledModels } from './ollama'
import type { ModelOverviewEntry, ModelOverviewResult, ModelTiers } from '../../shared/ipc'

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
// gemma4:e4b et granite4:3b (devenu granite4.1:3b, voir plus bas) ajoutés suite au même benchmark local :
// gemma4:e4b (6/6 en tool-calling, bien plus rapide que qwen3.5:9b) en tête si la VRAM le permet, la famille
// Granite (6/6 aussi, ~2,1 Go) comme palier intermédiaire léger avant le repli ultime. Cette famille rejette
// le paramètre `think` (contrairement à qwen3.5/gemma4:e4b, qui le supportent tous les deux) : voir le
// filet de sécurité "sans think" dans chatWithOllama (electron/services/ollama.ts).
// granite4:3b -> granite4.1:3b : IBM a sorti Granite 4.1 (post-training amélioré, tool-calling renforcé,
// même empreinte VRAM) — mise à jour directe, pas de raison de garder l'ancienne version. Vérifié sur
// ollama.com/library/granite4.1 (tag 3b, 2,1 Go) et le blog IBM Research annonçant la sortie.
const MEDIUM_CANDIDATES: ModelCandidate[] = [
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3.5:9b', vramGb: 6.6 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'granite4.1:3b', vramGb: 2.1 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]
const LARGE_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.5:35b', vramGb: 24 },
  { model: 'qwen3.5:27b', vramGb: 17 },
  // Ajouté après vérification directe sur ollama.com/library/qwen3.8 (18 Go, vision+tools+thinking natifs,
  // contexte 256K) suite à deux analyses externes (PDF fournis par Léo) le signalant comme successeur de
  // qwen3.5:27b — gain en code/agentic rapporté par des sources tierces uniquement (pas de chiffre MMLU-Pro
  // officiel trouvé, donc absent d'INTELLIGENCE_MMLU_PRO plus bas) : à confirmer via "Lancer l'analyse"
  // avant de le préférer à qwen3.5:27b.
  { model: 'qwen3.8:27b', vramGb: 18 },
  // Trois candidats supplémentaires dans la même tranche (17-19 Go), utiles pour les machines avec plus de
  // VRAM que la config de développement (8 Go) — pas retenus faute de "trop lourd" mais parce qu'un candidat
  // de plus dans cette tranche ne changeait rien pour Léo ; ajoutés maintenant pour ceux qui ont la VRAM.
  // - qwen3.6:27b : autre variante de la même famille que qwen3.6:35b-a3b (Code), vérifiée sur
  //   ollama.com/library/qwen3.6 (18 Go, vision+tools+thinking natifs).
  // - gemma4:26b : MoE Google (25,2 Md total / 3,8 Md actifs), vérifié sur ollama.com/library/gemma4 (19 Go).
  // - gpt-oss:20b (OpenAI, poids ouverts) : vérifié sur ollama.com/library/gpt-oss (14 Go, tools+thinking,
  //   texte seul — pas de vision contrairement aux autres candidats de cette liste).
  { model: 'qwen3.6:27b', vramGb: 18 },
  { model: 'gemma4:26b', vramGb: 19 },
  { model: 'gpt-oss:20b', vramGb: 14 },
  // Command R (Cohere) : orienté RAG/tool-use long contexte (128K), tools confirmés. Vérifié sur
  // ollama.com/library/command-r (19 Go).
  { model: 'command-r:35b', vramGb: 19 },
  // Mistral Small : le PDF mentionnait "3.1"/"3.2", des versions qui n'existent pas sous ce nom sur Ollama
  // — le tag réel actuel est mistral-small:24b (vérifié, 14 Go), function calling natif.
  { model: 'mistral-small:24b', vramGb: 14 },
  // GLM-4.7-Flash (Zhipu/Z.ai) : plus récent que GLM-4.6V-Flash déjà en Vision (2 mois vs plus ancien),
  // tools+thinking, texte seul. Vérifié sur ollama.com/library/glm-4.7-flash/tags (tag q4_K_M, 19 Go).
  { model: 'glm-4.7-flash:q4_K_M', vramGb: 19 },
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
  // Pas de tag officiel dans la bibliothèque Ollama : import depuis le dépôt GGUF de ggml-org (mainteneurs
  // de llama.cpp), à partir du modèle officiel zai-org/GLM-4.6V-Flash. Le tag Q4_K_M est important : les
  // autres quantifications communautaires (Q2_K, Q3_K) sont purement textuelles, sans le module de vision.
  // ~6,2 Go mesurés en Q4_K_M, marge de sécurité incluse ci-dessous.
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  { model: 'qwen3-vl:4b', vramGb: 5 },
  { model: 'qwen3-vl:2b', vramGb: 3 },
  // Candidats "réutilisation" : qwen3.5 et gemma4:e4b (déjà dans MEDIUM_CANDIDATES) sont NATIVEMENT
  // multimodaux (vérifié sur ollama.com/library/qwen3.5 : badge vision+tools+thinking), donc candidats
  // légitimes pour la vision aussi — pas juste des modèles de conversation qu'on force à faire autre chose.
  // Intérêt concret : si l'un d'eux tient tête à un qwen3-vl/GLM dédié sur VISION_TEST_CASES, Jaris
  // pourrait un jour réutiliser le modèle de conversation déjà chargé pour look_at_screen, sans jamais
  // charger un second modèle (zéro swap VRAM). Pas encore le cas aujourd'hui : resolveVisionModel continue
  // de choisir dans cette liste normalement, ce test sert juste à savoir si ça vaudrait le coup.
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'gemma4:e4b', vramGb: 9.6 }
]

// Palier "Code" : modèles spécialisés génération/complétion de code, distincts des paliers de conversation
// ci-dessus (entraînés spécifiquement sur du code, pas juste "bons en code en plus du reste"). Utilisé par
// codeGenerator.ts (mode Code, étape 30) et visible dans le tableau comparatif de l'onglet Modèles :
// - qwen2.5-coder:7b : modèle rapide, tient sur 8 Go de VRAM. Source taille : ollama.com/library/qwen2.5-coder.
// - qwen3.6:35b-a3b : nettement plus capable (LiveCodeBench v6 très supérieur), mais 35 Md de paramètres au
//   total — ne tient pas dans la VRAM d'une carte 8 Go, tourne surtout via la RAM système (plus lent, mais
//   accessible avec 64 Go de RAM ou plus). vramGb reflète sa taille réelle (quantification Q4_K_M), pas une
//   VRAM "cible" : il apparaîtra donc comme "ne rentre pas" dans le tableau pour les petites cartes, ce qui
//   est honnête pour un usage 100% VRAM — le mode Code sait l'utiliser quand même s'il est installé (voir
//   resolveCodeModel dans codeGenerator.ts). Source taille/quantification : ollama.com/library/qwen3.6:35b-a3b.
// - north-mini-code-1.0 (Cohere) : spécialiste code agentique, MoE (128 experts, ~3 Md actifs) — donc, comme
//   qwen3.6:35b-a3b, capable de tourner à cheval VRAM/RAM sans devenir inutilisable (contrairement à un
//   dense de même taille). Annoncerait un meilleur score que Devstral Small 2 24B (dense) sur l'index code
//   d'Artificial Analysis. AJOUTÉ ICI EN INFORMATIF SEULEMENT (pas encore promu comme second choix qualité
//   dans resolveCodeModel) : contrairement à qwen3.6:35b-a3b, pas encore de benchmark indépendant
//   (LiveCodeBench/SWE-bench) trouvé le comparant directement à ce qui est déjà utilisé — à tester via
//   "Lancer l'analyse" avant d'envisager de le promouvoir. Source : ollama.com/library/north-mini-code-1.0
//   (tag :q4_K_M, 19 Go), blog Cohere.
// - qwen2.5-coder:32b : plus gros frère de qwen2.5-coder:7b, mais DENSE (contrairement à qwen3.6:35b-a3b et
//   north-mini-code-1.0 ci-dessus, tous deux MoE) — tous ses 32 Md de paramètres servent à chaque mot, donc
//   un débordement sur la RAM le ralentira beaucoup plus fort, proportionnellement, qu'un MoE de taille
//   comparable (même écart que Devstral Small 2 24B, dense, vs North Mini Code, MoE, observé cette session :
//   ~5 tok/s contre ~34 tok/s pour une taille de fichier proche). Ajouté en informatif pour le comparer
//   objectivement via "Lancer l'analyse" plutôt que de deviner. Source taille : ollama.com/library/qwen2.5-coder
//   (tag 32b, 20 Go).
// - qwen3-coder:30b (Alibaba) : ligne dédiée code, DISTINCTE de qwen3.6:35b-a3b (deux modèles réels et
//   différents, malgré une taille/architecture proche — 30 Md total / 3,3 Md actifs, MoE, 19 Go). Une
//   analyse externe fournie par Léo affirmait à tort que "qwen3.6:35b-a3b" n'existait pas et n'était qu'une
//   confusion avec celui-ci — vérifié directement sur ollama.com/library/qwen3.6/tags : les deux tags
//   existent bel et bien, séparément. Ajouté en informatif, à comparer aux autres via "Lancer l'analyse".
const CODE_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.6:35b-a3b', vramGb: 22 },
  { model: 'qwen3-coder:30b', vramGb: 19 },
  { model: 'north-mini-code-1.0', vramGb: 19 },
  { model: 'qwen2.5-coder:32b', vramGb: 20 },
  // Mistral, agent de code autonome (exploration de dépôt, édition multi-fichiers). DENSE comme
  // qwen2.5-coder:32b ci-dessus (pas de "-a3b"/MoE dans son nom) : même remarque, débordement RAM plus
  // pénalisant qu'un MoE de taille comparable. Vérifié sur ollama.com/library/devstral-small-2 (15 Go).
  { model: 'devstral-small-2:24b', vramGb: 15 },
  { model: 'qwen2.5-coder:7b', vramGb: 4.7 }
]

/**
 * Tous les identifiants de modèles candidats (tous paliers + vision confondus, sans doublon), pour l'étape
 * 29 (veille) : comparé au dernier snapshot connu du profil pour détecter les modèles ajoutés à ce fichier
 * depuis (nouvelle version de Jaris) et prévenir l'utilisateur au lieu d'attendre qu'il relance l'analyse
 * de lui-même.
 */
export function getAllCandidateModelIds(): string[] {
  const ids = new Set<string>()
  for (const list of Object.values(TIER_CANDIDATES)) {
    for (const c of list) ids.add(c.model)
  }
  for (const c of VISION_CANDIDATES) ids.add(c.model)
  for (const c of CODE_CANDIDATES) ids.add(c.model)
  return [...ids]
}

/**
 * Modèles du palier Code (voir CODE_CANDIDATES ci-dessus), pour que benchmarkRunner.ts sache lesquels
 * exempter du nettoyage post-benchmark (cleanupUnselectedModels) : contrairement aux paliers
 * flash/medium/large/vision, le palier Code n'a pas UN choix stocké dans le profil — resolveCodeModel
 * (codeGenerator.ts) décide dynamiquement à chaque génération selon ce qui est installé sur le moment. Sans
 * cette exemption, tout modèle Code fraîchement testé (potentiellement des dizaines de Go) serait supprimé
 * juste après le test, alors que rien ne l'a "remplacé" au sens des autres paliers.
 */
export function getCodeCandidateModelIds(): string[] {
  return CODE_CANDIDATES.map((c) => c.model)
}

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
  // granite4:3b (44.5) retiré : remplacé par granite4.1:3b (voir MEDIUM_CANDIDATES), pas de score MMLU-Pro
  // publié trouvé pour cette nouvelle version — l'ancien chiffre ne lui est pas forcément applicable.
  'gemma4:e4b': 69.4,
  'qwen3.6:35b-a3b': 85.2
}

export interface LocalBenchmarkEntry {
  speedTokPerSec: number | null
  toolCalling: string | null
}

/**
 * Relit scripts/benchmark-results.md (généré par `npm run benchmark:models`, voir ce script) s'il existe,
 * pour remonter de vraies mesures faites sur LA machine de l'utilisateur plutôt que des chiffres publiés
 * génériques. Absent (jamais lancé) : renvoie une map vide, sans faire échouer l'aperçu pour autant.
 * Exportée en plus de son usage dans getModelOverview ci-dessous : sert aussi à benchmarkRunner.ts pour
 * savoir quels modèles ont été testés lors du dernier run (et donc candidats à un nettoyage après coup).
 */
export function parseLocalBenchmark(): Map<string, LocalBenchmarkEntry> {
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
 * Vue d'ensemble des modèles candidats pour l'onglet Modèles, GROUPÉE PAR PALIER (Rapide/Médium/Puissant/
 * Vision/Code) plutôt qu'une liste unique tous paliers confondus : chaque palier n'a pas les mêmes colonnes
 * pertinentes (ex: Vision n'a pas de score d'intelligence MMLU-Pro, ça ne s'y applique pas — mais a bien sa
 * propre vitesse/fiabilité mesurées localement, voir VISION_TEST_CASES dans scripts/benchmark-models.mjs).
 * Un même modèle candidat à plusieurs paliers (ex: le plus petit, repli ultime de Rapide/Médium/Puissant)
 * apparaît dans chacun des groupes concernés — chaque liste doit rester une image complète de ce palier.
 */
export async function getModelOverview(): Promise<ModelOverviewResult> {
  const localBenchmark = parseLocalBenchmark()

  const buildEntry = (model: string, vramGb: number): ModelOverviewEntry => {
    const local = localBenchmark.get(model)
    return {
      model,
      vramGb,
      speedTokPerSec: local?.speedTokPerSec ?? null,
      toolCalling: local?.toolCalling ?? null,
      intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null
    }
  }

  const groups = [
    ...(Object.keys(TIER_CANDIDATES) as Tier[]).map((tier) => ({
      tier: TIER_LABELS[tier],
      entries: TIER_CANDIDATES[tier].map((c) => buildEntry(c.model, c.vramGb))
    })),
    { tier: 'Vision', entries: VISION_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb)) },
    { tier: 'Code', entries: CODE_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb)) }
  ]

  const { vramGb } = await detectGpu()
  const installedModels = await listInstalledModels().catch(() => [] as string[])
  const codeModel = installedModels.includes(CODE_MODEL_QUALITY) ? CODE_MODEL_QUALITY : CODE_MODEL_FAST
  return { vramGb, groups, codeModel }
}

/** "6/6" -> 6, absent/invalide -> -1 (toujours perdant face à un vrai score dans le tri de pickBestModelsFromBenchmark). */
function parseToolScore(toolCalling: string | null): number {
  if (!toolCalling) return -1
  const correct = Number(toolCalling.split('/')[0])
  return Number.isFinite(correct) ? correct : -1
}

/**
 * Comme scanCapacity, mais choisit le meilleur modèle de chaque palier (+ vision) d'après les vraies
 * mesures du benchmark local (parseLocalBenchmark : vitesse + fiabilité — appel d'outils pour les paliers
 * de conversation/code, compréhension d'image pour vision, voir VISION_TEST_CASES dans
 * scripts/benchmark-models.mjs) sur CETTE machine, plutôt que de supposer que le plus gros qui rentre est
 * forcément le meilleur — priorité à la fiabilité, la vitesse ne départageant qu'à égalité. Repli sur
 * pickForBudget (comportement de scanCapacity, par taille) si aucun candidat n'a de résultat de benchmark
 * exploitable pour ce palier (jamais lancé, ou échec du test pour tous les candidats qui rentrent).
 */
export async function pickBestModelsFromBenchmark(): Promise<CapacityScanResult> {
  const { name, vramGb } = await detectGpu()
  const budgetGb = vramGb !== null ? Math.max(0, vramGb - STT_RESERVED_GB) : 0
  const localBenchmark = parseLocalBenchmark()

  const pickBestFrom = (candidates: ModelCandidate[]): string => {
    const benchmarked = candidates
      .filter((c) => c.vramGb <= budgetGb)
      .map((c) => ({ model: c.model, result: localBenchmark.get(c.model) }))
      .filter((c): c is { model: string; result: LocalBenchmarkEntry } => c.result?.speedTokPerSec != null)

    if (!benchmarked.length) return pickForBudget(candidates, budgetGb)

    benchmarked.sort((a, b) => {
      const toolDiff = parseToolScore(b.result.toolCalling) - parseToolScore(a.result.toolCalling)
      return toolDiff !== 0 ? toolDiff : (b.result.speedTokPerSec ?? 0) - (a.result.speedTokPerSec ?? 0)
    })
    return benchmarked[0].model
  }

  return {
    gpuName: name,
    vramGb,
    models: {
      flash: pickBestFrom(TIER_CANDIDATES.flash),
      medium: pickBestFrom(TIER_CANDIDATES.medium),
      large: pickBestFrom(TIER_CANDIDATES.large)
    },
    visionModel: pickBestFrom(VISION_CANDIDATES)
  }
}
