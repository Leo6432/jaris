import { exec } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { CODE_MODEL_FAST, CODE_MODEL_QUALITY } from './codeGenerator'
import { listInstalledModels } from './ollama'
import { RESOURCE_SAFETY_MARGIN_GB, detectRamGb } from './systemResources'
import type { HardwareTierPreview, ModelOverviewEntry, ModelOverviewResult, ModelTiers } from '../../shared/ipc'

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

/**
 * Les vrais candidats "Puissant" (au-delà de qwen3.5:9b et en dessous, qui servent aussi de replis pour
 * Rapide/Médium) + les gros candidats "Code" tolèrent de déborder sur la RAM plutôt que d'être écartés
 * faute de VRAM — à la demande explicite de Léo, qui préfère un vrai grand modèle plus lent (potentiellement
 * 30s+ par réponse) à un petit modèle rapide pour les paliers censés gérer le plus de réflexion/qualité.
 * Utilisé par pickBestModelsFromBenchmark/computeModelPicks (budget élargi VRAM+RAM pour ces candidats) et
 * pickSafeModel (pas de repli en direct sur un modèle plus petit : Ollama gère lui-même le débordement RAM,
 * contrairement à une vraie absence de place qui ferait échouer le chargement — jamais appelé pour Code,
 * qui n'a pas de Tier, donc sans risque de confusion là). Dupliqué dans scripts/benchmark-models.mjs
 * (RAM_OFFLOAD_MODELS) pour la même raison que les autres listes de candidats — voir son commentaire pour le
 * détail MoE/dense de chacun (certains restent rapides même débordés, d'autres beaucoup moins).
 */
const LARGE_RAM_OFFLOAD_MODELS = new Set([
  'qwen3.5:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'gemma4:26b',
  'gpt-oss:20b',
  'command-r:35b',
  'mistral-small:24b',
  'glm-4.7-flash:q4_K_M',
  'qwen3.6:35b-a3b',
  'qwen3-coder:30b',
  'north-mini-code-1.0',
  'qwen2.5-coder:32b',
  'devstral-small-2:24b'
])

const TIER_CANDIDATES: Record<Tier, ModelCandidate[]> = {
  flash: FLASH_CANDIDATES,
  medium: MEDIUM_CANDIDATES,
  large: LARGE_CANDIDATES
}

// Le modèle de vision (étape 6) était fixe (qwen3-vl:8b, ~8 Go de VRAM) pour tout le monde : sur une carte
// contrainte, il ne tient pas à côté du modèle de conversation déjà chargé, forçant Ollama à décharger/
// recharger à chaque appel (des dizaines de secondes). Mêmes tailles/logique que les paliers de conversation
// ci-dessus, source : ollama.com/library/qwen3-vl.
// Triée du plus gros au plus petit, comme FLASH/MEDIUM/LARGE_CANDIDATES ci-dessus (voir leur commentaire) :
// pickForBudget (repli quand aucun candidat n'a de résultat exploitable) suppose cet ordre pour retomber sur
// le plus petit, jamais un gros modèle par accident — gemma4:e4b (le plus gros ici, 9.6 Go) doit donc rester
// en TÊTE de liste, pas en queue (bug corrigé : il y était placé en dernier, faisant retomber le repli sur le
// plus gros modèle vision au lieu du plus petit sur une machine très contrainte).
const VISION_CANDIDATES: ModelCandidate[] = [
  // Candidat "réutilisation" : gemma4:e4b (déjà dans MEDIUM_CANDIDATES) est NATIVEMENT multimodal (vérifié
  // sur ollama.com/library/gemma4 : badge vision+tools+thinking), donc candidat légitime pour la vision
  // aussi — pas juste un modèle de conversation qu'on force à faire autre chose. Intérêt concret : s'il tient
  // tête à un qwen3-vl/GLM dédié sur VISION_TEST_CASES, Jaris pourrait un jour réutiliser le modèle de
  // conversation déjà chargé pour look_at_screen, sans jamais charger un second modèle (zéro swap VRAM). Pas
  // encore le cas aujourd'hui : resolveVisionModel continue de choisir dans cette liste normalement, ce test
  // sert juste à savoir si ça vaudrait le coup.
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3-vl:8b', vramGb: 8 },
  // Pas de tag officiel dans la bibliothèque Ollama : import depuis le dépôt GGUF de ggml-org (mainteneurs
  // de llama.cpp), à partir du modèle officiel zai-org/GLM-4.6V-Flash. Le tag Q4_K_M est important : les
  // autres quantifications communautaires (Q2_K, Q3_K) sont purement textuelles, sans le module de vision.
  // ~6,2 Go mesurés en Q4_K_M, marge de sécurité incluse ci-dessous.
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  { model: 'qwen3-vl:4b', vramGb: 5 },
  // Même candidat "réutilisation" que gemma4:e4b ci-dessus, mais pour qwen3.5 (déjà dans MEDIUM_CANDIDATES) :
  // vérifié nativement multimodal sur ollama.com/library/qwen3.5 (badge vision+tools+thinking).
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3-vl:2b', vramGb: 3 }
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
 * Contrairement à `pickBestModelsFromBenchmark` (VRAM totale, fixe, pour définir une fois pour toutes les 3
 * paliers), cette fonction lit l'état réel du GPU à l'instant présent (VRAM libre, température) : elle sert à
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
 *
 * Exception : si `fallbackModel` est un candidat "Puissant" pensé pour déborder sur la RAM
 * (LARGE_RAM_OFFLOAD_MODELS), ce repli VRAM-seule n'a pas de sens — il verrait TOUJOURS "pas assez de VRAM
 * libre" (c'est prévu, il tourne à cheval sur VRAM+RAM) et le remplacerait systématiquement par un petit
 * modèle à chaque question, annulant le choix fait par pickBestModelsFromBenchmark. Ollama gère lui-même le
 * débordement RAM à chaque chargement, pas besoin de ce filet de sécurité pour ces candidats-là.
 */
export function pickSafeModel(tier: Tier, freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  if (LARGE_RAM_OFFLOAD_MODELS.has(fallbackModel)) return fallbackModel
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
  speedEstimated?: boolean
}

/**
 * Bande passante mémoire (Go/s) des GPU NVIDIA grand public courants — sources : article Wikipedia de
 * chaque génération ("GeForce RTX 30/40/50 series"), RTX 5080 corrigé à 960 Go/s via Tom's Hardware après
 * une première lecture erronée de la page RTX 50 (qui avait recopié le chiffre de la ligne RTX 5090).
 * Triée du nom le plus spécifique au moins spécifique (voir detectGpuBandwidthGbps) : "RTX 4070 Ti Super"
 * doit être trouvé avant "RTX 4070 Ti", lui-même avant "RTX 4070", sinon la carte la plus précise ne
 * matcherait jamais. Pas exhaustif (cartes pro/mobile absentes) : `null` plutôt qu'un chiffre inventé pour
 * toute carte non reconnue, voir estimateSpeedTokPerSec.
 */
const GPU_MEMORY_BANDWIDTH_GBPS: Record<string, number> = {
  'RTX 3060 Ti': 448,
  'RTX 3060': 360,
  'RTX 3070 Ti': 608,
  'RTX 3070': 448,
  'RTX 3080 Ti': 960,
  'RTX 3080': 760,
  'RTX 3090 Ti': 1008,
  'RTX 3090': 936,
  'RTX 4060 Ti': 288,
  'RTX 4060': 272,
  'RTX 4070 Ti Super': 672,
  'RTX 4070 Ti': 504,
  'RTX 4070 Super': 504,
  'RTX 4070': 504,
  'RTX 4080 Super': 736,
  'RTX 4080': 716.8,
  'RTX 4090': 1008,
  'RTX 5050': 320,
  'RTX 5060 Ti': 672,
  'RTX 5060': 448,
  'RTX 5070 Ti': 960,
  'RTX 5070': 896,
  'RTX 5080': 960,
  'RTX 5090': 1792
}

function detectGpuBandwidthGbps(gpuName: string): number | null {
  const upper = gpuName.toUpperCase()
  const key = Object.keys(GPU_MEMORY_BANDWIDTH_GBPS)
    .sort((a, b) => b.length - a.length)
    .find((k) => upper.includes(k.toUpperCase()))
  return key ? GPU_MEMORY_BANDWIDTH_GBPS[key] : null
}

/**
 * Efficacité empirique (bande passante réellement atteinte ÷ bande passante théorique) : l'inférence LLM en
 * génération est limitée par la bande passante mémoire (chaque token relit tout le poids du modèle une
 * fois), jamais 100% de la bande passante théorique en pratique (overhead noyau, cache KV, contrôleur
 * mémoire...). Même ordre de grandeur que la valeur utilisée en interne par llmfit (0.55) avant qu'on
 * retire cette dépendance (voir l'historique de ce fichier) — construite indépendamment, pas recopiée.
 */
const MEMORY_BANDWIDTH_EFFICIENCY = 0.55

/**
 * Estimation de vitesse par pur calcul (bande passante ÷ taille du modèle) — JAMAIS une mesure réelle,
 * jamais de téléchargement ni d'exécution. Réservée aux modèles déjà vérifiés en fiabilité d'appel d'outils
 * par ailleurs (parseVerifiedToolScores) : leur fiabilité ne dépend pas du matériel (vérifiée une fois pour
 * tous), mais leur vitesse si — recalculée ici pour la machine de CET utilisateur plutôt que de partager le
 * chiffre mesuré sur celle de Léo, qui n'aurait aucun sens ailleurs. `null` si la carte n'est pas reconnue
 * ou sa VRAM inconnue : jamais un chiffre inventé faute de mieux.
 */
export function estimateSpeedTokPerSec(modelVramGb: number, gpuName: string | null): number | null {
  if (!gpuName || modelVramGb <= 0) return null
  const bandwidthGbps = detectGpuBandwidthGbps(gpuName)
  if (bandwidthGbps === null) return null
  return Math.round(((bandwidthGbps * MEMORY_BANDWIDTH_EFFICIENCY) / modelVramGb) * 10) / 10
}

/** Les trois paliers couverts par scripts/verified-tool-scores.md, voir parseVerifiedToolScores. */
export type VerifiedTier = 'conversation' | 'vision' | 'code'

/**
 * Relit scripts/verified-tool-scores.md (commité dans le dépôt, voir son en-tête pour le pourquoi) : scores
 * de fiabilité vérifiés une fois par Léo sur sa machine, valables pour tout le monde — jamais de vitesse
 * dedans (toujours recalculée par estimateSpeedTokPerSec pour la machine de chaque utilisateur). Trois
 * tableaux séparés par palier (sections "## Conversation/Vision/Code"), PAS une seule map globale par nom de
 * modèle : `qwen3.5:4b` (et `gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — un score
 * conversation ne doit jamais être confondu avec, ni écraser, un score vision pour le même nom de modèle
 * (bug déjà rencontré une fois dans benchmark-results.md avant qu'on ne le corrige ici).
 */
export function parseVerifiedToolScores(): Record<VerifiedTier, Map<string, string>> {
  const results: Record<VerifiedTier, Map<string, string>> = {
    conversation: new Map(),
    vision: new Map(),
    code: new Map()
  }
  let raw: string
  try {
    raw = readFileSync(join(process.cwd(), 'scripts', 'verified-tool-scores.md'), 'utf-8')
  } catch {
    return results
  }

  let currentTier: VerifiedTier | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim().toLowerCase()
      currentTier = heading.startsWith('conversation') ? 'conversation' : heading.startsWith('vision') ? 'vision' : heading.startsWith('code') ? 'code' : null
      continue
    }
    if (!currentTier || !line.startsWith('|') || line.includes('---') || line.includes('Modèle')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length !== 2) continue
    const [model, score] = cells
    results[currentTier].set(model, score)
  }
  return results
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
  const verifiedToolScores = parseVerifiedToolScores()
  const { name: gpuName, vramGb } = await detectGpu()

  // Priorité à une vraie mesure locale (le vrai benchmark a tourné sur CETTE machine pour ce modèle) —
  // sinon, pour un modèle déjà vérifié par ailleurs (voir verified-tool-scores.md), fiabilité partagée +
  // vitesse estimée par formule pour cette machine — sinon rien de connu. `tier` sélectionne la BONNE table
  // du fichier (voir VerifiedTier) : `qwen3.5:4b` par ex. a un score différent en Conversation qu'en Vision.
  const buildEntry = (model: string, modelVramGb: number, tier: VerifiedTier): ModelOverviewEntry => {
    // Indépendant de local/verifiedTool ci-dessous : même un modèle déjà mesuré localement une fois reste
    // exclu du PROCHAIN run de benchmark-models.mjs s'il est dans verified-tool-scores.md (voir son
    // commentaire) — l'UI (ModelAnalysisProgress.tsx) en a besoin pour ne pas laisser ce modèle bloqué sur
    // "En attente" pour toujours pendant un run, faute de ##MODEL_TESTING##/##MODEL_DONE## le concernant.
    const verifiedSkip = verifiedToolScores[tier].has(model)
    const local = localBenchmark.get(model)
    if (local) {
      return { model, vramGb: modelVramGb, speedTokPerSec: local.speedTokPerSec, toolCalling: local.toolCalling, intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null, verifiedSkip }
    }
    const verifiedTool = verifiedToolScores[tier].get(model)
    if (verifiedTool) {
      return {
        model,
        vramGb: modelVramGb,
        speedTokPerSec: estimateSpeedTokPerSec(modelVramGb, gpuName),
        speedEstimated: true,
        toolCalling: verifiedTool,
        intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null,
        verifiedSkip
      }
    }
    return { model, vramGb: modelVramGb, speedTokPerSec: null, toolCalling: null, intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null, verifiedSkip }
  }

  const groups = [
    ...(Object.keys(TIER_CANDIDATES) as Tier[]).map((tier) => ({
      tier: TIER_LABELS[tier],
      entries: TIER_CANDIDATES[tier].map((c) => buildEntry(c.model, c.vramGb, 'conversation'))
    })),
    { tier: 'Vision', entries: VISION_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb, 'vision')) },
    { tier: 'Code', entries: CODE_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb, 'code')) }
  ]

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
 * Cœur PUR (aucun accès disque/réseau ici — localBenchmark/verifiedToolScores déjà lus par l'appelant) du
 * choix du meilleur modèle de chaque palier (+ vision) pour un profil matériel donné (vramGb/ramGb/gpuName)
 * — extrait en fonction séparée pour être réutilisable avec des valeurs HYPOTHÉTIQUES (voir
 * previewHardwareTiers, qui l'appelle 3 fois avec des VRAM représentatives pour illustrer "petite/moyenne/
 * grande configuration") en plus du vrai matériel détecté (pickBestModelsFromBenchmark).
 *
 * D'après de vraies mesures — soit un run local du benchmark (parseLocalBenchmark : vitesse + fiabilité
 * mesurées sur CETTE machine), soit, pour un modèle déjà vérifié par ailleurs (parseVerifiedToolScores), sa
 * fiabilité partagée combinée à une vitesse estimée par formule (voir estimateSpeedTokPerSec) — jamais en
 * supposant que le plus gros qui rentre est forcément le meilleur. Priorité à la fiabilité, la VRAM du
 * candidat ne départageant qu'à égalité (le plus gros gagne, pas le plus rapide — voir pickBestFrom
 * ci-dessous). Une vraie mesure locale prime toujours sur un score vérifié partagé pour le même modèle (plus
 * précise, spécifique à cette machine). Repli sur pickForBudget (par taille) si aucun candidat n'a de
 * résultat exploitable pour ce palier (jamais testé nulle part, ni localement ni vérifié) — renvoie alors une
 * entrée sans vitesse/fiabilité connues plutôt qu'un chiffre inventé.
 *
 * Renvoie l'entrée COMPLÈTE (pas juste le nom du modèle) pour chaque palier : previewHardwareTiers en a
 * besoin pour afficher vitesse/fiabilité à côté de chaque modèle, pas seulement son nom.
 */
function computeModelPicks(
  vramGb: number | null,
  ramGb: number,
  gpuName: string | null,
  localBenchmark: Map<string, LocalBenchmarkEntry>,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>
): {
  flash: ModelOverviewEntry
  medium: ModelOverviewEntry
  large: ModelOverviewEntry
  vision: ModelOverviewEntry
  code: ModelOverviewEntry
} {
  const budgetGb = vramGb !== null ? Math.max(0, vramGb - STT_RESERVED_GB) : 0
  // Budget élargi pour les candidats "Puissant" qui tolèrent de déborder sur la RAM (voir
  // LARGE_RAM_OFFLOAD_MODELS) : VRAM (déjà amputée de la réservation STT) + RAM (moins la marge pour
  // l'OS/les autres logiciels) — jamais pour les autres candidats, qui doivent tenir entièrement en VRAM
  // pour un usage voix/chat temps réel sans à-coups.
  const ramOffloadBudgetGb = budgetGb + Math.max(0, ramGb - RESOURCE_SAFETY_MARGIN_GB)
  const budgetForCandidate = (model: string): number => (LARGE_RAM_OFFLOAD_MODELS.has(model) ? ramOffloadBudgetGb : budgetGb)

  const resultFor = (candidate: ModelCandidate, tier: VerifiedTier): LocalBenchmarkEntry | undefined => {
    const local = localBenchmark.get(candidate.model)
    if (local) return local
    const verifiedTool = verifiedToolScores[tier].get(candidate.model)
    if (!verifiedTool) return undefined
    return { speedTokPerSec: estimateSpeedTokPerSec(candidate.vramGb, gpuName), toolCalling: verifiedTool, speedEstimated: true }
  }

  // Départage à égalité de fiabilité par la VRAM du candidat (le plus GROS gagne), pas par la vitesse — à
  // la demande explicite de Léo : une machine qui a la place doit profiter d'un modèle plus capable, pas
  // juste du plus rapide parmi ceux qui réussissent déjà 100% des tests (nos 6/3 questions ne distinguent
  // pas "juste assez bon" de "vraiment plus intelligent" une fois le score max atteint).
  const pickBestFrom = (candidates: ModelCandidate[], tier: VerifiedTier): ModelOverviewEntry => {
    const benchmarked = candidates
      .filter((c) => c.vramGb <= budgetForCandidate(c.model))
      .map((c) => ({ model: c.model, vramGb: c.vramGb, result: resultFor(c, tier) }))
      // toolCalling (pas speedTokPerSec) est le critère de validité : un modèle vérifié dont la vitesse n'a
      // pas pu être estimée (carte inconnue, voir estimateSpeedTokPerSec) reste un candidat légitime, juste
      // départagé par 0 dans le tri ci-dessous plutôt qu'exclu.
      .filter((c): c is { model: string; vramGb: number; result: LocalBenchmarkEntry } => c.result?.toolCalling != null)

    // Repli VRAM seule (jamais élargi) : sans aucun résultat exploitable (ni mesure locale, ni score
    // vérifié), pas de raison de parier sur un débordement RAM jamais mesuré sur cette machine.
    if (!benchmarked.length) {
      const model = pickForBudget(candidates, budgetGb)
      const vramGbOfModel = candidates.find((c) => c.model === model)?.vramGb ?? 0
      return { model, vramGb: vramGbOfModel, speedTokPerSec: null, toolCalling: null, intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null }
    }

    benchmarked.sort((a, b) => {
      const toolDiff = parseToolScore(b.result.toolCalling) - parseToolScore(a.result.toolCalling)
      return toolDiff !== 0 ? toolDiff : b.vramGb - a.vramGb
    })
    const winner = benchmarked[0]
    return {
      model: winner.model,
      vramGb: winner.vramGb,
      speedTokPerSec: winner.result.speedTokPerSec,
      speedEstimated: winner.result.speedEstimated,
      toolCalling: winner.result.toolCalling,
      intelligence: INTELLIGENCE_MMLU_PRO[winner.model] ?? null
    }
  }

  return {
    flash: pickBestFrom(TIER_CANDIDATES.flash, 'conversation'),
    medium: pickBestFrom(TIER_CANDIDATES.medium, 'conversation'),
    large: pickBestFrom(TIER_CANDIDATES.large, 'conversation'),
    vision: pickBestFrom(VISION_CANDIDATES, 'vision'),
    code: pickBestFrom(CODE_CANDIDATES, 'code')
  }
}

export async function pickBestModelsFromBenchmark(): Promise<CapacityScanResult> {
  const { name, vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), name, parseLocalBenchmark(), parseVerifiedToolScores())
  return {
    gpuName: name,
    vramGb,
    models: { flash: picks.flash.model, medium: picks.medium.model, large: picks.large.model },
    visionModel: picks.vision.model
  }
}

/**
 * Bornes utilisées UNIQUEMENT pour illustrer/étiqueter "Petite/Moyenne/Grande configuration" à
 * l'utilisateur (écran d'accueil, voir CapacityScan.tsx) — le VRAI choix de modèles
 * (pickBestModelsFromBenchmark, computeModelPicks) reste continu, basé sur la VRAM/RAM exacte détectée, pas
 * sur ces 3 paliers. Essayé un temps de vraiment regrouper le choix en 3 paliers matériels stricts (demande
 * initiale de Léo) : abandonné après simulation contre les vraies données — sur une machine avec peu de VRAM
 * mais beaucoup de RAM, le débordement RAM autorisé pour "Puissant" faisait gagner un modèle énorme même
 * pour le palier "Rapide", censé rester réactif. Ces 3 bornes ne servent donc plus qu'à choisir QUOI montrer
 * à l'écran, jamais à choisir un modèle pour de vrai.
 */
// 4 Go était trop bas : une fois les ~4,5 Go de STT_RESERVED_GB déduits, le budget tombait à 0 et TOUT
// retombait sur le repli "aucun résultat connu" (vitesse/fiabilité vides pour absolument chaque modèle,
// même ceux qui ont un vrai score vérifié) — pas représentatif d'une vraie petite machine, juste un budget
// négatif écrasé à zéro. Ces 3 valeurs laissent toutes un vrai budget positif après réservation STT.
const HARDWARE_TIER_PREVIEW_VRAM_GB = [6, 12, 24]
const HARDWARE_TIER_PREVIEW_LABELS = ['Petite configuration', 'Configuration moyenne', 'Grande configuration']

/**
 * 3 lignes illustratives (VRAM représentative, RAM/carte RÉELLES de cette machine) pour l'écran d'accueil :
 * montre concrètement ce que Jaris choisirait à 3 échelles de VRAM différentes, avec un repère clair sur
 * celle qui correspond à CETTE machine — sans jamais lancer le moindre téléchargement (computeModelPicks est
 * pur, verified-tool-scores.md/benchmark-results.md sont déjà sur le disque).
 */
export async function previewHardwareTiers(): Promise<HardwareTierPreview[]> {
  const { name, vramGb: actualVramGb } = await detectGpu()
  const ramGb = detectRamGb()
  const localBenchmark = parseLocalBenchmark()
  const verifiedToolScores = parseVerifiedToolScores()
  // Le palier "actuel" est celui dont la VRAM représentative est la plus proche de la VRAM RÉELLE détectée
  // (jamais un simple ordre croissant à 3 bornes fixes : une machine à 30 Go de VRAM doit quand même pointer
  // vers "Grande", pas déborder hors tableau).
  const currentIndex =
    actualVramGb === null
      ? 0
      : HARDWARE_TIER_PREVIEW_VRAM_GB.reduce(
          (bestIdx, gb, idx) => (Math.abs(gb - actualVramGb) < Math.abs(HARDWARE_TIER_PREVIEW_VRAM_GB[bestIdx] - actualVramGb) ? idx : bestIdx),
          0
        )
  return HARDWARE_TIER_PREVIEW_VRAM_GB.map((vramGb, i) => ({
    label: HARDWARE_TIER_PREVIEW_LABELS[i],
    vramGb,
    current: i === currentIndex,
    ...computeModelPicks(vramGb, ramGb, name, localBenchmark, verifiedToolScores)
  }))
}
