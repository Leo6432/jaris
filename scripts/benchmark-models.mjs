#!/usr/bin/env node
/**
 * Benchmark comparatif des modèles candidats pour Jaris, sur le matériel réel de l'utilisateur — plutôt
 * que de continuer à deviner à partir de benchmarks publiés (souvent absents, ou pas mesurés dans les
 * mêmes conditions). Utilise EXACTEMENT les mêmes schémas d'outils que Jaris (electron/services/tools.ts),
 * sans jamais les exécuter pour de vrai : on vérifie juste que le bon outil est appelé avec des arguments
 * plausibles, jamais qu'une appli s'ouvre réellement ou qu'un mail parte.
 *
 * Usage :
 *   node scripts/benchmark-models.mjs
 *   OLLAMA_HOST=http://127.0.0.1:11434 node scripts/benchmark-models.mjs
 *
 * Installe automatiquement (`ollama pull`) tout modèle de MODELS pas encore présent avant de le tester —
 * potentiellement plusieurs dizaines de Go au premier lancement si rien n'est encore installé. Lancé
 * depuis l'onglet Modèles de Jaris (bouton "Lancer le benchmark"), une confirmation est affichée avant de
 * démarrer, justement à cause de ce téléchargement potentiellement volumineux.
 */

import { exec } from 'child_process'
import { readFileSync, statfsSync, writeFileSync } from 'fs'
import { homedir, totalmem } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { deflateSync } from 'zlib'

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_PATH = join(__dirname, 'benchmark-results.md')
const VERIFIED_TOOL_SCORES_PATH = join(__dirname, 'verified-tool-scores.md')

const OLLAMA_HOST = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434'

/**
 * Modèles déjà vérifiés une fois par Léo (voir verified-tool-scores.md, commité dans le dépôt — valable
 * pour tout le monde, cette fiabilité ne dépend pas du matériel, contrairement à la vitesse). Exclus du
 * téléchargement/test de CE script (voir SCOPED_MODELS/SCOPED_VISION_CANDIDATES/SCOPED_CODE_CANDIDATES plus
 * bas) : aucune raison de retélécharger et retester un modèle dont le résultat ne peut pas changer d'une
 * machine à l'autre — seule sa vitesse est recalculée par formule pour cette machine (voir
 * estimateSpeedTokPerSec plus bas et hardwareScan.ts côté app, qui applique la même logique). Trois listes
 * séparées par palier (sections "## Conversation/Vision/Code" du fichier), PAS une seule liste par nom de
 * modèle : `qwen3.5:4b` (et `gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — un score
 * conversation ne doit jamais faire sauter, à tort, son propre test vision (bug déjà rencontré une fois
 * avec benchmark-results.md avant qu'on ne le corrige ici, voir parseVerifiedToolScores dans hardwareScan.ts
 * qui applique la même correction côté app).
 */
function readVerifiedModels() {
  const result = { conversation: new Set(), vision: new Set(), code: new Set() }
  let raw
  try {
    raw = readFileSync(VERIFIED_TOOL_SCORES_PATH, 'utf-8')
  } catch {
    return result
  }
  let currentTier = null
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
    result[currentTier].add(cells[0])
  }
  return result
}
const VERIFIED_MODELS = readVerifiedModels()

/**
 * Périmètre du run (AnalysisScope côté TS, shared/ipc.ts) : 'all' teste tout comme avant (comportement par
 * défaut si la variable n'est pas transmise, ex: lancé à la main depuis un terminal), un palier précis ne
 * teste QUE ses propres candidats — bien plus rapide pour re-tester un seul palier après un changement qui
 * ne le concerne que lui (ex: débloquer "Puissant" via VRAM+RAM). Transmis par benchmarkRunner.ts
 * (spawnBenchmarkScript) en variable d'environnement, jamais en argument CLI (plus simple à faire passer par
 * `child_process.spawn` sans avoir à gérer l'échappement des espaces d'un nom de modèle).
 */
const SCOPE = (process.env.JARIS_ANALYSIS_SCOPE?.trim() || 'all')

/**
 * Reprise après interruption (PC éteint, process tué en plein run...) : quand cette variable vaut '1', tout
 * modèle du périmètre déjà présent dans scripts/benchmark-results.md (donc déjà testé, que ce soit par ce
 * run interrompu grâce à la sauvegarde incrémentale — voir persistResults plus bas — ou par un run antérieur)
 * est sauté (ni retéléchargé ni retesté), sa ligne existante est juste conservée telle quelle. PAS le
 * comportement par défaut : sans cette variable, un run reteste tout son périmètre même si des résultats
 * existent déjà — c'est le fonctionnement voulu pour re-tester volontairement un palier après un changement
 * (voir le commentaire de SCOPE ci-dessus), la reprise doit donc rester un choix explicite.
 */
const RESUME = process.env.JARIS_RESUME === '1'

/**
 * Petite marge sous la VRAM totale détectée, pour le contexte (num_ctx, 4096 par défaut) et l'overhead
 * OS/pilote pendant le test — contrairement à STT_RESERVED_GB côté app (electron/services/hardwareScan.ts),
 * pas besoin de réserver de la place pour le STT ici : ce script tourne seul, sans le pipeline vocal.
 */
const VRAM_SAFETY_MARGIN_GB = 1

/**
 * Marge sous la RAM totale de la machine, réservée à l'OS et aux autres logiciels ouverts — jamais
 * disponible en entier pour un seul modèle, contrairement à ce qu'un simple `os.totalmem()` suggérerait.
 */
const RAM_SAFETY_MARGIN_GB = 8

/**
 * Modèles dont le filtre de taille ci-dessous vérifie VRAM + RAM combinées, pas la VRAM seule : contrairement
 * aux autres candidats (pensés pour tenir entièrement en VRAM, condition d'un usage voix/chat temps réel),
 * ceux-ci sont conçus pour déborder sur la RAM système (voir CODE_CANDIDATES dans hardwareScan.ts et
 * codeGenerator.ts). Les juger sur la VRAM seule les bloquerait à tort sur une machine avec beaucoup de RAM
 * mais peu de VRAM (le cas de Léo : 8 Go de VRAM, 64 Go de RAM) — mais ils doivent quand même être bloqués
 * sur une machine qui n'a NI la VRAM NI la RAM pour les faire tourner (ex: 12 Go de RAM et pas de GPU
 * dédié) : sans ce filtre, ce script tenterait de télécharger des dizaines de Go pour un modèle qui ne
 * tournerait de toute façon jamais correctement.
 *
 * Les 9 derniers (qwen3.5:35b/27b, qwen3.8:27b, qwen3.6:27b, gemma4:26b, gpt-oss:20b, command-r:35b,
 * mistral-small:24b, glm-4.7-flash:q4_K_M) sont les candidats du palier Puissant (LARGE_CANDIDATES dans
 * hardwareScan.ts) au-delà de la VRAM disponible sur une machine comme celle de Léo — ajoutés à la demande
 * explicite de Léo après avoir vu "Puissant" retomber sur un petit modèle faute de place : sur cette machine,
 * réserver 4,5 Go de VRAM en permanence pour le STT (voir STT_RESERVED_GB dans hardwareScan.ts) ne laissait
 * jamais assez de place pour un vrai grand modèle. Certains sont MoE (gemma4:26b, gpt-oss:20b probablement
 * glm-4.7-flash) et restent rapides même en débordant sur la RAM ; les autres sont denses (qwen3.5:35b/27b,
 * qwen3.8:27b, qwen3.6:27b, command-r:35b, mistral-small:24b) et seront NETTEMENT plus lents une fois
 * débordés — accepté en connaissance de cause, mieux vaut un vrai grand modèle plus lent qu'un petit modèle
 * rapide pour les questions qui demandent explicitement une réflexion poussée.
 */
const RAM_OFFLOAD_MODELS = new Set([
  'qwen3.6:35b-a3b',
  'qwen3-coder:30b',
  'north-mini-code-1.0',
  'qwen2.5-coder:32b',
  'devstral-small-2:24b',
  'qwen3.5:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'gemma4:26b',
  'gpt-oss:20b',
  'command-r:35b',
  'mistral-small:24b',
  'glm-4.7-flash:q4_K_M'
])

const MODELS = [
  'qwen3.5:2b', // par défaut en Q8_0 (2,74 Go) : plus précis mais plus lourd que la variante ci-dessous
  // Contrairement à qwen3.5:4b/9b (déjà en Q4_K_M par défaut, donc un tag "-q4_K_M" y serait redondant),
  // qwen3.5:2b par défaut est en Q8_0 : ce tag explicite est un fichier réellement différent (1,95 Go,
  // plus compressé, potentiellement plus rapide), donc ça vaut le coup de le comparer séparément.
  'qwen3.5:2b-q4_K_M',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'phi4-mini',
  'gemma4:e4b',
  // granite4.1:3b (remplace granite4:3b, retiré de MEDIUM_CANDIDATES dans hardwareScan.ts) : post-training
  // amélioré par IBM, même empreinte VRAM (~2,1 Go). Source : ollama.com/library/granite4.1, blog IBM Research.
  'granite4.1:3b',
  'nemotron-3-nano:4b',
  'ministral-3:3b',
  // Pas de tag officiel dans la bibliothèque Ollama pour ce 1.2B (seule la variante 8B-MoE y est) : import
  // direct depuis le dépôt Hugging Face officiel de LiquidAI, `ollama pull` fonctionne pareil avec ce préfixe.
  'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
  'qwen3:1.7b',
  'granite4:1b',
  // Repli ultime de tous les paliers dans hardwareScan.ts (FLASH/MEDIUM/LARGE_CANDIDATES) : manquait ici
  // par oubli, alors qu'il tient sur n'importe quelle config et est un vrai candidat pour du matériel
  // très contraint (pas de GPU, ou VRAM minuscule).
  'qwen3.5:0.8b',
  // Fait exclusivement pour le tool calling (pas pour la conversation générale) : ses réponses aux 2
  // questions de raisonnement du test n'ont pas vraiment de sens, mais intéressant sur les 6 tests d'outils.
  'functiongemma:270m',
  // Pas de tag officiel dans la bibliothèque Ollama : import direct depuis le dépôt Hugging Face officiel
  // d'OpenBMB (créateur du modèle) plutôt qu'une requantification tierce. Un seul checkpoint sert à la
  // fois de réponse rapide ("No-Think") et de réflexion approfondie ("Think") selon le chat template —
  // pensé explicitement pour assistants locaux / agents de code / appel d'outils, comme Jaris.
  'hf.co/openbmb/MiniCPM5-1B-GGUF',
  // Pas de tag officiel non plus : import depuis la requantification GGUF de bartowski (quantifieur
  // reconnu et fiable dans la communauté Ollama/llama.cpp), à partir du dépôt officiel ai9stars/G9v3-3B.
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF',
  // Ignorés jusqu'ici car trop gros pour la machine de dev (RTX 3070, 8 Go) : maintenant que le script
  // détecte la VRAM disponible et saute automatiquement ce qui ne rentre pas (voir detectVramGb ci-dessous),
  // les garder dans la liste permet aux utilisateurs avec plus de VRAM de vraiment les tester chez eux —
  // mêmes tailles que LARGE_CANDIDATES dans electron/services/hardwareScan.ts.
  'qwen3.5:35b',
  'qwen3.5:27b',
  // Successeur potentiel de qwen3.5:27b (LARGE_CANDIDATES dans hardwareScan.ts) : même taille de VRAM
  // (18 Go), vision+tools+thinking natifs. Gain rapporté en code/agentic par des sources tierces
  // uniquement — ce run donnera une vraie mesure locale plutôt que de deviner. Source taille :
  // ollama.com/library/qwen3.8 (tag 27b, 18 Go).
  'qwen3.8:27b',
  // Candidats supplémentaires dans la même tranche (14-19 Go), pour les machines avec plus de VRAM que la
  // config de développement — voir le commentaire complet dans hardwareScan.ts (LARGE_CANDIDATES).
  'qwen3.6:27b',
  'gemma4:26b',
  'gpt-oss:20b',
  'command-r:35b',
  'mistral-small:24b',
  'glm-4.7-flash:q4_K_M'
  // Les candidats du palier "Code" (qwen2.5-coder:7b/32b, qwen3.6:35b-a3b, qwen3-coder:30b,
  // north-mini-code-1.0, devstral-small-2:24b) NE sont PAS
  // ici : codeGenerator.ts (mode Code) n'appelle JAMAIS chatWithOllama avec des outils (le paramètre `tools`
  // y est toujours `undefined`), donc les tester sur TEST_CASES (appel d'outils) mesurait une capacité que
  // le mode Code n'utilise jamais. Ils ont leur propre test, plus bas (CODE_CANDIDATES/CODE_TEST_CASES).
]

// Candidats du palier Vision (VISION_CANDIDATES dans hardwareScan.ts, dupliqué ici pour la même raison que
// detectVramGb ci-dessous : ce script tourne en `node` simple, pas d'import direct possible depuis le TS
// bundlé). Testés séparément de MODELS ci-dessus : la question n'est pas "suit-il les instructions de
// Jaris" (tool-calling) mais "comprend-il vraiment ce qu'il voit" (voir VISION_TEST_CASES plus bas).
// Même ordre (du plus gros au plus petit) que hardwareScan.ts, pour la même raison (voir son commentaire) —
// gemma4:e4b (le plus gros) doit rester en tête, pas en queue.
const VISION_CANDIDATES = [
  // qwen3.5/gemma4:e4b sont nativement multimodaux (déjà dans MEDIUM_CANDIDATES) : testés ici pour savoir
  // si réutiliser le modèle de conversation déjà chargé tient tête à un modèle vision dédié — voir le
  // commentaire complet dans hardwareScan.ts.
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3-vl:8b', vramGb: 8 },
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  { model: 'qwen3-vl:4b', vramGb: 5 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3-vl:2b', vramGb: 3 }
]

// Candidats du palier Code (CODE_CANDIDATES dans hardwareScan.ts, dupliqué ici pour la même raison que
// VISION_CANDIDATES/detectVramGb ci-dessus). Testés séparément de MODELS : pas sur l'appel d'outils
// (codeGenerator.ts n'en utilise jamais, voir CODE_TEST_CASES plus bas) mais sur la génération de code.
const CODE_CANDIDATES = [
  { model: 'qwen3.6:35b-a3b', vramGb: 22 },
  // Ligne dédiée code d'Alibaba, DISTINCTE de qwen3.6:35b-a3b malgré une taille/architecture proche (30 Md
  // total / 3,3 Md actifs, MoE, 19 Go) — vérifié directement sur Ollama, les deux tags existent séparément.
  { model: 'qwen3-coder:30b', vramGb: 19 },
  { model: 'north-mini-code-1.0', vramGb: 19 },
  { model: 'qwen2.5-coder:32b', vramGb: 20 },
  // Mistral, agent de code autonome. DENSE (comme qwen2.5-coder:32b) : voir la même remarque dans
  // hardwareScan.ts. Vérifié sur ollama.com/library/devstral-small-2 (15 Go).
  { model: 'devstral-small-2:24b', vramGb: 15 },
  { model: 'qwen2.5-coder:7b', vramGb: 4.7 }
]

/**
 * Taille réelle de téléchargement (Go) de chaque entrée de MODELS, UNIQUEMENT pour pondérer la barre de
 * progression et l'estimation de temps restant ci-dessous — jamais pour la vérification de sécurité
 * VRAM/RAM (celle-ci reste basée sur `progress.total` révélé par le manifeste Ollama en direct, voir
 * pullModel). Les tailles des paliers Rapide/Médium/Puissant viennent de FLASH/MEDIUM/LARGE_CANDIDATES
 * (electron/services/hardwareScan.ts) ou des commentaires de MODELS ci-dessus ; celles sans comparateur
 * dans hardwareScan.ts (phi4-mini, nemotron-3-nano, ministral-3, granite4:1b, functiongemma, les 3 imports
 * Hugging Face) ont été vérifiées directement sur ollama.com/library/<modèle>/tags ou l'onglet "Files" du
 * dépôt Hugging Face (taille du fichier Q4_K_M, la quantification par défaut) avant d'écrire ce tableau.
 */
const MODEL_SIZE_HINTS = {
  'qwen3.5:2b': 2.74,
  'qwen3.5:2b-q4_K_M': 1.95,
  'qwen3.5:4b': 3.4,
  'qwen3.5:9b': 6.6,
  'phi4-mini': 2.5,
  'gemma4:e4b': 9.6,
  'granite4.1:3b': 2.1,
  'nemotron-3-nano:4b': 2.8,
  'ministral-3:3b': 3.0,
  'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF': 0.73,
  'qwen3:1.7b': 2.0,
  'granite4:1b': 3.3,
  'qwen3.5:0.8b': 1.0,
  'functiongemma:270m': 0.3,
  'hf.co/openbmb/MiniCPM5-1B-GGUF': 0.69,
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF': 1.9,
  'qwen3.5:35b': 24,
  'qwen3.5:27b': 17,
  'qwen3.8:27b': 18,
  'qwen3.6:27b': 18,
  'gemma4:26b': 19,
  'gpt-oss:20b': 14,
  'command-r:35b': 19,
  'mistral-small:24b': 14,
  'glm-4.7-flash:q4_K_M': 19
}

// Combine MODEL_SIZE_HINTS avec les tailles déjà présentes sur VISION_CANDIDATES/CODE_CANDIDATES (pas la
// peine de les dupliquer) pour un seul point d'accès à la taille de n'importe quel modèle candidat.
const MODEL_WEIGHT_GB = new Map([
  ...Object.entries(MODEL_SIZE_HINTS),
  ...VISION_CANDIDATES.map((c) => [c.model, c.vramGb]),
  ...CODE_CANDIDATES.map((c) => [c.model, c.vramGb])
])

/** Repli raisonnable si un modèle est ajouté un jour sans entrée dans MODEL_WEIGHT_GB. */
function modelWeightGb(model) {
  return MODEL_WEIGHT_GB.get(model) ?? 4
}

/**
 * Appartenance de chaque modèle de MODELS aux paliers Rapide/Médium/Puissant — dupliqué depuis
 * FLASH/MEDIUM/LARGE_CANDIDATES (electron/services/hardwareScan.ts) pour la même raison que MODEL_SIZE_HINTS
 * (ce script tourne en `node` simple, pas d'import TS possible). UNIQUEMENT utilisé ci-dessous pour décider
 * quels modèles peuvent être supprimés en cours de route sur une machine à l'espace disque limité (voir
 * tightDiskMode dans main()) — jamais pour la sélection finale du meilleur modèle de chaque palier, qui reste
 * entièrement décidée par pickBestFrom (hardwareScan.ts) à partir du fichier de résultats.
 */
const FLASH_TIER_MODELS = new Set(['qwen3:1.7b', 'qwen3.5:0.8b'])
const MEDIUM_TIER_MODELS = new Set(['gemma4:e4b', 'qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:2b', 'granite4.1:3b', 'qwen3.5:0.8b'])
const LARGE_TIER_MODELS = new Set([
  'qwen3.5:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'gemma4:26b',
  'gpt-oss:20b',
  'command-r:35b',
  'mistral-small:24b',
  'glm-4.7-flash:q4_K_M',
  // hardwareScan.ts reprend aussi ces 4 dans LARGE_CANDIDATES comme repli si rien de plus gros ne rentre,
  // ce qui les rend multi-paliers (voir isSafeToPruneEarly ci-dessous) : présents ici pour que
  // FLASH/MEDIUM/LARGE_TIER_MODELS reflètent fidèlement hardwareScan.ts, même si en pratique ça les exclut
  // du nettoyage anticipé.
  'qwen3.5:9b',
  'qwen3.5:4b',
  'qwen3.5:2b',
  'qwen3.5:0.8b'
])
const VISION_TIER_MODELS = new Set(VISION_CANDIDATES.map((c) => c.model))

/**
 * Sous-ensembles de MODELS/VISION_CANDIDATES/CODE_CANDIDATES réellement testés CE run, d'après SCOPE — pour
 * un palier de conversation (flash/medium/large), on filtre MODELS par appartenance (voir
 * FLASH/MEDIUM/LARGE_TIER_MODELS) puisque c'est une liste plate qui couvre les trois à la fois ; pour
 * vision/code, on garde ou on vide la liste entière (déjà séparée). `scope === 'all'` (comportement par
 * défaut) garde tout, exactement comme avant l'ajout de SCOPE. Exclut aussi tout modèle déjà dans
 * VERIFIED_MODELS (voir sa définition) : jamais téléchargé ni testé par ce script, sa fiabilité vient de
 * verified-tool-scores.md, sa vitesse d'une formule côté app — pas de ce script. La bonne liste par palier
 * (`.conversation`/`.vision`/`.code`) évite qu'un modèle candidat aux deux (ex: qwen3.5:4b, Conversation ET
 * Vision) ne saute son test vision juste parce qu'il a un score conversation, et inversement.
 */
const SCOPED_MODELS = (
  SCOPE === 'all'
    ? MODELS
    : SCOPE === 'flash'
      ? MODELS.filter((m) => FLASH_TIER_MODELS.has(m))
      : SCOPE === 'medium'
        ? MODELS.filter((m) => MEDIUM_TIER_MODELS.has(m))
        : SCOPE === 'large'
          ? MODELS.filter((m) => LARGE_TIER_MODELS.has(m))
          : []
).filter((m) => !VERIFIED_MODELS.conversation.has(m))
const SCOPED_VISION_CANDIDATES = (SCOPE === 'all' || SCOPE === 'vision' ? VISION_CANDIDATES : []).filter(
  (c) => !VERIFIED_MODELS.vision.has(c.model)
)
const SCOPED_CODE_CANDIDATES = (SCOPE === 'all' || SCOPE === 'code' ? CODE_CANDIDATES : []).filter(
  (c) => !VERIFIED_MODELS.code.has(c.model)
)

/**
 * `true` seulement si `model` appartient à EXACTEMENT un des trois paliers de conversation ET n'est candidat
 * vision nulle part ailleurs — dans ce cas (et SEULEMENT dans ce cas), on sait avec certitude, dès que son
 * propre test est fini, s'il peut être supprimé sans risquer de le priver d'un autre palier qui en aurait
 * encore besoin (ex: qwen3.5:4b sert À LA FOIS de candidat médium ET de candidat vision — le supprimer trop
 * tôt parce qu'il perd en médium le priverait d'une chance en vision, testée plus tard). Les modèles
 * multi-paliers (qwen3.5:0.8b/2b/4b/9b, gemma4:e4b) restent simplement gardés jusqu'à la fin du run, comme
 * avant — cette prudence ne coûte pas cher : ce sont aussi les plus petits modèles, jamais les gros qui
 * remplissent vraiment le disque.
 */
function singleTierOf(model) {
  if (VISION_TIER_MODELS.has(model)) return null
  const tiers = ['flash', 'medium', 'large'].filter(
    (t) => (t === 'flash' ? FLASH_TIER_MODELS : t === 'medium' ? MEDIUM_TIER_MODELS : LARGE_TIER_MODELS).has(model)
  )
  return tiers.length === 1 ? tiers[0] : null
}

/**
 * Sous-ensemble de VISION_CANDIDATES sans double-emploi avec un autre palier (qwen3.5:4b et gemma4:e4b sont
 * EXCLUS : déjà candidats médium, voir singleTierOf) — mêmes garanties que ci-dessus, pour le palier vision.
 */
const PRUNABLE_VISION_MODELS = new Set(
  VISION_CANDIDATES.map((c) => c.model).filter((m) => !MEDIUM_TIER_MODELS.has(m) && !FLASH_TIER_MODELS.has(m) && !LARGE_TIER_MODELS.has(m))
)

async function deleteModelViaApi(model) {
  const res = await fetch(`${OLLAMA_HOST}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model })
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

// Copié tel quel depuis electron/services/tools.ts : mêmes schémas que Jaris utilise réellement en
// conversation, pour que le test reflète le vrai comportement de tool calling, pas un cas simplifié.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        "Ouvre n'importe quelle application installée sur l'ordinateur de l'utilisateur (pas seulement " +
        "quelques applications connues : appelle toujours cet outil avec le nom demandé, il cherche lui-même " +
        "parmi toutes les applications installées sur la machine).",
      parameters: {
        type: 'object',
        properties: { app_name: { type: 'string', description: "Nom de l'application à ouvrir, tel que demandé par l'utilisateur" } },
        required: ['app_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Programme un rappel vocal qui sera dit à voix haute dans un certain nombre de minutes.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Le contenu du rappel à dire à voix haute' },
          delay_minutes: { type: 'number', description: 'Dans combien de minutes déclencher le rappel' }
        },
        required: ['message', 'delay_minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at_screen',
      description:
        "Capture une image de l'écran de l'utilisateur et la décrit, ou répond à une question précise sur " +
        "ce qui y est affiché (ex: lire un message d'erreur, décrire une fenêtre ouverte).",
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: "Ce qu'il faut chercher ou décrire sur l'écran, en français" } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: "Recherche sur le web (moteur local) pour des informations récentes, actuelles, ou que tu ne connais pas avec certitude.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Les mots-clés de recherche' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Enregistre une information importante à retenir sur le long terme dans la mémoire locale de Jaris " +
        "(préférence de l'utilisateur, fait donné en conversation, résumé à garder).",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titre court de la note' },
          content: { type: 'string', description: 'Le contenu à retenir, en markdown' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Envoie un vrai mail via le compte configuré par l'utilisateur.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: "Adresse mail EXACTE du destinataire" },
          subject: { type: 'string', description: 'Objet du mail' },
          body: { type: 'string', description: 'Contenu du mail, en texte simple' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: "Écrit du texte à l'endroit où se trouve le curseur/focus actuel sur l'ordinateur.",
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Le texte exact à taper' } },
        required: ['text']
      }
    }
  }
]

const SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local. Réponds en français, de façon " +
  "concise et naturelle, comme dans une conversation orale, sans émojis ni mise en forme. Pour toute action " +
  "concrète, appelle IMPÉRATIVEMENT l'outil correspondant via un vrai appel de fonction, immédiatement, sans " +
  "phrase d'annonce avant. Si aucune action n'est demandée, réponds directement sans outil."

/** Chaque prompt réaliste tiré de vrais usages de Jaris ; expectedTool: null = pas d'outil attendu (juste conversationnel). */
const TEST_CASES = [
  { prompt: 'Écris bonjour dans le champ de texte ouvert.', expectedTool: 'type_text' },
  { prompt: 'Cherche le prix du Bitcoin aujourd\'hui.', expectedTool: 'search_web' },
  { prompt: "Rappelle-moi d'appeler le dentiste dans 20 minutes.", expectedTool: 'set_reminder' },
  { prompt: 'Qu\'est-ce qui est affiché sur mon écran en ce moment ?', expectedTool: 'look_at_screen' },
  { prompt: 'Ouvre le bloc-notes.', expectedTool: 'open_app' },
  { prompt: 'Retiens que mon code postal est 75001.', expectedTool: 'remember' },
  { prompt: 'Explique-moi en une phrase pourquoi le ciel est bleu.', expectedTool: null },
  { prompt: 'Comment tu t\'appelles et qu\'est-ce que tu peux faire pour moi ?', expectedTool: null }
]

/**
 * Encodeur PNG minimal (RGB 8 bits, sans dépendance externe — juste zlib, déjà dans Node) pour générer les
 * images de test de VISION_TEST_CASES ci-dessous à la volée, plutôt que de committer des fichiers image
 * binaires dans le dépôt. Suffisant pour des aplats de couleur simples, pas un encodeur PNG complet.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** `fillFn(x, y) -> [r, g, b]` pour chaque pixel — assez pour des aplats/zones de couleur, pas besoin de plus. */
function makePngBase64(width, height, fillFn) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // type de filtre "aucun" pour cette ligne
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y)
      const i = y * (stride + 1) + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // profondeur 8 bits
  ihdr[9] = 2 // type de couleur : RGB
  // ihdr[10..12] (compression/filtre/entrelacement) restent à 0, valeurs standard PNG.

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return png.toString('base64')
}

// Rouge/vert/bleu francs, faciles à nommer sans ambiguïté (pas de teintes intermédiaires prêtant à
// interprétation) — le but est de vérifier que le modèle voit VRAIMENT l'image, pas de tester sa culture
// des nuanciers.
const RED = [214, 40, 40]
const GREEN = [40, 180, 74]
const BLUE = [42, 92, 214]

/**
 * Test du palier Vision (VISION_CANDIDATES ci-dessus) : au lieu du tool-calling testé pour les modèles de
 * conversation (TEST_CASES), la question qui compte pour la vision est "le modèle voit-il vraiment
 * l'image ?" — des questions à réponse unique et objectivement vérifiable (couleur, comptage), pas un
 * jugement de description ouverte qu'il faudrait noter à la main. `check` reçoit la réponse en minuscules.
 */
const VISION_TEST_CASES = [
  {
    image: () => makePngBase64(96, 96, () => BLUE),
    prompt: 'Quelle est la couleur dominante de cette image ? Réponds uniquement avec le nom de la couleur, en un seul mot.',
    check: (answer) => /\bbleu(e)?\b|\bblue\b/.test(answer)
  },
  {
    image: () => makePngBase64(128, 64, (x) => (x < 64 ? RED : GREEN)),
    prompt: 'Le côté GAUCHE de cette image est-il plutôt rouge ou plutôt vert ? Réponds en un seul mot.',
    check: (answer) => /\brouge\b|\bred\b/.test(answer) && !/\bvert(e)?\b|\bgreen\b/.test(answer)
  },
  {
    image: () =>
      makePngBase64(160, 160, (x, y) => {
        const squares = [
          [20, 20],
          [90, 30],
          [50, 110]
        ]
        const inSquare = squares.some(([sx, sy]) => x >= sx && x < sx + 20 && y >= sy && y < sy + 20)
        return inSquare ? [20, 20, 20] : [245, 245, 245]
      }),
    prompt: 'Combien de carrés noirs vois-tu dans cette image ? Réponds uniquement avec le chiffre.',
    check: (answer) => /\b3\b|\btrois\b/.test(answer)
  }
]

/**
 * Copié tel quel depuis electron/services/codeGenerator.ts (APP_RULES/GENERATE_SYSTEM_PROMPT/extractHtml/
 * validateGeneratedHtml) — même raison que VISION_CANDIDATES/detectVramGb ci-dessus, pas d'import TS
 * possible depuis ce script autonome. Si ces règles changent côté app, penser à reporter le changement ici.
 * Volontairement UNE seule passe de génération, sans la relecture/réparation de generateApp : le but est de
 * mesurer la capacité BRUTE du modèle, pas la qualité une fois lissée par tout le pipeline autour.
 */
const CODE_APP_RULES = [
  "Produis UN SEUL fichier HTML complet et autonome, commençant par <!DOCTYPE html> et finissant par </html>.",
  "Fais EXACTEMENT ce qui est demandé, rien de plus : n'invente aucune fonctionnalité, aucun titre, aucun " +
    "texte d'ambiance ni aucun élément d'interface qui n'a pas été demandé. Une demande simple (un bouton) " +
    "doit donner une page simple. Soigner le design ne veut pas dire ajouter du contenu en plus. Quand " +
    "l'utilisateur précise un libellé, une couleur ou un comportement, reprends-le au mot près.",
  "N'utilise JAMAIS de classe CSS venant d'une bibliothèque externe (Bootstrap, Tailwind, Font Awesome, " +
    "Material Icons, Bootstrap Icons...) : ces bibliothèques ne sont pas chargées dans le fichier, donc ces " +
    "classes n'ont aucun effet. En particulier, aucune police d'icônes : une icône s'écrit en SVG inline, " +
    "directement dans le HTML. Écris toi-même chaque règle CSS que tu utilises, dans la balise <style>.",
  "AUCUNE ressource externe : pas de <script src>, pas de <link href> vers un CDN, pas de police Google " +
    "Fonts, pas d'image distante, pas de fetch vers une API. Tout (CSS, JavaScript, icônes) doit être écrit " +
    "en dur dans le fichier. Pour les icônes et les illustrations, utilise du SVG inline. Pour les données " +
    "d'exemple, écris-les en dur dans le JavaScript.",
  "JavaScript classique uniquement (pas de React, Vue, ni aucun framework, pas de syntaxe de modules " +
    "import/export) : le fichier doit fonctionner en l'ouvrant directement dans un navigateur.",
  "TOUT le JavaScript doit être à l'intérieur d'une balise <script> placée juste avant </body>, et tout le " +
    "CSS à l'intérieur d'une balise <style> dans le <head>. Aucune ligne de code ne doit se retrouver " +
    "directement dans le <body> : elle s'afficherait alors comme du texte à l'écran au lieu de s'exécuter.",
  "Écris le code sur plusieurs lignes correctement indentées, jamais tout sur une seule ligne. Dans le " +
    "JavaScript, utilise uniquement des commentaires /* ... */ et jamais // : si le code se retrouve " +
    "malgré tout sur une seule ligne, un // commenterait tout le reste de la ligne et casserait la page.",
  "Soigne le design : palette cohérente, vraie hiérarchie typographique, espacements réguliers, coins " +
    "arrondis, états au survol, et une mise en page responsive (grid ou flex) qui tient aussi sur mobile.",
  "Structure le code en sections claires et commentées, avec des noms de fonctions et de classes CSS " +
    "explicites, plutôt qu'un seul bloc monolithique.",
  "Gère les cas limites visibles par l'utilisateur : liste vide, champ non rempli, saisie invalide, action " +
    "impossible. L'interface ne doit jamais rester silencieuse ou cassée après une action.",
  "Si l'application a besoin de garder des données entre deux ouvertures, utilise localStorage, en " +
    "protégeant chaque lecture/écriture par un try/catch."
]

const CODE_GENERATE_SYSTEM_PROMPT =
  "Tu es un développeur front-end expert. Tu génères des applications web complètes et fonctionnelles à " +
  "partir d'une description en langage naturel.\n\n" +
  `Règles impératives :\n${CODE_APP_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  "Réponds UNIQUEMENT avec le code du fichier, dans un bloc ```html. Aucune explication avant ou après."

function extractHtml(raw) {
  const fences = [...raw.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1].trim())
  const candidates = fences.length ? [...fences] : [raw]
  if (fences.length > 1) candidates.push(fences.join('\n'))

  const documents = candidates
    .map((candidate) => {
      const start = candidate.search(/<!DOCTYPE html|<html[\s>]/i)
      return start === -1 ? null : candidate.slice(start).trim()
    })
    .filter((document) => document !== null)

  if (!documents.length) return null

  const score = (document) => (/<body[\s>]/i.test(document) ? 2 : 0) + (/<\/html>/i.test(document) ? 1 : 0)
  return documents.reduce((best, document) => (score(document) > score(best) ? document : best))
}

function validateGeneratedHtml(html) {
  const issues = []

  if (!/<html[\s>]/i.test(html)) issues.push('la balise <html> est absente')
  if (!/<body[\s>]/i.test(html)) issues.push('la balise <body> est absente')

  const opened = (html.match(/<script[\s>]/gi) ?? []).length
  const closed = (html.match(/<\/script>/gi) ?? []).length
  if (opened !== closed) {
    issues.push(`les balises <script> ne sont pas appariées (${opened} ouvrante(s), ${closed} fermante(s))`)
  }

  const GHOST_PREFIXES = /^(?:material-icons|material-symbols|glyphicon|fa-(?:solid|regular|brands|light|thin|duotone))/i
  const GHOST_EXACT = new Set(['fa', 'fas', 'far', 'fab', 'bi', 'mdi'])
  const ghostClasses = [
    ...new Set(
      (html.match(/class\s*=\s*["']([^"']*)/gi) ?? [])
        .flatMap((attr) => attr.replace(/^class\s*=\s*["']/i, '').split(/\s+/))
        .filter((token) => token && (GHOST_PREFIXES.test(token) || GHOST_EXACT.has(token.toLowerCase())))
    )
  ]
  if (ghostClasses.length) {
    issues.push(`le fichier utilise des classes d'une bibliothèque externe non chargée : ${ghostClasses.slice(0, 4).join(', ')}`)
  }

  const external = [...new Set(html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [])]
  if (external.length) {
    issues.push(`le fichier charge des ressources externes, interdites ici : ${external.slice(0, 3).join(', ')}`)
  }

  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')

  const jsSignals = [
    /document\.(addEventListener|querySelector|getElementById)/,
    /\bfunction\s+\w+\s*\(/,
    /=>\s*\{/,
    /\b(?:const|let|var)\s+\w+\s*=/,
    /\.addEventListener\s*\(/
  ]
  if (jsSignals.filter((pattern) => pattern.test(visibleText)).length >= 2) {
    issues.push("du code JavaScript se trouve directement dans le <body> au lieu d'une balise <script>")
  }

  return issues
}

/**
 * Test du palier Code : une seule question par cas, à réponse vérifiable MÉCANIQUEMENT (validateGeneratedHtml,
 * pas un jugement humain sur le design) — cohérent avec la philosophie de VISION_TEST_CASES ci-dessus.
 * `correct` = extraction HTML réussie ET zéro problème détecté par validateGeneratedHtml.
 */
const CODE_TEST_CASES = [
  'Un compteur avec un bouton "+1" et un bouton "reset" qui remet le compteur à zéro.',
  'Une todo list : un champ pour ajouter une tâche, un bouton "ajouter", la liste des tâches ajoutées, et un bouton pour supprimer chaque tâche.',
  'Un formulaire de contact avec un champ nom, un champ email, un champ message, et un bouton "envoyer" qui affiche un message de confirmation.'
]

async function listInstalledModels() {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`)
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} (est-il lancé sur ${OLLAMA_HOST} ?)`)
  const data = await res.json()
  return (data.models ?? []).map((m) => m.name)
}

/**
 * VRAM totale de la carte NVIDIA détectée (Go), même requête que detectGpu() dans
 * electron/services/hardwareScan.ts — dupliquée ici volontairement : ce script tourne en `node` simple, pas
 * via le bundler Electron/TS, donc pas d'import direct possible entre les deux. `null` sans GPU NVIDIA
 * détecté (ou en cas d'erreur, ou carte AMD/Intel — non détectées par cette commande) : main() retombe
 * alors sur un budget basé sur la RAM seule, jamais sur "aucune limite".
 */
async function detectVramGb() {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { windowsHide: true })
    const mib = parseInt(stdout.trim().split('\n')[0], 10)
    return Number.isFinite(mib) ? mib / 1024 : null
  } catch {
    return null
  }
}

/** RAM totale de la machine (Go) : contrairement à la VRAM, Node sait la lire directement, sans commande externe. */
function detectRamGb() {
  return totalmem() / 1024 ** 3
}

/**
 * Marge sous l'espace disque libre détecté, réservée aux fichiers temporaires créés pendant un téléchargement
 * et à l'espace de manœuvre normal du système — même esprit que RAM_SAFETY_MARGIN_GB, mais pour le disque.
 * Dupliquée depuis electron/services/systemResources.ts pour la même raison que detectVramGb ci-dessus.
 */
const DISK_SAFETY_MARGIN_GB = 5

/**
 * Espace disque libre (Go) sur le disque où Ollama stocke ses modèles — jusqu'ici jamais vérifié : ce script
 * (comme l'app) ne regardait que si un modèle tenait en VRAM+RAM pour TOURNER, jamais s'il y avait la place
 * de le TÉLÉCHARGER d'abord. Relue à CHAQUE appel (jamais mise en cache) : contrairement à la VRAM/RAM,
 * l'espace disque diminue au fil des téléchargements successifs du run — un modèle testé en fin de liste
 * doit voir l'espace RÉELLEMENT restant à ce moment-là, pas une valeur figée au tout début. `null` si
 * `fs.statfsSync` échoue (plateforme non supportée, permissions) : l'appelant ignore alors ce filtre plutôt
 * que de bloquer tout téléchargement sur une valeur inconnue.
 */
function detectFreeDiskGb() {
  const candidates = [process.env.OLLAMA_MODELS?.trim(), join(homedir(), '.ollama', 'models'), homedir()].filter(Boolean)
  for (const dir of candidates) {
    try {
      const stats = statfsSync(dir)
      return (stats.bavail * stats.bsize) / 1024 ** 3
    } catch {
      continue
    }
  }
  return null
}

/**
 * Nombre de téléchargements menés EN PARALLÈLE avec les tests des modèles déjà installés (voir main()) : au
 * lieu de "tout télécharger PUIS tout tester" (réseau inactif pendant les tests, GPU inactif pendant les
 * téléchargements), un modèle peut maintenant se télécharger en tâche de fond pendant qu'un AUTRE, déjà prêt,
 * passe ses tests — les deux étapes utilisent des ressources différentes (bande passante vs GPU/CPU) et ne se
 * gênent quasiment pas.
 *
 * Adapté à la RAM détectée plutôt qu'une valeur fixe — à la demande explicite de Léo ("il doit voir avec le
 * PC, et avec des PC assez forts on peut aller jusqu'à 4") après avoir remarqué que le vrai goulot d'un run
 * "Puissant" est le téléchargement des gros candidats (14-24 Go chacun, débloqués par le budget VRAM+RAM),
 * pas les tests. Une machine avec beaucoup de RAM encaisse généralement mieux plusieurs téléchargements
 * simultanés (buffers réseau, écriture disque en tâche de fond) — mais reste borné à 4 : au-delà, plusieurs
 * téléchargements se partagent la même bande passante sans vraiment aller plus vite, pour un risque accru de
 * contention disque. Toujours écrasé à 1 si l'espace disque est serré (voir tightDiskMode dans main()) —
 * cette sécurité prime toujours sur la vitesse, quelle que soit la RAM disponible.
 */
function pullConcurrencyFor(ramGb) {
  if (ramGb >= 32) return 4
  if (ramGb >= 16) return 3
  return 2
}

class ModelTooLargeError extends Error {
  constructor(model, requiredGb, budgetGb) {
    super(`nécessite ~${requiredGb.toFixed(1)} Go, au-delà des ${budgetGb.toFixed(1)} Go disponibles sur cette carte`)
    this.name = 'ModelTooLargeError'
    this.model = model
  }
}

/** Distinct de ModelTooLargeError (VRAM+RAM, "peut-il tourner ?") : contrainte de place pour le télécharger. */
class DiskFullError extends Error {
  constructor(model, requiredGb, freeDiskGb) {
    super(`nécessite ~${requiredGb.toFixed(1)} Go, au-delà des ${freeDiskGb.toFixed(1)} Go d'espace disque libre`)
    this.name = 'DiskFullError'
    this.model = model
  }
}

/**
 * Télécharge `model` via Ollama, avec une progression affichée par tranche de 10% (pas à chaque %, sinon
 * ~100 lignes par modèle) : lisible aussi bien dans un vrai terminal que dans le journal en direct de
 * l'onglet Modèles de Jaris (qui découpe la sortie ligne par ligne, un `\r` ne s'y afficherait pas pareil).
 *
 * `budgetGb` est toujours un nombre concret (jamais de valeur "illimité", voir main()) : dès que le
 * manifeste Ollama révèle la taille réelle du modèle (`progress.total`, en octets, disponible avant la fin
 * du téléchargement), on annule le téléchargement tout de suite si ça dépasse le budget — pas la peine de
 * télécharger plusieurs Go pour un modèle qui ne rentrera de toute façon jamais sur cette machine.
 *
 * `diskCtx` (`{ reservedGb }`, partagé par TOUS les téléchargements en cours, voir pullConcurrencyFor) permet
 * de vérifier l'espace disque LIBRE en tenant compte des téléchargements concurrents déjà engagés mais pas
 * encore terminés : sans ça, deux téléchargements lancés en même temps liraient chacun le même espace libre
 * et pourraient tous les deux se croire seuls légitimes à l'utiliser en entier.
 *
 * `onBucket(bucketPercent)` est appelé à chaque palier de 10% en plus des logs ci-dessous : c'est main()
 * qui s'en sert pour convertir "ce modèle est à 40%" en "X Go sur Y Go au total ont été téléchargés",
 * la vraie unité de la barre de progression pondérée (voir MODEL_WEIGHT_GB).
 */
async function pullModel(model, budgetGb, diskCtx, onBucket) {
  console.log(`Téléchargement de ${model}…`)
  const controller = new AbortController()
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: controller.signal
  })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastBucket = -1
  let sizeChecked = false
  let reservedGb = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue

        let progress
        try {
          progress = JSON.parse(line)
        } catch {
          continue
        }
        if (progress.error) throw new Error(progress.error)

        if (!sizeChecked && progress.total) {
          sizeChecked = true
          const requiredGb = progress.total / 1024 ** 3
          if (requiredGb > budgetGb) {
            controller.abort()
            throw new ModelTooLargeError(model, requiredGb, budgetGb)
          }
          // Vérifié À CE MOMENT PRÉCIS (pas au tout début de main()) : l'espace disque diminue au fil des
          // téléchargements précédents de ce même run, un modèle testé en fin de liste doit voir l'espace
          // RÉELLEMENT restant, pas une estimation figée avant le premier téléchargement.
          const freeDiskGb = detectFreeDiskGb()
          if (freeDiskGb !== null) {
            const availableGb = Math.max(0, freeDiskGb - DISK_SAFETY_MARGIN_GB - diskCtx.reservedGb)
            if (requiredGb > availableGb) {
              controller.abort()
              throw new DiskFullError(model, requiredGb, availableGb)
            }
            reservedGb = requiredGb
            diskCtx.reservedGb += reservedGb
          }
        }

        if (progress.total && progress.completed !== undefined) {
          const bucket = Math.floor((progress.completed / progress.total) * 10) * 10
          if (bucket !== lastBucket) {
            lastBucket = bucket
            console.log(`  ${model} : ${bucket}%`)
            // Progression FINE du modèle en cours de téléchargement (pas juste "N modèles sur M") : sans ça,
            // un seul gros modèle (qwen3.6:35b-a3b, north-mini-code-1.0...) fait stagner la barre de
            // progression pendant plusieurs minutes d'affilée, sans aucun retour visuel entre-temps. Le nom
            // du modèle est inclus (pas juste le %) : pullConcurrencyFor autorise plusieurs téléchargements en
            // même temps, il faut distinguer lequel progresse.
            console.log(`##PULL_MODEL_PROGRESS## ${model} ${bucket}`)
            onBucket?.(bucket)
          }
        }
      }
    }
  } finally {
    // Libère la réservation quoi qu'il arrive (succès, erreur, taille dépassée) : une fois ce téléchargement
    // terminé (ou abandonné), l'espace qu'il a réellement pris sera de toute façon reflété par le prochain
    // detectFreeDiskGb() — inutile de continuer à le compter en plus.
    diskCtx.reservedGb -= reservedGb
  }
}

/**
 * Certains modèles (constaté : granite4, ministral-3, functiongemma) n'ont pas de mode réflexion et
 * rejettent le paramètre `think` avec une erreur, contrairement aux familles Qwen/Gemma4/Nemotron qui le
 * supportent toutes. Plutôt que de maintenir une liste de compatibilité à la main (fragile, à mettre à
 * jour à chaque nouveau modèle testé), on retente une fois sans `think` si le premier essai échoue.
 */
async function chatOnce(model, prompt, withThink) {
  const start = performance.now()
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    tools: TOOLS,
    stream: false
  }
  if (withThink) body.think = 'medium'

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const wallMs = performance.now() - start
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return { wallMs, data: await res.json() }
}

async function chat(model, prompt) {
  let wallMs, data
  try {
    ;({ wallMs, data } = await chatOnce(model, prompt, true))
  } catch (firstErr) {
    try {
      ;({ wallMs, data } = await chatOnce(model, prompt, false))
    } catch {
      throw firstErr // le premier message d'erreur est généralement le plus informatif (statut HTTP réel)
    }
  }
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  const tokPerSec = evalDurationS > 0 ? evalCount / evalDurationS : null
  const toolCalls = data.message?.tool_calls ?? []
  return {
    wallMs,
    tokPerSec,
    toolName: toolCalls[0]?.function?.name ?? null,
    toolArgs: toolCalls[0]?.function?.arguments ?? null,
    content: data.message?.content?.trim() ?? ''
  }
}

/**
 * Même appel que lookAtScreen (electron/services/vision.ts) : pas d'outils, `think: false` toujours (les
 * modèles vision ne le supportent pas forcément, et la production ne l'utilise jamais ici) — pour que ce
 * test mesure le comportement réel de Jaris, pas un usage générique de l'API vision.
 */
async function chatVision(model, prompt, imageBase64) {
  const start = performance.now()
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
      stream: false,
      think: false
    })
  })
  const wallMs = performance.now() - start
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const data = await res.json()
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  return {
    wallMs,
    tokPerSec: evalDurationS > 0 ? evalCount / evalDurationS : null,
    content: data.message?.content?.trim() ?? ''
  }
}

/**
 * Même appel que generateApp (electron/services/codeGenerator.ts) pour SA première passe (génération) :
 * pas d'outils (`tools` jamais passé, voir la note dans MODELS ci-dessus — c'est tout le point de ce test
 * séparé), `think: 'high'`, num_ctx élargi à 16384 (un fichier HTML complet dépasse largement 4096 tokens).
 * Même repli "sans think" que chat()/chatOnce() ci-dessus si le premier essai échoue.
 */
async function chatCodeOnce(model, prompt, withThink) {
  const start = performance.now()
  const body = {
    model,
    messages: [
      { role: 'system', content: CODE_GENERATE_SYSTEM_PROMPT },
      { role: 'user', content: `Application à créer : ${prompt}` }
    ],
    stream: false,
    options: { num_ctx: 16384 }
  }
  if (withThink) body.think = 'high'

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const wallMs = performance.now() - start
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return { wallMs, data: await res.json() }
}

async function chatCode(model, prompt) {
  let wallMs, data
  try {
    ;({ wallMs, data } = await chatCodeOnce(model, prompt, true))
  } catch (firstErr) {
    try {
      ;({ wallMs, data } = await chatCodeOnce(model, prompt, false))
    } catch {
      throw firstErr
    }
  }
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  return {
    wallMs,
    tokPerSec: evalDurationS > 0 ? evalCount / evalDurationS : null,
    content: data.message?.content?.trim() ?? ''
  }
}

function fmt(n, digits = 1) {
  return n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits)
}

async function main() {
  console.log(`Ollama : ${OLLAMA_HOST}\n`)

  // budgetGb n'est JAMAIS null/illimité, quelle que soit la machine : detectVramGb() ne détecte que les
  // cartes NVIDIA (nvidia-smi) — une machine sans NVIDIA (carte AMD/Intel, GPU intégré, portable sans GPU
  // dédié) est donc TOUJOURS vramGb === null ici. Sans repli, ça désactivait purement et simplement le
  // filtre de taille pour tout le monde dans ce cas — un modèle de 24+ Go aurait été téléchargé en entier
  // sans aucune vérification. Le repli sur la RAM seule couvre ce cas : au pire (vraiment aucun GPU), le
  // modèle tournera de toute façon sur CPU/RAM, donc c'est la bonne limite à vérifier.
  const vramGb = await detectVramGb()
  const ramGb = detectRamGb()
  // Marge différente selon le cas : VRAM_SAFETY_MARGIN_GB (1 Go) suffit pour du contexte/overhead pilote
  // sur une vraie carte GPU, mais le repli "pas de GPU, tout sur RAM/CPU" doit réserver bien plus pour l'OS
  // et les autres logiciels — RAM_SAFETY_MARGIN_GB (8 Go), la même marge que pour RAM_OFFLOAD_MODELS.
  const vramBudgetGb =
    vramGb !== null ? Math.max(0, vramGb - VRAM_SAFETY_MARGIN_GB) : Math.max(0, ramGb - RAM_SAFETY_MARGIN_GB)
  console.log(
    vramGb !== null
      ? `VRAM détectée : ${vramGb.toFixed(1)} Go (budget de test : ${vramBudgetGb.toFixed(1)} Go, marge de ${VRAM_SAFETY_MARGIN_GB} Go pour le contexte/l'OS) — les modèles trop gros pour cette carte seront sautés automatiquement.\n`
      : `Pas de carte NVIDIA détectée : repli sur la RAM seule comme budget (${ramGb.toFixed(1)} Go détectés, ` +
        `budget de test : ${vramBudgetGb.toFixed(1)} Go) — les modèles trop gros seront sautés automatiquement.\n`
  )

  // Budget pour RAM_OFFLOAD_MODELS : VRAM + RAM combinées (pas juste l'une ou l'autre), puisque ces modèles
  // sont conçus pour tourner à cheval sur les deux — mais toujours borné, pour ne pas télécharger des
  // dizaines de Go sur une machine qui n'a de toute façon ni la VRAM ni la RAM pour les faire tourner.
  const ramOffloadBudgetGb = Math.max(0, (vramGb ?? 0) + ramGb - RAM_SAFETY_MARGIN_GB)
  console.log(
    `RAM détectée : ${ramGb.toFixed(1)} Go — budget combiné VRAM+RAM pour les modèles conçus pour déborder ` +
      `sur la RAM (RAM_OFFLOAD_MODELS) : ${ramOffloadBudgetGb.toFixed(1)} Go.\n`
  )

  let installed
  try {
    installed = await listInstalledModels()
  } catch (err) {
    console.error(`Impossible de joindre Ollama : ${err.message}`)
    process.exit(1)
  }

  // Vérifié une première fois ici pour le pré-filtre/l'estimation ci-dessous, puis RE-vérifié en direct par
  // pullModel() avant chaque téléchargement individuel (voir son commentaire) : contrairement à la VRAM/RAM,
  // l'espace disque diminue au fil du run, un modèle en fin de liste doit voir l'espace VRAIMENT restant.
  const freeDiskGbAtStart = detectFreeDiskGb()
  console.log(
    freeDiskGbAtStart !== null
      ? `Espace disque libre (dossier des modèles Ollama) : ${freeDiskGbAtStart.toFixed(1)} Go (marge de ${DISK_SAFETY_MARGIN_GB} Go) — revérifié avant CHAQUE téléchargement, pas seulement au démarrage.\n`
      : "Espace disque libre : impossible à détecter sur cette plateforme, ce filtre de sécurité est désactivé (seuls VRAM/RAM sont vérifiés).\n"
  )

  console.log(
    SCOPE === 'all'
      ? 'Périmètre : tous les paliers.\n'
      : `Périmètre : palier "${SCOPE}" seulement (##MODEL_SKIPPED## ci-dessus mis à part, les autres paliers ne sont ni téléchargés ni testés ce run-ci — leurs résultats précédents sont conservés tels quels).\n`
  )

  const verifiedTotal = VERIFIED_MODELS.conversation.size + VERIFIED_MODELS.vision.size + VERIFIED_MODELS.code.size
  if (verifiedTotal) {
    console.log(
      `${verifiedTotal} modèle(s) déjà vérifié(s) (verified-tool-scores.md — ${VERIFIED_MODELS.conversation.size} conversation, ` +
        `${VERIFIED_MODELS.vision.size} vision, ${VERIFIED_MODELS.code.size} code) : ni téléchargés ni testés ce run-ci, leur vitesse est estimée par formule côté app.\n`
    )
  }

  // Résultats déjà écrits (run précédent, ou sauvegarde incrémentale de CE run avant une interruption — voir
  // persistResults plus bas) : lus ICI, avant de savoir quoi installer/tester, pour pouvoir sauter les
  // modèles déjà faits quand JARIS_RESUME=1 (voir son commentaire plus haut). Même format de parsing que
  // parseLocalBenchmark (hardwareScan.ts) : lignes "| modèle | latence | vitesse | fiabilité |", 4 cellules.
  const existingRows = new Map()
  try {
    const previous = readFileSync(RESULTS_PATH, 'utf-8')
    for (const line of previous.split('\n')) {
      if (!line.startsWith('|') || line.includes('---') || line.includes('Modèle')) continue
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      if (cells.length !== 4) continue
      const [model, latency, speed, reliability] = cells
      existingRows.set(model, { latency, speed, reliability })
    }
  } catch {
    // Pas de fichier précédent (tout premier run) : rien à conserver, existingRows reste vide.
  }
  const alreadyDone = (model) => RESUME && existingRows.has(model)

  // SCOPED_MODELS/SCOPED_VISION_CANDIDATES/SCOPED_CODE_CANDIDATES (pas MODELS/VISION_CANDIDATES/
  // CODE_CANDIDATES directement) : un run ciblé sur un seul palier (SCOPE) ne doit installer/tester QUE ses
  // propres candidats, jamais les autres — la barre de progression (OptionsMenu.tsx) n'a pas besoin de les
  // distinguer, seulement combien reste à installer au total pour CE run.
  const allInstallable = [
    ...SCOPED_MODELS,
    ...SCOPED_VISION_CANDIDATES.map((c) => c.model),
    ...SCOPED_CODE_CANDIDATES.map((c) => c.model)
  ].filter((m) => !alreadyDone(m))
  if (RESUME && existingRows.size) {
    const resumedCount = [
      ...SCOPED_MODELS,
      ...SCOPED_VISION_CANDIDATES.map((c) => c.model),
      ...SCOPED_CODE_CANDIDATES.map((c) => c.model)
    ].filter((m) => alreadyDone(m)).length
    if (resumedCount) {
      console.log(
        `Reprise (JARIS_RESUME=1) : ${resumedCount} modèle(s) du périmètre déjà présent(s) dans ${RESULTS_PATH}, ni retéléchargé(s) ni retesté(s).\n`
      )
    }
  }
  const missingAll = allInstallable.filter((m) => !installed.includes(m))

  // Repli budgétaire pour chaque modèle manquant : VRAM+RAM combinées (RAM_OFFLOAD_MODELS) ou VRAM/RAM seule
  // sinon, ET l'espace disque libre — deux contraintes INDÉPENDANTES (un modèle peut tenir en RAM une fois
  // chargé tout en étant impossible à télécharger faute de place sur le disque, et inversement) : le plus
  // petit des deux budgets gagne.
  const budgetFor = (model) => {
    const memBudget = RAM_OFFLOAD_MODELS.has(model) ? ramOffloadBudgetGb : vramBudgetGb
    const diskBudget = freeDiskGbAtStart !== null ? Math.max(0, freeDiskGbAtStart - DISK_SAFETY_MARGIN_GB) : Infinity
    return Math.min(memBudget, diskBudget)
  }

  // Écarte ICI, avant même de commencer, tout modèle dont on sait déjà (via MODEL_WEIGHT_GB, vérifié plus
  // haut) qu'il ne rentre pas dans le budget de CETTE machine — plutôt que de le laisser dans `missing` et
  // le voir échouer une fois le téléchargement lancé (ModelTooLargeError/DiskFullError, voir pullModel).
  // Deux raisons : 1) évite un aller-retour réseau inutile pour un modèle qu'on sait déjà trop gros ; 2) et
  // surtout, le total pondéré ci-dessous ne doit compter QUE ce que cette machine peut réellement
  // télécharger — sinon une machine "faible" qui ne peut tester que 3-4 modèles se retrouvait avec un total
  // gonflé par le poids de modèles jamais réellement téléchargés, ce qui faussait l'estimation de temps
  // restant. La vérification RÉELLE (manifeste Ollama + espace disque relu en direct, dans pullModel) reste
  // le seul filet de sécurité : ce pré-filtre n'est qu'une estimation pour ne pas tenter l'impossible,
  // jamais un remplacement du vrai contrôle.
  const missing = missingAll.filter((m) => modelWeightGb(m) <= budgetFor(m))
  const tooLargeUpfront = missingAll.filter((m) => modelWeightGb(m) > budgetFor(m))
  if (tooLargeUpfront.length) {
    console.log(`${tooLargeUpfront.length} modèle(s) ignoré(s) d'emblée (trop gros pour cette machine) :`)
    for (const m of tooLargeUpfront) {
      console.log(`  ${m} ignoré : ~${modelWeightGb(m).toFixed(1)} Go estimés, au-delà des ${budgetFor(m).toFixed(1)} Go disponibles`)
      // Lu par le tableau de suivi en direct (OptionsMenu.tsx) : ce modèle ne sera jamais testé ce run-ci.
      console.log(`##MODEL_SKIPPED## ${m}`)
    }
    console.log('')
  }

  const toRun = SCOPED_MODELS.filter((m) => !alreadyDone(m) && (installed.includes(m) || missing.includes(m)))
  const visionToRun = SCOPED_VISION_CANDIDATES.map((c) => c.model).filter(
    (m) => !alreadyDone(m) && (installed.includes(m) || missing.includes(m))
  )
  const codeToRun = SCOPED_CODE_CANDIDATES.map((c) => c.model).filter(
    (m) => !alreadyDone(m) && (installed.includes(m) || missing.includes(m))
  )
  if (!toRun.length && !visionToRun.length && !codeToRun.length) {
    console.log('Aucun des modèles à tester n\'a pu être installé.')
    return
  }

  // Poids total de TOUT le travail de cette analyse (Go à télécharger + poids de test, même unité que
  // MODEL_WEIGHT_GB), un seul total désormais — pas "phase 1 puis phase 2" : téléchargement et test tournent
  // maintenant EN MÊME TEMPS (voir pullConcurrencyFor), il n'y a plus de frontière nette entre les deux à
  // afficher séparément. Toujours pondéré par la vraie taille de chaque modèle (pas un simple compte) : un
  // modèle de 24 Go pèse 24x plus dans ce total qu'un modèle de 1 Go, aussi bien à télécharger qu'à tester
  // (plus lent à chaque réponse) — voir le commentaire de MODEL_WEIGHT_GB.
  const testWeightOf = (model) => modelWeightGb(model)
  const totalPullWeight = missing.reduce((sum, m) => sum + modelWeightGb(m), 0)
  const totalTestWeight =
    toRun.reduce((sum, m) => sum + testWeightOf(m) * TEST_CASES.length, 0) +
    visionToRun.reduce((sum, m) => sum + testWeightOf(m) * VISION_TEST_CASES.length, 0) +
    codeToRun.reduce((sum, m) => sum + testWeightOf(m) * CODE_TEST_CASES.length, 0)
  const totalWeight = totalPullWeight + totalTestWeight || 1
  let weightDone = 0
  const emitProgress = () => console.log(`##PROGRESS## ${weightDone.toFixed(2)} ${totalWeight.toFixed(2)}`)
  emitProgress()

  // Espace disque SERRÉ pour ce run : pas assez de marge pour garder TOUT ce qui va être téléchargé installé
  // en même temps jusqu'à la toute fin (le fonctionnement habituel, le plus simple — voir cleanupUnselectedModels
  // dans benchmarkRunner.ts, qui fait le ménage une fois le gagnant de chaque palier connu). Dans ce cas,
  // deux ajustements : téléchargements strictement l'un après l'autre (pas 2 à la fois, pour ne jamais avoir
  // 2 gros modèles "en trop" sur le disque en même temps) et suppression immédiate d'un modèle DÈS qu'on sait
  // avec certitude qu'il a perdu (voir singleTierOf/considerPruning plus bas) — plutôt que d'attendre la fin
  // du run pendant laquelle TOUS les modèles testés jusqu'ici restent installés simultanément. `null` (espace
  // disque non détectable) retombe sur le comportement généreux habituel : impossible de juger la marge sans
  // pouvoir la mesurer.
  const tightDiskMode = freeDiskGbAtStart !== null && freeDiskGbAtStart - DISK_SAFETY_MARGIN_GB < totalPullWeight
  const effectiveConcurrency = tightDiskMode ? 1 : pullConcurrencyFor(ramGb)
  if (tightDiskMode) {
    console.log(
      `Espace disque limité (${(freeDiskGbAtStart - DISK_SAFETY_MARGIN_GB).toFixed(1)} Go de marge pour ${totalPullWeight.toFixed(1)} Go à télécharger) : téléchargement d'un seul modèle à la fois, et suppression immédiate des candidats déjà dépassés par un meilleur (au lieu d'attendre la fin du run).\n`
    )
  }

  // Ne JAMAIS supprimer, même en mode disque serré, un modèle que l'utilisateur avait DÉJÀ installé avant ce
  // run (`installed` n'est plus modifié après cette capture initiale, voir plus haut) — seuls les modèles que
  // CE run a lui-même téléchargés sont candidats à une suppression anticipée.
  const initiallyInstalledSet = new Set(installed)

  // Suivi du "champion" actuel de chaque palier (flash/medium/large/vision), UNIQUEMENT pour les modèles
  // qui n'appartiennent qu'à UN SEUL palier (singleTierOf/PRUNABLE_VISION_MODELS) : dans ce cas précis, dès
  // que son propre test est fini, on sait avec certitude s'il peut être supprimé sans risquer de priver un
  // AUTRE palier qui en aurait encore besoin plus tard. Comparaison identique à pickBestFrom
  // (hardwareScan.ts) : score d'outils/fiabilité d'abord, vitesse en départage.
  const champion = { flash: null, medium: null, large: null, vision: null }
  const championResult = { flash: null, medium: null, large: null, vision: null }
  const isBetter = (a, b) => (a.toolScore !== b.toolScore ? a.toolScore > b.toolScore : (a.tokPerSec ?? 0) > (b.tokPerSec ?? 0))

  async function deleteNowPruned(model) {
    try {
      await deleteModelViaApi(model)
      console.log(`  ${model} : supprimé immédiatement (dépassé par un meilleur candidat, espace disque limité)`)
    } catch (err) {
      console.log(`  ${model} : échec de la suppression anticipée (${err.message}), ignoré`)
    }
  }

  async function considerPruning(tier, model, result) {
    if (!tightDiskMode || initiallyInstalledSet.has(model)) return
    if (champion[tier] === null || isBetter(result, championResult[tier])) {
      const dethroned = champion[tier]
      champion[tier] = model
      championResult[tier] = result
      if (dethroned) await deleteNowPruned(dethroned)
    } else {
      await deleteNowPruned(model)
    }
  }

  // File de téléchargement en tâche de fond, effectiveConcurrency modèles à la fois : dès que main() atteint
  // ce point, les téléchargements manquants démarrent pendant que les boucles de test plus bas commencent déjà
  // sur les modèles DÉJÀ installés — au lieu d'attendre que tout soit téléchargé avant de tester quoi que ce
  // soit (l'ancien fonctionnement, qui laissait le réseau inactif pendant les tests et le GPU inactif pendant
  // les téléchargements).
  const diskCtx = { reservedGb: 0 }
  const pullOutcomes = new Map() // model -> Promise<boolean> (true = installé avec succès, prêt à tester)
  let pullCursor = 0
  let pullsDone = 0

  async function runOnePull(model) {
    const weight = modelWeightGb(model)
    console.log(`##PULL_MODEL_PROGRESS## ${model} 0`)
    let ok = true
    try {
      await pullModel(model, budgetFor(model), diskCtx, (bucket) => {
        // Crédit PARTIEL en cours de téléchargement (pas juste à la fin) : sans ça, un seul gros modèle en
        // téléchargement ferait stagner la barre globale plusieurs minutes malgré une vraie progression.
        console.log(`##PROGRESS## ${(weightDone + (weight * bucket) / 100).toFixed(2)} ${totalWeight.toFixed(2)}`)
      })
    } catch (err) {
      ok = false
      if (err instanceof ModelTooLargeError || err instanceof DiskFullError) {
        console.log(`  ${model} ignoré : ${err.message}`)
      } else {
        console.log(`  Échec de l'installation de ${model} : ${err.message} (ignoré pour ce run)`)
      }
    }
    weightDone += weight
    pullsDone++
    // "N/M modèles téléchargés" reste utile en lecture humaine à côté de la barre pondérée (OptionsMenu.tsx).
    console.log(`##PULL_PROGRESS## ${pullsDone} ${missing.length}`)
    emitProgress()
    return ok
  }

  async function pullWorker() {
    while (pullCursor < missing.length) {
      const model = missing[pullCursor++]
      // Peut déjà avoir été pris en charge par le filet de secours d'ensureReady ci-dessous (si une boucle
      // de test a rattrapé la file, ex: plusieurs modèles déjà installés testés très vite d'affilée) : ne
      // JAMAIS relancer un second téléchargement pour le même modèle.
      if (pullOutcomes.has(model)) continue
      const promise = runOnePull(model)
      pullOutcomes.set(model, promise)
      await promise
    }
  }

  const pullWorkers = missing.length ? Array.from({ length: Math.min(effectiveConcurrency, missing.length) }, () => pullWorker()) : []
  if (missing.length) {
    console.log(
      `${missing.length} modèle(s) manquant(s) à installer (jusqu'à ${effectiveConcurrency} en parallèle, en tâche de fond pendant les tests) :\n`
    )
  }

  /** Attend qu'un modèle soit prêt à être testé (déjà installé, ou en cours/à faire dans la file de pull). */
  async function ensureReady(model) {
    if (installed.includes(model)) return true
    if (!pullOutcomes.has(model)) {
      // Filet de secours : ne devrait arriver que si une boucle de test rattrape la file de téléchargement
      // (plusieurs modèles déjà installés testés très vite, pendant que les 2 workers sont encore sur les
      // tout premiers éléments de `missing`) — télécharge directement plutôt que d'attendre une file qui n'a
      // pas encore atteint ce modèle.
      pullOutcomes.set(model, runOnePull(model))
    }
    return pullOutcomes.get(model)
  }

  const results = []
  const reasoningAnswers = []
  const errors = []
  let testsDone = 0
  const testsTotal =
    toRun.length * TEST_CASES.length + visionToRun.length * VISION_TEST_CASES.length + codeToRun.length * CODE_TEST_CASES.length
  // Remonté avant les boucles de test (pas défini seulement à l'écriture des résultats comme avant) :
  // considerPruning en a besoin pendant le run, pas seulement à la toute fin.
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

  /**
   * Écrit RESULTS_PATH avec l'état ACTUEL de `results` — appelée après CHAQUE modèle terminé (##MODEL_DONE##
   * plus bas), pas seulement une fois tout le run fini comme avant : un run qui s'interrompt en cours (PC
   * éteint, process tué) ne perd plus que le modèle en cours de test, jamais les modèles déjà terminés. Ce
   * fichier réécrit à chaque fois est justement ce que JARIS_RESUME=1 relit ensuite pour sauter ce qui est
   * déjà fait (voir son commentaire plus haut) — la reprise dépend directement de cette sauvegarde
   * incrémentale, sans elle il n'y aurait rien de plus récent que le tout dernier run complet à reprendre.
   */
  function persistResults() {
    const testedThisRun = new Set(results.map((r) => r.model))
    const lines = []
    lines.push(`# Résultats du benchmark Jaris — ${new Date().toLocaleString('fr-FR')}`)
    lines.push('')
    // "Fiabilité" plutôt que "Tool-calling" : ce tableau mélange trois épreuves différentes selon le
    // palier — appel d'outils (conversation, TEST_CASES), compréhension d'image (vision, VISION_TEST_CASES)
    // et génération de HTML valide (code, CODE_TEST_CASES). La colonne reste un score "X/Y" dans les trois
    // cas, mais ce n'est jamais la même épreuve.
    lines.push('| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité (épreuve selon le palier du modèle) |')
    lines.push('|---|---|---|---|')
    for (const r of results) {
      const acc = r.total ? `${r.correct}/${r.total}` : '—'
      lines.push(`| ${r.model} | ${fmt(avg(r.latencies), 0)} ms | ${fmt(avg(r.speeds))} tok/s | ${acc} |`)
    }
    for (const [model, row] of existingRows) {
      if (testedThisRun.has(model)) continue
      lines.push(`| ${model} | ${row.latency} | ${row.speed} | ${row.reliability} |`)
    }

    lines.push('')
    lines.push('## Réponses aux questions de raisonnement (à juger toi-même)')
    lines.push('')
    for (const { prompt, answer, model } of reasoningAnswers) {
      lines.push(`**${model}** — « ${prompt} »`)
      lines.push(`> ${answer}`)
      lines.push('')
    }

    if (errors.length) {
      lines.push('## Erreurs')
      lines.push('')
      for (const { model, prompt, message } of errors) {
        lines.push(`- **${model}** sur « ${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''} » : ${message}`)
      }
      lines.push('')
    }

    // Écrit aussi le rapport dans un fichier : plus simple à envoyer/coller ailleurs qu'à faire défiler et
    // copier depuis le terminal, surtout avec autant de modèles testés d'affilée.
    writeFileSync(RESULTS_PATH, lines.join('\n'), 'utf-8')
    return lines.join('\n')
  }

  for (const model of toRun) {
    const ready = await ensureReady(model)
    if (!ready) {
      console.log(`##MODEL_SKIPPED## ${model}`)
      continue
    }
    console.log(`\n=== ${model} ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    const perModel = { model, latencies: [], speeds: [], correct: 0, total: 0 }

    for (const { prompt, expectedTool } of TEST_CASES) {
      process.stdout.write(`  "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      try {
        const r = await chat(model, prompt)
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)

        if (expectedTool) {
          perModel.total++
          const ok = r.toolName === expectedTool
          if (ok) perModel.correct++
          console.log(`${ok ? 'OK' : 'RATÉ'} (attendu: ${expectedTool}, obtenu: ${r.toolName ?? 'aucun outil'}) — ${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s`)
        } else {
          console.log(`${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s${r.toolName ? ` (outil inattendu: ${r.toolName})` : ''}`)
          reasoningAnswers.push({ model, prompt, answer: r.content || `[outil appelé au lieu de répondre: ${r.toolName}]` })
        }
      } catch (err) {
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model)
      emitProgress()
    }

    results.push(perModel)
    // Lu par le tableau de suivi en direct (OptionsMenu.tsx) : ce modèle a fini tous ses tests, avec ce score.
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()

    // Espace disque serré uniquement : ce modèle vient de finir son test, et n'appartient qu'à UN SEUL
    // palier (ni multi-palier, ni candidat vision) — on sait donc déjà, avec certitude, s'il faut le garder.
    const tier = singleTierOf(model)
    if (tier) await considerPruning(tier, model, { toolScore: perModel.correct, tokPerSec: avg(perModel.speeds) })
  }

  // Modèles Vision : les images de VISION_TEST_CASES sont générées une seule fois ici (pas à chaque appel
  // modèle), le PNG encodé ne dépend que du test, pas du modèle qui le reçoit.
  const visionImages = VISION_TEST_CASES.map((c) => c.image())

  for (const model of visionToRun) {
    const readyVision = await ensureReady(model)
    if (!readyVision) {
      console.log(`##MODEL_SKIPPED## ${model}`)
      continue
    }
    console.log(`\n=== ${model} (vision) ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    const perModel = { model, latencies: [], speeds: [], correct: 0, total: 0 }

    for (let i = 0; i < VISION_TEST_CASES.length; i++) {
      const { prompt, check } = VISION_TEST_CASES[i]
      process.stdout.write(`  "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      try {
        const r = await chatVision(model, prompt, visionImages[i])
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)
        perModel.total++
        const ok = check(r.content.toLowerCase())
        if (ok) perModel.correct++
        console.log(`${ok ? 'OK' : 'RATÉ'} (réponse: "${r.content.slice(0, 60)}") — ${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s`)
      } catch (err) {
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model)
      emitProgress()
    }

    results.push(perModel)
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()

    // Le palier vision, comme le texte ci-dessus : seulement pour les 4 candidats vision "purs" (jamais
    // qwen3.5:4b/gemma4:e4b, aussi candidats médium — voir PRUNABLE_VISION_MODELS), et seulement si l'espace
    // disque est serré.
    if (PRUNABLE_VISION_MODELS.has(model)) {
      await considerPruning('vision', model, { toolScore: perModel.correct, tokPerSec: avg(perModel.speeds) })
    }
  }

  // Modèles Code : une seule passe de génération par cas (pas de critique/réparation, voir la note sur
  // CODE_TEST_CASES) — "correct" = extraction HTML réussie ET validateGeneratedHtml ne trouve aucun problème.
  for (const model of codeToRun) {
    const readyCode = await ensureReady(model)
    if (!readyCode) {
      console.log(`##MODEL_SKIPPED## ${model}`)
      continue
    }
    console.log(`\n=== ${model} (code) ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    const perModel = { model, latencies: [], speeds: [], correct: 0, total: 0 }

    for (const prompt of CODE_TEST_CASES) {
      process.stdout.write(`  "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      try {
        const r = await chatCode(model, prompt)
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)
        perModel.total++

        const html = extractHtml(r.content)
        const issues = html ? validateGeneratedHtml(html) : ['pas de code HTML exploitable dans la réponse']
        const ok = issues.length === 0
        if (ok) perModel.correct++
        console.log(
          `${ok ? 'OK' : 'RATÉ'} (${issues.length} problème(s)${issues.length ? ' : ' + issues[0] : ''}) — ${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s`
        )
      } catch (err) {
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model)
      emitProgress()
    }

    results.push(perModel)
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()
  }

  // Sécurité : s'assurer qu'aucun téléchargement en tâche de fond ne reste en vol avant d'écrire les
  // résultats — ne devrait normalement plus rien avoir à faire ici, chaque modèle de `missing` étant déjà
  // passé par ensureReady dans l'une des trois boucles ci-dessus (même ordre que `missing`, voir plus haut).
  await Promise.all(pullWorkers)

  // `existingRows` (lu au tout début de main(), voir plus haut) reste la bonne base ici : les modèles testés
  // par un palier différent de SCOPE, ou déjà repris via JARIS_RESUME, y sont toujours — persistResults() les
  // garde tels quels (voir testedThisRun dans sa propre définition). Dernier appel du run, mais chaque modèle
  // a déjà été persisté individuellement au fil des boucles ci-dessus (voir persistResults()).
  const report = persistResults()
  console.log(`\n\n${report}`)
  console.log(`\n(Résultats aussi sauvegardés dans ${RESULTS_PATH})`)
}

main()
