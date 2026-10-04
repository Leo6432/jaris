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
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { createHash } from 'crypto'
import { appendFileSync, readFileSync, statfsSync, writeFileSync } from 'fs'
import { arch, cpus, homedir, release, totalmem } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promisify } from 'util'
import {
  CONVERSATION_NUM_CTX,
  CONVERSATION_REPEATS,
  CONVERSATION_TEST_VERSION,
  CONVERSATION_TOTAL,
  TEST_CASES,
  TOOLS,
  buildCaseMessages,
  isCorrectAnswer
} from './benchmark-cases.mjs'
import {
  PILOT_SYSTEM_PROMPT,
  VISION_PILOT_CASES,
  VISION_REPEATS,
  VISION_TEST_CASES,
  VISION_TEST_VERSION,
  VISION_TOTAL,
  buildPilotPrompt,
  isCorrectVisionAnswer,
  judgePilotStep,
  loadPilotTargets,
  loadVisionImage
} from './benchmark-vision.mjs'
import { CODE_TEST_CASES, CODE_TEST_VERSION, CODE_TOTAL, PREVIEW_CSP_FOR_TEST, checkGeneratedApp } from './benchmark-code.mjs'
import { findBrowser, openBrowser } from './benchmark-browser.mjs'
import {
  REPEATED_SCENARIOS,
  SCENARIOS,
  SCENARIO_NOW,
  SCENARIO_RUNS,
  SCENARIO_TEST_VERSION,
  SCENARIO_TOTAL,
  demandSuccessRate,
  runScenario,
  scenarioSeed
} from './benchmark-scenarios.mjs'

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))
/**
 * Où écrire les résultats : à côté du script, sauf si JARIS_RESULTS_PATH en donne un autre (utilisé par les
 * tests). Depuis l'étape 166, le script n'est plus lancé par Jaris : c'est un outil de développement, dont on
 * recopie les résultats à la main dans verified-tool-scores.md.
 */
const RESULTS_PATH = process.env.JARIS_RESULTS_PATH?.trim() || join(__dirname, 'benchmark-results.md')

/**
 * Tout retester (étape 162, Léo : « on refait l'analyse de tout ») : ignore verified-tool-scores.md, dont les
 * scores viennent de l'ANCIEN test (6 questions, consignes simplifiées) — sans ça, les modèles déjà notés ne
 * seraient jamais repassés au nouveau test et les scores ne seraient pas comparables entre eux.
 */
const RETEST_ALL = process.env.JARIS_RETEST_ALL === '1'

/**
 * Étape 233 (relecture du protocole par ChatGPT) : tout ce qui NE PEUT PAS se reconstruire après coup, dans un
 * fichier à côté des résultats, une ligne JSON par événement, ajoutée au fil de l'eau (une coupure ne perd rien
 * de ce qui est déjà écrit) : requêtes exactes (historique envoyé, réglages, réflexion demandée), réponses brutes
 * d'Ollama (réflexion, appels, compteurs de tokens, durées de chargement et de génération), état du PC simulé,
 * graines, configuration complète de chaque modèle (/api/show) et sa répartition carte graphique / processeur
 * (/api/ps), empreinte du code du test. Changer le barème ou comprendre une lenteur se fait ensuite sans
 * relancer des jours de test ; changer le prompt ou la boucle, non — d'où ce soin avant le lancement.
 */
const TRACES_PATH = `${RESULTS_PATH.replace(/\.md$/i, '')}.traces.jsonl`

function trace(event) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  for (let attempt = 1; ; attempt++) {
    try {
      appendFileSync(TRACES_PATH, line, 'utf-8')
      return
    } catch (err) {
      // Un antivirus peut verrouiller le fichier un instant : on réessaie, puis on s'arrête plutôt que de
      // continuer des heures sans garder les données (la reprise repartira du dernier modèle terminé).
      if (attempt >= 5) throw new Error(`Impossible d'écrire les traces du test dans ${TRACES_PATH} (${err.message}).`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
}

const writtenTexts = new Set()
/** Un long texte répété (consignes, modèle de prompt d'Ollama) : écrit UNE fois, puis désigné par son empreinte. */
function textRef(text) {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  if (!writtenTexts.has(hash)) {
    writtenTexts.add(hash)
    trace({ type: 'texte', hash, text })
  }
  return hash
}

/** Le message système d'une requête remplacé par l'empreinte de son texte (écrit une fois dans les traces). */
const compactMessages = (messages) => messages?.map((m) => (m.role === 'system' ? { role: 'system', ref: textRef(m.content) } : m))

/** Ce qu'Ollama renvoie à côté du message : done_reason, tokens, durées (chargement, lecture, génération). */
/**
 * Répétition générale du 04/10/2026 (qwen3-vl:2b) : malgré `think: false`, le modèle a réfléchi jusqu'à remplir sa
 * fenêtre de contexte (8 192 tokens, 30 min sur processeur), puis n'a rien répondu. Le verdict « réponse vide » était
 * juste, mais ne disait pas POURQUOI — les questions et les demandes, elles, le disaient déjà. Vision et code aussi.
 */
function cutNote(data) {
  if (data?.done_reason !== 'length') return ''
  return ` — réponse coupée : fenêtre de contexte pleine (${(data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)} tokens, réflexion comprise)`
}

function ollamaMeta(data) {
  const { message: _message, ...meta } = data ?? {}
  return meta
}
// JARIS_VERIFIED_SCORES_PATH : seulement pour les tests (un faux fichier de scores vérifiés, étape 230).
const VERIFIED_TOOL_SCORES_PATH = process.env.JARIS_VERIFIED_SCORES_PATH?.trim() || join(__dirname, 'verified-tool-scores.md')

const OLLAMA_HOST = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434'

/**
 * Modèles déjà vérifiés une fois par Léo (voir verified-tool-scores.md, commité dans le dépôt — valable
 * pour tout le monde, cette fiabilité ne dépend pas du matériel, contrairement à la vitesse). Exclus du
 * téléchargement/test de CE script (voir SCOPED_MODELS/SCOPED_VISION_CANDIDATES/SCOPED_CODE_CANDIDATES plus
 * bas) : aucune raison de retélécharger et retester un modèle dont le résultat ne peut pas changer d'une
 * machine à l'autre. Sa vitesse n'est plus estimée par formule depuis la v0.15.42 : l'app affiche celle
 * publiée par Artificial Analysis (voir ARTIFICIAL_ANALYSIS_SPEED, hardwareScan.ts). Trois listes
 * séparées par palier (sections "## Conversation/Vision/Code" du fichier), PAS une seule liste par nom de
 * modèle : `qwen3.5:4b` (et `gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — un score
 * conversation ne doit jamais faire sauter, à tort, son propre test vision (bug déjà rencontré une fois
 * avec benchmark-results.md avant qu'on ne le corrige ici, voir parseVerifiedToolScores dans hardwareScan.ts
 * qui applique la même correction côté app).
 */
function readVerifiedModels() {
  const result = { conversation: new Set(), vision: new Set(), code: new Set(), scenarios: new Set() }
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
      currentTier = tierOfHeading(heading)
      continue
    }
    if (!currentTier || !line.startsWith('|') || line.includes('---') || line.includes('Modèle')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length !== 2) continue
    // Étape 232 : un score de demandes complètes, ou de code, d'une autre version du test est refait.
    if (currentTier === 'scenarios' && !cells[1].endsWith(`/${SCENARIO_TOTAL}`)) continue
    if (currentTier === 'code' && !cells[1].endsWith(`/${CODE_TOTAL}`)) continue
    // Étape 230 : un score de conversation d'un AUTRE test (ex. « 16/17 » de la version 4) ne dispense pas du test
    // actuel — le modèle est retesté, pour que tous les scores de conversation soient comparables entre eux.
    if (currentTier === 'conversation' && !cells[1].endsWith(`/${CONVERSATION_TOTAL}`)) continue
    // Même chose pour la vision : l'ancien test (3 questions, une seule fois) est refait.
    if (currentTier === 'vision' && !cells[1].endsWith(`/${VISION_TOTAL}`)) continue
    result[currentTier].add(cells[0])
  }
  return result
}
// VERIFIED_MODELS : défini plus bas, après VISION_TOTAL dont il dépend (étape 230).

/** Section d'un fichier de scores ou de résultats : « ## Conversation », « ## Vision », « ## Code », « ## Demandes complètes ». */
function tierOfHeading(heading) {
  if (heading.startsWith('conversation')) return 'conversation'
  if (heading.startsWith('vision')) return 'vision'
  if (heading.startsWith('code')) return 'code'
  if (heading.startsWith('demandes')) return 'scenarios'
  return null
}

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
 * Étape 230 : supprimer chaque modèle téléchargé par CE run dès la fin de son dernier test, même quand le disque
 * a la place de tout garder. Les ~30 modèles de conversation pèsent ~290 Go : sans ça, un re-test complet lancé
 * depuis Jaris les laisserait tous sur le disque. Un modèle déjà installé avant le run n'est jamais supprimé.
 */
const DELETE_AFTER_TEST = process.env.JARIS_DELETE_AFTER_TEST === '1'

/**
 * Étape 168 : bouton « Tester les modèles sans score » (Options → Modèles → Tous les modèles). Jaris transmet
 * la liste exacte des modèles à tester, séparés par des virgules ; tous les autres sont ignorés, dans les trois
 * épreuves. Absente (lancé à la main), rien ne change.
 */
const ONLY_MODELS = new Set(
  (process.env.JARIS_ONLY_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
)
const inOnlyModels = (model) => ONLY_MODELS.size === 0 || ONLY_MODELS.has(model)

/**
 * Petite marge sous la VRAM totale détectée, pour le contexte (num_ctx, 4096 par défaut) et l'overhead
 * OS/pilote pendant le test — même valeur que GPU_RESERVED_GB côté app (electron/services/hardwareScan.ts)
 * depuis l'étape 158 (la transcription tourne en RAM, elle ne prend plus de place sur la carte).
 */
const VRAM_SAFETY_MARGIN_GB = 1

/**
 * Marge sous la RAM totale de la machine, réservée à l'OS et aux autres logiciels ouverts — jamais
 * disponible en entier pour un seul modèle, contrairement à ce qu'un simple `os.totalmem()` suggérerait.
 * 8 -> 16 (étape 119) : voir RESOURCE_SAFETY_MARGIN_GB (electron/services/systemResources.ts), même valeur
 * dupliquée ici volontairement, même raisonnement (un ami de Léo à faible VRAM dédiée s'est retrouvé avec
 * un modèle Puissant tournant presque entièrement sur sa RAM, saturant sa machine entière).
 */
const RAM_SAFETY_MARGIN_GB = Number(process.env.JARIS_RAM_SAFETY_MARGIN_GB) > 0 ? Number(process.env.JARIS_RAM_SAFETY_MARGIN_GB) : 16
// Étape 168 : le bouton « Tester les modèles sans score » passe 12 — un test ponctuel, lancé exprès, pendant
// lequel on ferme le reste (dit dans la confirmation). Avec 16, nemotron-3.5-lightning (25 Go) était sauté
// d'office sur la machine de Léo (8 Go de VRAM + 32 Go de RAM - 16 = 24 Go). L'usage quotidien de Jaris
// garde 16 (RESOURCE_SAFETY_MARGIN_GB), inchangé.

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
 * Les 8 derniers (qwen3.5:35b/27b, qwen3.8:27b, qwen3.6:27b, gemma4:26b, gpt-oss:20b,
 * mistral-small3.2:24b, glm-4.7-flash:q4_K_M) sont les candidats du palier Puissant (LARGE_CANDIDATES dans
 * hardwareScan.ts) au-delà de la VRAM disponible sur une machine comme celle de Léo — ajoutés à la demande
 * explicite de Léo après avoir vu "Puissant" retomber sur un petit modèle faute de place : sur cette machine,
 * réserver 4,5 Go de VRAM en permanence pour le STT (avant l'étape 158, où il est passé en RAM) ne laissait
 * jamais assez de place pour un vrai grand modèle. Certains sont MoE (gemma4:26b, gpt-oss:20b probablement
 * glm-4.7-flash) et restent rapides même en débordant sur la RAM ; les autres sont denses (qwen3.5:35b/27b,
 * qwen3.8:27b, qwen3.6:27b, mistral-small3.2:24b) et seront NETTEMENT plus lents une fois
 * débordés — accepté en connaissance de cause, mieux vaut un vrai grand modèle plus lent qu'un petit modèle
 * rapide pour les questions qui demandent explicitement une réflexion poussée.
 */
const RAM_OFFLOAD_MODELS = new Set([
  'qwen3.6:35b-a3b',
  'qwen3-coder:30b',
  'north-mini-code-1.0',
  'qwen2.5-coder:32b',
  'devstral-small-2:24b',
  // devstral-2:123b (étape 225) et qwen3-coder-next (étape 227) retirés : moins bons qu'un modèle de 8 Go.
  'qwen3.5:35b',
  'qwen3.6:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'granite4.2:30b',
  'gemma4:26b',
  'gpt-oss:20b',
  'mistral-small3.2:24b',
  'glm-4.7-flash:q4_K_M',
  'nemotron-3.5-lightning:30b'
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
  // gemma4:12b et granite4.1:8b : voir MEDIUM_CANDIDATES dans hardwareScan.ts pour le détail de la
  // vérification (tags réels confirmés, "ibm/granite4.1:8b" proposé initialement était un namespace
  // inexistant) et des deux rejets associés (llama3.2:1b, deepseek-r1).
  'gemma4:12b',
  'granite4.1:8b',
  // granite4.2:8b/3b : voir MEDIUM_CANDIDATES dans hardwareScan.ts pour le détail — ajoutés à côté de
  // granite4.1 (pas à sa place), celui-ci ayant un vrai score mesuré à préserver.
  'granite4.2:8b',
  'granite4.2:3b',
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
  // Promu dans FLASH_CANDIDATES/MEDIUM_CANDIDATES (hardwareScan.ts) à l'étape 132 : 6/6 déjà vérifié
  // ci-dessus n'avait jamais été suivi de sa promotion — reste dans cette liste comme tout autre candidat
  // déjà vérifié, sauté au prochain run (voir VERIFIED_MODELS plus bas).
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF',
  // Étape 219 (Léo) : Ling 3.0 Tiny, GGUF OFFICIEL d'inclusionAI (créateur du modèle). Architecture
  // bailingmoe3, chargée par Ollama depuis la 0.33.3 (llama.cpp #26608, fusionnée le 17/08/2026). Voir
  // MEDIUM_CANDIDATES dans hardwareScan.ts.
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M',
  // Étape 226 (Léo) : MiniCPM5-2B, GGUF OFFICIEL d'OpenBMB, architecture llama. Voir FLASH_CANDIDATES dans
  // hardwareScan.ts.
  'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M',
  // Étape 229 (Léo) : Nanbeige4.1-3B (requantification mradermacher, pas de GGUF du créateur) et LFM2.5-2.6B
  // (GGUF officiel de Liquid AI). Voir FLASH_CANDIDATES dans hardwareScan.ts.
  'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M',
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M',
  // Ignorés jusqu'ici car trop gros pour la machine de dev (RTX 3070, 8 Go) : maintenant que le script
  // détecte la VRAM disponible et saute automatiquement ce qui ne rentre pas (voir detectVramGb ci-dessous),
  // les garder dans la liste permet aux utilisateurs avec plus de VRAM de vraiment les tester chez eux —
  // mêmes tailles que LARGE_CANDIDATES dans electron/services/hardwareScan.ts.
  'qwen3.5:35b',
  // Variante dense de qwen3.6 (distincte de qwen3.6:35b-a3b, MoE, plus bas dans les candidats Code) — voir
  // LARGE_CANDIDATES dans hardwareScan.ts pour le détail de la vérification.
  'qwen3.6:35b',
  'qwen3.5:27b',
  // Successeur potentiel de qwen3.5:27b (LARGE_CANDIDATES dans hardwareScan.ts) : même taille de VRAM
  // (18 Go), vision+tools+thinking natifs. Gain rapporté en code/agentic par des sources tierces
  // uniquement — ce run donnera une vraie mesure locale plutôt que de deviner. Source taille :
  // ollama.com/library/qwen3.8 (tag 27b, 18 Go).
  'qwen3.8:27b',
  // Candidats supplémentaires dans la même tranche (14-19 Go), pour les machines avec plus de VRAM que la
  // config de développement — voir le commentaire complet dans hardwareScan.ts (LARGE_CANDIDATES).
  'qwen3.6:27b',
  'granite4.2:30b',
  'gemma4:26b',
  'gpt-oss:20b',
  'mistral-small3.2:24b',
  'glm-4.7-flash:q4_K_M',
  // Étape 167 : voir LARGE_CANDIDATES dans hardwareScan.ts.
  'nemotron-3.5-lightning:30b',
  // ministral-3:8b/14b (MEDIUM_CANDIDATES dans hardwareScan.ts) : ministral-3:3b est déjà ici et déjà
  // vérifié (6/6, verified-tool-scores.md) — ces deux tailles restent à tester pour de vrai, un score pour
  // une taille ne valant pas pour une autre.
  'ministral-3:8b',
  'ministral-3:14b'
  // gemma4:31b retiré de cette liste (étape 230) : il n'est candidat qu'en Vision dans Jaris, et son score de
  // conversation ne sert à aucun rôle. Le bouton de test lui faisait passer les 78 questions de conversation en
  // plus de la vision (un modèle dense de 20 Go, une à deux heures sur une carte de 8 Go) pour rien.
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
  // gemma4:31b (VISION_CANDIDATES dans hardwareScan.ts) : 20 Go, dense, vision native — voir son commentaire
  // complet là-bas pour pourquoi il n'est QUE en Vision (bugs de tool-calling ouverts sur toute la famille
  // Gemma 4, sans impact sur ce rôle).
  { model: 'gemma4:31b', vramGb: 20 },
  // Étape 230 : candidats Vision de Jaris (VISION_CANDIDATES, hardwareScan.ts) jamais recopiés ici, donc jamais
  // testés en vision : le contrôle de synchronisation ne vérifiait que la présence du nom dans le script.
  { model: 'gemma4:26b', vramGb: 19 },
  { model: 'qwen3.8:27b', vramGb: 18 },
  // qwen3.5/gemma4:e4b sont nativement multimodaux (déjà dans MEDIUM_CANDIDATES) : testés ici pour savoir
  // si réutiliser le modèle de conversation déjà chargé tient tête à un modèle vision dédié — voir le
  // commentaire complet dans hardwareScan.ts.
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3-vl:8b', vramGb: 8 },
  { model: 'gemma4:12b', vramGb: 7.6 },
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  // ministral-3:8b (voir MEDIUM_CANDIDATES/VISION_CANDIDATES dans hardwareScan.ts) : nativement multimodal.
  { model: 'ministral-3:8b', vramGb: 6.0 },
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
  // Étape 167 : oublié ici alors que Jaris le connaît (CODE_CANDIDATES de hardwareScan.ts) — jamais testé
  // lors de l'analyse de Léo du 25/09/2026. Test permanent désormais : test-benchmark-candidates-sync.mjs.
  { model: 'qwen2.5-coder:14b', vramGb: 9 },
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
  'gemma4:12b': 7.6,
  'granite4.2:8b': 5.3,
  'granite4.1:8b': 5.3,
  'granite4.2:3b': 2.2,
  'granite4.1:3b': 2.1,
  'nemotron-3-nano:4b': 2.8,
  'ministral-3:3b': 3.0,
  'ministral-3:8b': 6.0,
  'ministral-3:14b': 9.1,
  'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF': 0.73,
  'qwen3:1.7b': 2.0,
  'granite4:1b': 3.3,
  'qwen3.5:0.8b': 1.0,
  'functiongemma:270m': 0.3,
  'hf.co/openbmb/MiniCPM5-1B-GGUF': 0.69,
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF': 1.9,
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M': 4.8,
  'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M': 1.6,
  'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M': 2.4,
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M': 1.7,
  'qwen3.5:35b': 24,
  'qwen3.6:35b': 24,
  'qwen3.5:27b': 17,
  'qwen3.8:27b': 18,
  'qwen3.6:27b': 18,
  'granite4.2:30b': 18,
  'gemma4:26b': 19,
  'gpt-oss:20b': 14,
  'mistral-small3.2:24b': 15,
  'glm-4.7-flash:q4_K_M': 19,
  'nemotron-3.5-lightning:30b': 25
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
const FLASH_TIER_MODELS = new Set(['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'])
const MEDIUM_TIER_MODELS = new Set([
  'gemma4:e4b',
  'ministral-3:14b',
  'gemma4:12b',
  'ministral-3:8b',
  'qwen3.5:9b',
  'granite4.2:8b',
  'granite4.1:8b',
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M',
  'qwen3.5:4b',
  'qwen3.5:2b',
  'granite4.2:3b',
  'granite4.1:3b',
  'qwen3.5:0.8b'
])
const LARGE_TIER_MODELS = new Set([
  'qwen3.5:35b',
  'qwen3.6:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'granite4.2:30b',
  'gemma4:26b',
  'gpt-oss:20b',
  'mistral-small3.2:24b',
  'glm-4.7-flash:q4_K_M',
  'nemotron-3.5-lightning:30b',
  // hardwareScan.ts reprend aussi ces 4 dans LARGE_CANDIDATES comme repli si rien de plus gros ne rentre,
  // ce qui les rend multi-paliers (voir isSafeToPruneEarly ci-dessous) : présents ici pour que
  // FLASH/MEDIUM/LARGE_TIER_MODELS reflètent fidèlement hardwareScan.ts, même si en pratique ça les exclut
  // du nettoyage anticipé.
  'qwen3.5:9b',
  'qwen3.5:4b',
  'qwen3.5:2b',
  'qwen3.5:0.8b'
])

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

async function deleteModelViaApi(model) {
  const res = await fetch(`${OLLAMA_HOST}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model })
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

// TOOLS, les vraies consignes de Jaris et TEST_CASES : voir scripts/benchmark-cases.mjs (étape 162).

// Test de vision : voir scripts/benchmark-vision.mjs (étape 232, vraies captures d'écran).

// Étape 230 : après VISION_TOTAL, que readVerifiedModels utilise (avant, il était lu trop tôt).
const VERIFIED_MODELS = RETEST_ALL ? { conversation: new Set(), vision: new Set(), code: new Set(), scenarios: new Set() } : readVerifiedModels()

const CONVERSATION_SCOPE = (
  SCOPE === 'all' || SCOPE === 'conversation'
    ? MODELS
    : SCOPE === 'flash'
      ? MODELS.filter((m) => FLASH_TIER_MODELS.has(m))
      : SCOPE === 'medium'
        ? MODELS.filter((m) => MEDIUM_TIER_MODELS.has(m))
        : SCOPE === 'large'
          ? MODELS.filter((m) => LARGE_TIER_MODELS.has(m))
          : []
)
const SCOPED_MODELS = CONVERSATION_SCOPE.filter((m) => !VERIFIED_MODELS.conversation.has(m) && inOnlyModels(m))
/**
 * Étape 232 : les mêmes modèles de conversation, pour les demandes complètes (benchmark-scenarios.mjs). Un modèle
 * déjà noté aux 78 questions n'est PAS réinterrogé dessus : seules ses demandes complètes sont jouées.
 */
const SCOPED_SCENARIO_MODELS =
  process.env.JARIS_SKIP_SCENARIOS === '1' // tests du premier appel seulement (scripts/test-benchmark-cases.mjs)
    ? []
    : CONVERSATION_SCOPE.filter((m) => !VERIFIED_MODELS.scenarios.has(m) && inOnlyModels(m))
/** Une demande complète fait en moyenne ~3 appels au modèle : elle pèse 3 questions dans la barre de progression. */
const SCENARIO_WEIGHT = 3
const SCOPED_VISION_CANDIDATES = (SCOPE === 'all' || SCOPE === 'vision' ? VISION_CANDIDATES : []).filter(
  (c) => !VERIFIED_MODELS.vision.has(c.model) && inOnlyModels(c.model)
)
const SCOPED_CODE_CANDIDATES = (SCOPE === 'all' || SCOPE === 'code' ? CODE_CANDIDATES : []).filter(
  (c) => !VERIFIED_MODELS.code.has(c.model) && inOnlyModels(c.model)
)

/** Copie EXACTE de VISION_SYSTEM_PROMPT (electron/services/vision.ts), vérifiée par test-benchmark-cases.mjs. */
const VISION_SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal qui décrit ce qui est affiché à l'écran de l'utilisateur. Réponds en " +
  'français, de façon concise et naturelle comme à l\'oral, sans émojis, astérisques, listes à puces ni ' +
  'mise en forme : ta réponse est lue directement à voix haute.'

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

// Test du palier Code : voir scripts/benchmark-code.mjs (étape 232 — l'application est ouverte et utilisée pour de
// vrai). validateGeneratedHtml ci-dessus reste noté dans le détail, à titre d'information.

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

/** Nom de la carte graphique NVIDIA (pour les traces), `null` sans carte NVIDIA. */
async function detectGpuName() {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name --format=csv,noheader', { windowsHide: true })
    return stdout.trim().split('\n')[0] || null
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
// JARIS_DISK_SAFETY_MARGIN_GB : seulement pour les tests (étape 230), qui ne doivent pas dépendre du disque de la machine.
const DISK_SAFETY_MARGIN_GB = Number(process.env.JARIS_DISK_SAFETY_MARGIN_GB ?? 5)

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
/**
 * Ollama injoignable (arrêté, en train de redémarrer — par exemple pendant une mise à jour automatique) et pas
 * revenu à temps. Étape 164 : la deuxième analyse de Léo notait alors 0/17 à chaque modèle (« fetch failed » sur
 * toutes les questions), et la reprise prenait ces faux 0/17 pour des scores. Désormais l'analyse ATTEND qu'Ollama
 * revienne, et s'arrête proprement s'il ne revient pas : le modèle en cours n'est jamais enregistré.
 */
class OllamaDownError extends Error {}

const OLLAMA_WAIT_MS = Number(process.env.JARIS_OLLAMA_WAIT_MS) || 3 * 60 * 1000
const OLLAMA_POLL_MS = Number(process.env.JARIS_OLLAMA_POLL_MS) || 5000

/**
 * Relecture ChatGPT (v0.28.1) : sans aucun délai, UNE génération bloquée (modèle qui boucle, moteur figé) arrêtait
 * toute la campagne, sans surveillance, pendant des jours. Délai généreux : 20 minutes par appel, quatre fois le
 * plus long jamais mesuré chez Léo (qwen2.5-coder:32b, 4 min 30 pour une application entière) — une réponse plus
 * lente serait de toute façon inutilisable dans Jaris. Un dépassement est un ÉCHEC DU MODÈLE noté à part (« délai
 * dépassé », `timeout: true` dans les traces), jamais confondu avec une panne d'Ollama (vérifiée juste après).
 */
const CALL_TIMEOUT_MS = (Number(process.env.JARIS_CALL_TIMEOUT_MIN) || 20) * 60 * 1000
const CALL_TIMEOUT_LABEL = CALL_TIMEOUT_MS >= 60_000 ? `${Math.round(CALL_TIMEOUT_MS / 60_000)} min` : `${Math.round(CALL_TIMEOUT_MS / 1000)} s`
class CallTimeoutError extends Error {}

/**
 * Trois délais dépassés de suite : le modèle ne répond plus. Ses tests restants dans cette partie sont comptés faux
 * sans être joués — sinon un modèle figé coûterait 20 minutes par test, soit des heures, au lieu d'une.
 */
const MAX_TIMEOUT_STREAK = 3
function timeoutGuard() {
  let streak = 0
  return {
    /** À appeler avant chaque test : lève l'erreur « non joué » si le modèle est considéré figé. */
    check() {
      if (streak >= MAX_TIMEOUT_STREAK) {
        throw Object.assign(new CallTimeoutError(`non joué : le modèle ne répondait plus (${MAX_TIMEOUT_STREAK} délais dépassés de suite)`), { skipped: true })
      }
    },
    passed() {
      streak = 0
    },
    failed(err) {
      if (!(err instanceof CallTimeoutError)) streak = 0
      else if (!err.skipped) streak++
    }
  }
}

/**
 * POST JSON vers Ollama SANS délai maximal. Le `fetch` de Node abandonne une requête après 5 minutes sans en-têtes
 * de réponse (« fetch failed ») ; or, sans streaming, Ollama n'en envoie qu'une fois la réponse entière prête — un
 * gros modèle qui tourne dans la RAM peut réfléchir plus longtemps que ça (qwen2.5-coder:32b : 4 min 30 en
 * moyenne chez Léo). `http.request` n'a aucun délai par défaut. Une erreur de CONNEXION est marquée
 * `ollamaUnreachable`, pour la distinguer d'une vraie réponse d'erreur d'Ollama.
 */
function postJson(path, body, timeoutMs = 0) {
  const url = new URL(path, OLLAMA_HOST)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    let timer = null
    // Le délai coupe la requête : Ollama arrête alors la génération de son côté. `timedOut` la distingue d'une
    // connexion perdue (postChat vérifie ensuite si Ollama, lui, répond encore).
    const fail = (err) => {
      clearTimeout(timer)
      reject(err.timedOut ? err : Object.assign(err, { ollamaUnreachable: true }))
    }
    const req = send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text })
      })
      res.on('error', fail)
    })
    req.on('error', fail)
    if (timeoutMs > 0) timer = setTimeout(() => req.destroy(Object.assign(new Error('délai dépassé'), { timedOut: true })), timeoutMs)
    req.end(JSON.stringify(body))
  })
}

/** Ollama répond-il encore (indépendamment du modèle en cours) ? */
async function ollamaAlive() {
  try {
    return (await fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(15_000) })).ok
  } catch {
    return false
  }
}

/** Vrai si Ollama répond de nouveau dans les OLLAMA_WAIT_MS. */
async function waitForOllama() {
  const deadline = Date.now() + OLLAMA_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`)
      if (res.ok) return true
    } catch {
      // Toujours injoignable.
    }
    await new Promise((resolve) => setTimeout(resolve, OLLAMA_POLL_MS))
  }
  return false
}

/** Une question à Ollama : attend son retour s'il est injoignable, et abandonne l'analyse s'il ne revient pas. */
async function postChat(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await postJson('/api/chat', body, CALL_TIMEOUT_MS)
      if (!res.ok) throw new Error(`${res.status} ${res.text}`)
      return JSON.parse(res.text)
    } catch (err) {
      if (err.timedOut) {
        if (await ollamaAlive()) {
          // Ollama va bien : c'est le modèle. Il est déchargé pour que le test suivant reparte d'un moteur neuf.
          await postJson('/api/generate', { model: body.model, keep_alive: 0 }, 60_000).catch(() => {})
          throw new CallTimeoutError(`délai dépassé : aucune réponse du modèle en ${CALL_TIMEOUT_LABEL}`)
        }
        err.ollamaUnreachable = true
      }
      if (!err.ollamaUnreachable) throw err
      console.log(`\n  Ollama ne répond plus (${err.message}) : attente de son retour…`)
      if (attempt >= 3 || !(await waitForOllama())) {
        throw new OllamaDownError(
          "Ollama ne répond plus : l'analyse s'arrête. Vérifie qu'Ollama tourne, puis relance l'analyse — elle " +
            "reprendra là où elle s'était arrêtée."
        )
      }
    }
  }
}

async function chatOnce(model, testCase, withThink) {
  const start = performance.now()
  const body = {
    model,
    // Étape 230 : consignes (avec notes en mémoire si la question en donne), question, puis ce que Jaris a déjà
    // fait dans ce tour (ex. search_web et son résultat).
    messages: buildCaseMessages(testCase),
    tools: TOOLS,
    stream: false,
    // Étape 163 : sans num_ctx, Ollama prenait 4096 et coupait les vraies consignes de Jaris (~4 600 tokens).
    options: { num_ctx: CONVERSATION_NUM_CTX }
  }
  if (withThink) body.think = 'medium'

  const data = await postChat(body)
  return { wallMs: performance.now() - start, data }
}

async function chat(model, testCase) {
  let wallMs, data
  let think = 'medium'
  try {
    ;({ wallMs, data } = await chatOnce(model, testCase, true))
  } catch (firstErr) {
    // Un délai dépassé n'est pas retenté sans réflexion : ce serait 20 minutes de plus pour le même test.
    if (firstErr instanceof OllamaDownError || firstErr instanceof CallTimeoutError) throw firstErr
    think = false
    try {
      ;({ wallMs, data } = await chatOnce(model, testCase, false))
    } catch (secondErr) {
      // Le premier message est le plus informatif, sauf s'il dit seulement que la réflexion est refusée (étape 232).
      throw THINK_REFUSED.test(firstErr.message) ? secondErr : firstErr
    }
  }
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  const tokPerSec = evalDurationS > 0 ? evalCount / evalDurationS : null
  const toolCalls = data.message?.tool_calls ?? []
  // Étape 163 : une réponse coupée faute de place (fenêtre pleine pendant la réflexion) n'est PAS « aucun outil » —
  // sinon elle passerait pour juste sur les questions où il n'en faut pas. C'est un échec, noté dans les erreurs.
  if (data.done_reason === 'length' && !toolCalls.length) {
    throw new Error(`réponse coupée : fenêtre de contexte pleine (${data.prompt_eval_count ?? '?'} tokens de demande)`)
  }
  return {
    wallMs,
    tokPerSec,
    toolName: toolCalls[0]?.function?.name ?? null,
    toolArgs: toolCalls[0]?.function?.arguments ?? null,
    content: data.message?.content?.trim() ?? '',
    data,
    think
  }
}

/**
 * Étape 232 : un appel de la boucle des demandes complètes. Mêmes réglages que les 78 questions (réflexion
 * « medium », retentée sans réflexion si le modèle la refuse, contexte de Jaris), plus une graine par passage :
 * un passage se rejoue à l'identique, et deux passages ne tirent pas la même réponse au hasard.
 * `thinkModes` note ce qui a vraiment servi, pour le fichier de résultats.
 */
const THINK_REFUSED = /does not support thinking|thinking is not supported/i

async function chatScenario(model, messages, seed, thinkModes) {
  const body = { model, messages, tools: TOOLS, stream: false, options: { num_ctx: CONVERSATION_NUM_CTX, seed } }
  // Un modèle qui a déjà refusé la réflexion n'est plus interrogé avec : une requête de moins par appel.
  if (!thinkModes.has(THINK_OFF)) body.think = 'medium'
  try {
    const data = await postChat(body)
    thinkModes.add(body.think ? 'medium' : THINK_OFF)
    // Ce qui a VRAIMENT été envoyé pour cet appel, noté dans les traces (relecture ChatGPT : « medium » écrit dans
    // un fichier ne prouve pas ce que le modèle a reçu).
    data.jaris_think = body.think ?? false
    return data
  } catch (firstErr) {
    if (firstErr instanceof OllamaDownError || firstErr instanceof CallTimeoutError || !body.think) throw firstErr
    // Comme chatWithOllama (ollama.ts) : une seconde tentative sans réflexion, quelle que soit l'erreur.
    delete body.think
    try {
      const data = await postChat(body)
      thinkModes.add(THINK_REFUSED.test(firstErr.message) ? THINK_OFF : 'sans réflexion après une erreur')
      data.jaris_think = false
      data.jaris_first_error = firstErr.message.slice(0, 300)
      return data
    } catch (secondErr) {
      // Vu le 04/10/2026 (ministral-3:3b) : la réflexion refusée, puis un appel d'outil mal formé refusé par Ollama
      // (500). La vraie raison est la seconde : c'est elle qui doit figurer dans le fichier.
      throw THINK_REFUSED.test(firstErr.message) ? secondErr : firstErr
    }
  }
}
const THINK_OFF = 'désactivée (refusée par le modèle)'

/** Version d'Ollama, écrite avec les résultats : un score appartient à une configuration, pas seulement à un nom. */
let ollamaVersion = 'inconnue'
async function readOllamaVersion() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/version`)
    if (res.ok) return (await res.json()).version ?? 'inconnue'
  } catch {
    // Sans réponse ici, la suite le dira assez tôt.
  }
  return 'inconnue'
}

/**
 * Étape 233 : ce que le modèle annonce de lui-même (/api/show) — réflexion possible et ses niveaux, réglages par
 * défaut (température, top_p, top_k, séquences d'arrêt…), modèle de prompt, taille de contexte native — et son
 * empreinte exacte. Un score appartient à CETTE configuration, pas seulement à un nom.
 */
const snapshots = new Map()
async function modelSnapshot(model) {
  if (snapshots.has(model)) return snapshots.get(model)
  const snapshot = { digest: null, sizeBytes: null, capabilities: null, thinking: null, details: null, parameters: null, template: null, architecture: null, nativeContext: null }
  try {
    const entry = (((await (await fetch(`${OLLAMA_HOST}/api/tags`)).json()).models ?? [])).find((m) => m.name === model || m.name === `${model}:latest`)
    snapshot.digest = entry?.digest ?? null
    snapshot.sizeBytes = entry?.size ?? null
  } catch {
    // Pas bloquant : seule cette information manquera.
  }
  try {
    const res = await postJson('/api/show', { model })
    if (res.ok) {
      const show = JSON.parse(res.text)
      snapshot.capabilities = show.capabilities ?? null
      snapshot.thinking = show.thinking ?? null
      snapshot.details = show.details ?? null
      snapshot.parameters = show.parameters ?? null
      snapshot.template = show.template ? textRef(show.template) : null
      snapshot.architecture = show.model_info?.['general.architecture'] ?? null
      snapshot.nativeContext = snapshot.architecture ? (show.model_info?.[`${snapshot.architecture}.context_length`] ?? null) : null
    }
  } catch {
    // Idem.
  }
  snapshots.set(model, snapshot)
  return snapshot
}

/** Où tourne le modèle une fois chargé (/api/ps) : la part en mémoire de la carte graphique, le reste sur le processeur. */
async function placement(model) {
  try {
    const entry = (((await (await fetch(`${OLLAMA_HOST}/api/ps`)).json()).models ?? [])).find((m) => [m.name, m.model].includes(model) || m.name === `${model}:latest`)
    if (entry) return { sizeBytes: entry.size ?? null, vramBytes: entry.size_vram ?? null, contextLength: entry.context_length ?? null }
  } catch {
    // Pas bloquant.
  }
  return null
}

/** La réflexion telle que le modèle l'annonce : niveaux nommés, avec/sans, ou aucune. */
function describeThinking(snapshot) {
  const values = snapshot.thinking?.values
  if (Array.isArray(values) && values.some((v) => typeof v === 'string')) return `niveaux ${values.filter((v) => typeof v === 'string').join('/')}`
  if (snapshot.capabilities?.includes('thinking')) return 'avec ou sans'
  return snapshot.capabilities ? 'aucune' : 'inconnue'
}

function describePlacement(where) {
  if (!where?.sizeBytes) return 'répartition carte graphique/processeur inconnue'
  const share = Math.round((100 * (where.vramBytes ?? 0)) / where.sizeBytes)
  if (share >= 100) return 'entièrement sur la carte graphique'
  if (share <= 0) return 'entièrement sur le processeur'
  return `${share} % sur la carte graphique, le reste sur le processeur`
}

/**
 * À la fin de chaque épreuve d'un modèle (encore chargé) : sa configuration complète dans les traces, et une ligne
 * lisible pour le fichier de résultats.
 */
async function recordModelConfig(model, phase, extra = {}) {
  const snapshot = await modelSnapshot(model)
  const where = await placement(model)
  trace({ type: 'modèle', model, phase, ...snapshot, placement: where, ...extra })
  return (
    `${snapshot.digest ? `digest ${snapshot.digest.slice(0, 12)}` : 'digest inconnu'}, ${snapshot.details?.quantization_level ?? 'compression inconnue'}, ` +
    `réflexion annoncée par le modèle : ${describeThinking(snapshot)}, ${describePlacement(where)}`
  )
}

/** Empreinte des fichiers du test : identifie exactement le code qui a produit un score. */
function harnessFingerprint() {
  const files = ['benchmark-models.mjs', 'benchmark-cases.mjs', 'benchmark-scenarios.mjs', 'benchmark-vision.mjs', 'benchmark-code.mjs', 'benchmark-browser.mjs']
  return Object.fromEntries(
    files.map((file) => {
      try {
        return [file, createHash('sha256').update(readFileSync(join(__dirname, file))).digest('hex').slice(0, 16)]
      } catch {
        return [file, null]
      }
    })
  )
}

/** Une demande jouée, sur une ligne : chaque tour, ses appels d'outils et la réponse finale. */
function describeRun(run) {
  return run.turns
    .map((turn, index) => {
      const calls = run.calls
        .filter((c) => c.turn === index)
        .map((c) => `${c.name} ${JSON.stringify(c.args)} → « ${oneLine(c.result, 120)} »`)
      const said = turn.error ? `erreur : ${turn.error}` : `« ${oneLine(turn.reply, 300) || 'réponse vide'} »${turn.shortCircuit ? ' (résultat direct de l’outil)' : ''}`
      return `[${index + 1}] « ${turn.user} » ${calls.length ? `⇒ ${calls.join(' ; ')} ` : ''}⇒ ${said}`
    })
    .join(' | ')
}

/** Le navigateur ne démarre plus : le test de code s'arrête (jamais un faux 0 pour tous les modèles de code). */
class BrowserDownError extends Error {}

/** Générer une application entière pèse autant qu'une dizaine de questions dans la barre de progression. */
const CODE_WEIGHT = 10

const BROWSER_PATH = findBrowser()

/**
 * Étape 232 : ouvre l'application dans un navigateur neuf (une application cassée ne peut pas gêner la suivante)
 * et joue sa vérification. `null` = elle marche.
 */
async function checkInBrowser(testCase, html, journal = null) {
  let session
  try {
    session = await openBrowser(BROWSER_PATH)
  } catch (err) {
    throw new BrowserDownError(`Le navigateur ne démarre plus (${err.message}) : le test s'arrête. Relance-le, il reprendra où il en était.`)
  }
  try {
    return await checkGeneratedApp(session.page, testCase, html, journal)
  } finally {
    await session.close()
  }
}

/** Une application juste, connue : sert à vérifier que le navigateur marche AVANT de télécharger quoi que ce soit. */
const PREFLIGHT_APP =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="n">0</div><button id="p">+1</button>' +
  '<button id="z">Remettre à zéro</button><script>let n=0;const s=()=>document.getElementById("n").textContent=n;' +
  'p.onclick=()=>{n++;s()};z.onclick=()=>{n=0;s()}</script></body></html>'

/** Quantile d'une liste de durées (0.5 = médiane, 0.95 = 95e centile), `null` si vide. */
function quantile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

/**
 * Même appel que lookAtScreen (electron/services/vision.ts) : pas d'outils, `think: false` toujours (les
 * modèles vision ne le supportent pas forcément, et la production ne l'utilise jamais ici) — pour que ce
 * test mesure le comportement réel de Jaris, pas un usage générique de l'API vision.
 */
async function chatVision(model, prompt, imageBase64) {
  const start = performance.now()
  // Étape 230 : mêmes consignes et même fenêtre que look_at_screen (describeImage, vision.ts) — le test les
  // omettait. VISION_SYSTEM_PROMPT est une copie vérifiée par scripts/test-benchmark-cases.mjs.
  const data = await postChat({
    model,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: prompt, images: [imageBase64] }
    ],
    stream: false,
    think: false,
    options: { num_ctx: CONVERSATION_NUM_CTX }
  })
  const wallMs = performance.now() - start
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  return {
    wallMs,
    tokPerSec: evalDurationS > 0 ? evalCount / evalDurationS : null,
    content: data.message?.content?.trim() ?? '',
    data
  }
}

/**
 * Étape 233 : une étape de computer_use_task telle que nextStep (computerUse.ts) l'envoie au modèle de vision —
 * mêmes consignes, même message, `think: false`, même fenêtre de contexte. La toute première étape d'une tâche.
 */
async function chatPilot(model, testCase, imageBase64) {
  const start = performance.now()
  const messages = [
    { role: 'system', content: PILOT_SYSTEM_PROMPT },
    { role: 'user', content: buildPilotPrompt(testCase.goal, [], testCase.elements ?? []), images: [imageBase64] }
  ]
  const data = await postChat({ model, messages, stream: false, think: false, options: { num_ctx: CONVERSATION_NUM_CTX } })
  return { wallMs: performance.now() - start, content: data.message?.content?.trim() ?? '', data, messages }
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

  const data = await postChat(body)
  return { wallMs: performance.now() - start, data }
}

async function chatCode(model, prompt) {
  let wallMs, data
  let think = 'high'
  try {
    ;({ wallMs, data } = await chatCodeOnce(model, prompt, true))
  } catch (firstErr) {
    if (firstErr instanceof OllamaDownError || firstErr instanceof CallTimeoutError) throw firstErr
    think = false
    try {
      ;({ wallMs, data } = await chatCodeOnce(model, prompt, false))
    } catch (secondErr) {
      throw THINK_REFUSED.test(firstErr.message) ? secondErr : firstErr
    }
  }
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  return {
    wallMs,
    tokPerSec: evalDurationS > 0 ? evalCount / evalDurationS : null,
    content: data.message?.content?.trim() ?? '',
    data,
    think
  }
}

/** Titre de la section de détail par modèle du fichier de résultats (étape 230), relu à la reprise. */
const CONVERSATION_DETAIL_HEADING = '## Détail de la conversation, modèle par modèle'
/**
 * Étape 232 : tout ce qui s'est passé dans chaque demande complète (appels, arguments, résultats, réponses
 * entières), une ligne JSON par modèle. Sert à rejuger le fichier si un jugement est corrigé plus tard
 * (rejudge, benchmark-scenarios.mjs), sans relancer le test.
 */
const SCENARIO_RAW_HEADING = '## Données brutes des demandes complètes'
/** Étape 232 : le HTML entier de chaque application générée, pour la revérifier sans la régénérer. */
const CODE_RAW_HEADING = '## Données brutes du code'

/** Un texte de réponse sur une seule ligne, coupé à `max` caractères : lisible dans le fichier de résultats. */
function oneLine(text, max = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Bloc « ### modèle » du fichier de résultats (étape 230) : les questions ratées, avec le nombre de passages
 * ratés et ce que le modèle a fait à la place, puis ses réponses aux questions sans outil.
 */
function formatConversationDetail(model, perModel, detail, repeats = CONVERSATION_REPEATS, intro = [], outro = []) {
  const lines = [`### ${model} — ${perModel.correct}/${perModel.total}`, '', ...intro]
  const missed = detail.filter((d) => d.missed > 0)
  if (!missed.length) lines.push('Aucune question ratée.')
  for (const d of missed) {
    lines.push(
      `- RATÉ ${d.missed}/${d.runs ?? repeats} « ${d.prompt} »${d.expectedTool === undefined ? '' : ` (attendu : ${d.expectedTool ?? 'aucun outil'})`} — obtenu : ${d.got.join(' ; ')}`
    )
  }
  const answered = detail.filter((d) => d.answers.length)
  if (answered.length) {
    lines.push('')
    lines.push('Toutes les réponses (à vérifier toi-même) :')
    for (const d of answered) {
      lines.push(`- « ${d.prompt} »`)
      for (const answer of d.answers) lines.push(`  > ${oneLine(answer, 1500)}`)
    }
  }
  if (outro.length) lines.push('', ...outro)
  lines.push('')
  return lines.join('\n')
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
  // et les autres logiciels — RAM_SAFETY_MARGIN_GB (16 Go depuis l'étape 119), la même marge que pour
  // RAM_OFFLOAD_MODELS.
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

  ollamaVersion = await readOllamaVersion()
  // Étape 233 : la configuration de toute la campagne, en tête des traces.
  trace({
    type: 'campagne',
    ollama: ollamaVersion,
    jaris: process.env.JARIS_APP_VERSION ?? null,
    versions: { conversation: CONVERSATION_TEST_VERSION, demandes: SCENARIO_TEST_VERSION, vision: VISION_TEST_VERSION, code: CODE_TEST_VERSION },
    harness: harnessFingerprint(),
    machine: {
      platform: process.platform,
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      ramGb: Number(ramGb.toFixed(1)),
      vramGb: vramGb === null ? null : Number(vramGb.toFixed(1)),
      gpu: await detectGpuName()
    },
    numCtx: CONVERSATION_NUM_CTX,
    simulatedNow: SCENARIO_NOW.toString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    options: { scope: SCOPE, resume: RESUME, deleteAfterTest: DELETE_AFTER_TEST, onlyModels: [...ONLY_MODELS] }
  })
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
        `${VERIFIED_MODELS.vision.size} vision, ${VERIFIED_MODELS.code.size} code) : ni téléchargés ni testés ce run-ci, leur fiabilité vient du fichier vérifié.\n`
    )
  }

  // Résultats déjà écrits (run précédent, ou sauvegarde incrémentale de CE run avant une interruption — voir
  // persistResults plus bas) : lus ICI, avant de savoir quoi installer/tester, pour pouvoir sauter les
  // modèles déjà faits quand JARIS_RESUME=1 (voir son commentaire plus haut). Même format de parsing que
  // parseLocalBenchmark (hardwareScan.ts) : trois sections "## Conversation/Vision/Code", PAS une seule map
  // par nom de modèle — même correctif que readVerifiedModels un peu plus haut dans ce fichier, ici étendu
  // au fichier JUMEAU (benchmark-results.md) qui l'avait manqué. Repéré directement sur une capture d'écran
  // de Léo : ministral-3:8b (candidat Médium ET Vision) montrait le même "2/3" dans les deux paliers, son
  // vrai score de conversation (sur 6) écrasé par son score vision testé dans le même run. Sans cette
  // séparation, `alreadyDone` sautait aussi À TORT le test de conversation d'un modèle dont seul le test
  // vision avait déjà tourné (et vice versa) : les deux bugs partagent la même cause, corrigés ensemble.
  const existingRows = { conversation: new Map(), vision: new Map(), code: new Map(), scenarios: new Map() }
  const previousDetails = new Map()
  const previousRaw = new Map()
  const previousCodeRaw = new Map()
  try {
    const previous = readFileSync(RESULTS_PATH, 'utf-8')
    let currentTier = null
    for (const line of previous.split('\n')) {
      if (line.startsWith('## ')) {
        const heading = line.slice(3).trim().toLowerCase()
        currentTier = tierOfHeading(heading)
        continue
      }
      if (!currentTier || !line.startsWith('|') || line.includes('---') || line.includes('Modèle')) continue
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      // Tolère le format v0.15.29 à cinq colonnes ; la dernière mesure a été retirée de l'interface et du
      // choix des modèles, mais les quatre mesures historiques restent valides et sont conservées.
      if (cells.length !== 4 && cells.length !== 5) continue
      const [model, latency, speed, reliability] = cells
      existingRows[currentTier].set(model, { latency, speed, reliability })
    }
    // Étape 163 : des résultats de conversation d'une AUTRE version du test (ou sans version, la toute première
    // analyse) ne valent rien pour celle-ci — oubliés, jamais recopiés dans le nouveau fichier.
    const version = previous.match(/Version du test de conversation : (\d+)/)?.[1]
    if (Number(version) !== CONVERSATION_TEST_VERSION) existingRows.conversation.clear()
    // Étape 232 : même règle pour les demandes complètes.
    const scenarioVersion = previous.match(/Version du test des demandes complètes : (\d+)/)?.[1]
    if (Number(scenarioVersion) !== SCENARIO_TEST_VERSION) existingRows.scenarios.clear()
    if (Number(previous.match(/Version du test de vision : (\d+)/)?.[1]) !== VISION_TEST_VERSION) existingRows.vision.clear()
    if (Number(previous.match(/Version du test de code : (\d+)/)?.[1]) !== CODE_TEST_VERSION) existingRows.code.clear()
    // Étape 230 : le détail par modèle d'un run précédent du MÊME test, gardé pour les modèles qui ne sont pas
    // retestés ce run-ci (reprise après coupure) — sinon le fichier final perdrait le détail des premiers. Les
    // lignes d'un autre test viennent d'être oubliées ci-dessus : leur détail ne sera donc pas gardé non plus.
    {
      const start = previous.indexOf(CONVERSATION_DETAIL_HEADING)
      if (start >= 0) {
        const after = previous.slice(start + CONVERSATION_DETAIL_HEADING.length)
        const end = after.search(/\n## /)
        const section = end >= 0 ? after.slice(0, end) : after
        for (const block of section.split(/\n(?=### )/)) {
          const name = block.match(/^### (.+?) — /)?.[1]
          const visionName = name?.match(/^(.+) \(vision\)$/)?.[1]
          const scenarioName = name?.match(/^(.+) \(demandes\)$/)?.[1]
          const codeName = name?.match(/^(.+) \(code\)$/)?.[1]
          const kept = visionName
            ? existingRows.vision.has(visionName)
            : scenarioName
              ? existingRows.scenarios.has(scenarioName)
              : codeName
                ? existingRows.code.has(codeName)
                : name && existingRows.conversation.has(name)
          if (kept) previousDetails.set(name, `${block.trim()}\n`)
        }
      }
      for (const [heading, tier, target] of [
        [SCENARIO_RAW_HEADING, 'scenarios', previousRaw],
        [CODE_RAW_HEADING, 'code', previousCodeRaw]
      ]) {
        const start = previous.indexOf(heading)
        if (start < 0) continue
        const after = previous.slice(start + heading.length)
        const end = after.search(/\n## /)
        for (const line of (end >= 0 ? after.slice(0, end) : after).split('\n')) {
          const match = line.match(/^- `(.+?)` (\[.*\])$/)
          if (match && existingRows[tier].has(match[1])) target.set(match[1], match[2])
        }
      }
    }
  } catch {
    // Pas de fichier précédent (tout premier run) : rien à conserver, existingRows reste vide.
  }
  // Un ancien fichier (avant ce correctif, sans section "## ") ne matche jamais `currentTier` : ses lignes
  // sont ignorées plutôt que mal réparties — repli sûr, mieux vaut re-tester une fois que réutiliser des
  // scores qu'on ne peut plus garantir corrects.
  // Étape 162 : une ligne de conversation ne compte comme « déjà faite » que si elle vient du test ACTUEL (même
  // nombre de questions) — une ligne de l'ancien test (x/6) est refaite, jamais reprise telle quelle.
  // Étape 164 : vision et code aussi — une mesure INCOMPLÈTE n'est jamais reprise (qwen2.5-coder:32b à « 2/2 » :
  // une des trois générations avait planté, très probablement sur l'ancien délai de 5 minutes de fetch).
  const questionsPerTier = { conversation: CONVERSATION_TOTAL, vision: VISION_TOTAL, code: CODE_TOTAL, scenarios: SCENARIO_TOTAL }
  const madeWithCurrentTest = (tier, row) => row.reliability?.endsWith(`/${questionsPerTier[tier]}`)
  // Étape 164 : une ligne sans AUCUNE réponse (latence « — », toutes les questions en erreur) n'est pas un score :
  // elle est refaite. C'est ce qui bloquait ministral-3:3b, granite4.1:8b et gemma4:26b à 0/17 chez Léo, notés
  // pendant qu'Ollama était injoignable.
  const answeredSomething = (row) => !row.latency?.startsWith('—')
  const alreadyDone = (model, tier) =>
    RESUME && existingRows[tier].has(model) && madeWithCurrentTest(tier, existingRows[tier].get(model)) && answeredSomething(existingRows[tier].get(model))

  // SCOPED_MODELS/SCOPED_VISION_CANDIDATES/SCOPED_CODE_CANDIDATES (pas MODELS/VISION_CANDIDATES/
  // CODE_CANDIDATES directement) : un run ciblé sur un seul palier (SCOPE) ne doit installer/tester QUE ses
  // propres candidats, jamais les autres — la barre de progression (OptionsMenu.tsx) n'a pas besoin de les
  // distinguer, seulement combien reste à installer au total pour CE run.
  const allInstallable = [
    ...SCOPED_MODELS.filter((m) => !alreadyDone(m, 'conversation')),
    ...SCOPED_SCENARIO_MODELS.filter((m) => !alreadyDone(m, 'scenarios')),
    ...SCOPED_VISION_CANDIDATES.map((c) => c.model).filter((m) => !alreadyDone(m, 'vision')),
    ...SCOPED_CODE_CANDIDATES.map((c) => c.model).filter((m) => !alreadyDone(m, 'code'))
  ]
  if (RESUME) {
    const resumedCount =
      SCOPED_MODELS.filter((m) => alreadyDone(m, 'conversation')).length +
      SCOPED_SCENARIO_MODELS.filter((m) => alreadyDone(m, 'scenarios')).length +
      SCOPED_VISION_CANDIDATES.filter((c) => alreadyDone(c.model, 'vision')).length +
      SCOPED_CODE_CANDIDATES.filter((c) => alreadyDone(c.model, 'code')).length
    if (resumedCount) {
      console.log(
        `Reprise (JARIS_RESUME=1) : ${resumedCount} modèle(s) du périmètre déjà présent(s) dans ${RESULTS_PATH}, ni retéléchargé(s) ni retesté(s).\n`
      )
    }
  }
  // Un modèle à la fois en conversation et en demandes complètes ne doit être téléchargé qu'une fois.
  const missingAll = [...new Set(allInstallable)].filter((m) => !installed.includes(m))

  // Repli budgétaire pour chaque modèle manquant : VRAM+RAM combinées (RAM_OFFLOAD_MODELS) ou VRAM/RAM seule
  // sinon, ET l'espace disque libre — deux contraintes INDÉPENDANTES (un modèle peut tenir en RAM une fois
  // chargé tout en étant impossible à télécharger faute de place sur le disque, et inversement) : le plus
  // petit des deux budgets gagne.
  const budgetFor = (model) => {
    // Étape 162 : TOUS les modèles peuvent déborder sur la RAM pendant le test. Réussir ou non une question
    // ne dépend pas du matériel — seule la durée change. Avant, un modèle un peu plus gros que la carte et
    // absent de RAM_OFFLOAD_MODELS n'était jamais testé (gemma4:12b, 7,6 Go, sur une carte de 8 Go).
    const memBudget = Math.max(vramBudgetGb, ramOffloadBudgetGb)
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
  // Étape 169 : la VRAIE raison d'un modèle sauté, transmise avec ##MODEL_SKIPPED## et écrite dans le fichier de
  // résultats — Léo voyait seulement « sauté (trop gros ou téléchargement impossible) » pour G9v3-3B, un modèle de
  // 1,9 Go qui ne pouvait évidemment pas être trop gros, sans aucun moyen de savoir ce qui avait échoué.
  const skipReasons = new Map()
  if (tooLargeUpfront.length) {
    console.log(`${tooLargeUpfront.length} modèle(s) ignoré(s) d'emblée (trop gros pour cette machine) :`)
    for (const m of tooLargeUpfront) {
      const reason = `trop gros pour ce PC (~${modelWeightGb(m).toFixed(1)} Go, ${budgetFor(m).toFixed(1)} Go disponibles)`
      console.log(`  ${m} ignoré : ${reason}`)
      skipReasons.set(m, reason)
      // Lu par le suivi en direct (UnscoredModelsTest.tsx) : ce modèle ne sera jamais testé ce run-ci.
      console.log(`##MODEL_SKIPPED## ${m} ${reason}`)
    }
    console.log('')
  }

  const toRun = SCOPED_MODELS.filter((m) => !alreadyDone(m, 'conversation') && (installed.includes(m) || missing.includes(m)))
  const scenarioToRun = SCOPED_SCENARIO_MODELS.filter((m) => !alreadyDone(m, 'scenarios') && (installed.includes(m) || missing.includes(m)))
  // Les deux épreuves de conversation se jouent à la suite pour un même modèle, chargé une seule fois.
  const conversationPhase = CONVERSATION_SCOPE.filter((m) => toRun.includes(m) || scenarioToRun.includes(m))
  const visionToRun = SCOPED_VISION_CANDIDATES.map((c) => c.model).filter(
    (m) => !alreadyDone(m, 'vision') && (installed.includes(m) || missing.includes(m))
  )
  const codeToRun = SCOPED_CODE_CANDIDATES.map((c) => c.model).filter(
    (m) => !alreadyDone(m, 'code') && (installed.includes(m) || missing.includes(m))
  )
  if (!conversationPhase.length && !visionToRun.length && !codeToRun.length) {
    console.log('Aucun des modèles à tester n\'a pu être installé.')
    return
  }

  // Étape 232 : le test de code a besoin d'un navigateur (Edge, installé avec Windows). Vérifié MAINTENANT, sur une
  // application connue, avant le moindre téléchargement : un souci de navigateur se voit en quelques secondes,
  // jamais après des heures de test.
  if (codeToRun.length) {
    const reason = !BROWSER_PATH
      ? 'Microsoft Edge (ou Google Chrome) est introuvable'
      : await checkInBrowser(CODE_TEST_CASES[0], PREFLIGHT_APP).then(
          (r) => (r ? `une application de contrôle n'a pas passé la vérification (${r})` : null),
          (err) => err.message
        )
    if (reason) {
      console.log(`\nTest de code impossible sur ce PC : ${reason}. Rien n'a été téléchargé.`)
      process.exit(1)
    }
    console.log(`Navigateur pour le test de code : ${BROWSER_PATH} — vérifié sur une application de contrôle.\n`)
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
    toRun.reduce((sum, m) => sum + testWeightOf(m) * CONVERSATION_TOTAL, 0) +
    scenarioToRun.reduce((sum, m) => sum + testWeightOf(m) * SCENARIO_TOTAL * SCENARIO_WEIGHT, 0) +
    visionToRun.reduce((sum, m) => sum + testWeightOf(m) * VISION_TOTAL, 0) +
    codeToRun.reduce((sum, m) => sum + testWeightOf(m) * CODE_TEST_CASES.length * CODE_WEIGHT, 0)
  const totalWeight = totalPullWeight + totalTestWeight || 1
  let weightDone = 0
  const emitProgress = () => console.log(`##PROGRESS## ${weightDone.toFixed(2)} ${totalWeight.toFixed(2)}`)
  emitProgress()

  // Espace disque SERRÉ pour ce run : pas assez de marge pour garder TOUT ce qui va être téléchargé installé
  // en même temps jusqu'à la toute fin (le fonctionnement habituel, le plus simple — voir cleanupUnselectedModels
  // dans benchmarkRunner.ts, qui fait le ménage une fois le gagnant de chaque palier connu). Dans ce cas,
  // deux ajustements : téléchargements strictement l'un après l'autre (pas 2 à la fois, pour ne jamais avoir
  // 2 gros modèles "en trop" sur le disque en même temps) et suppression d'un modèle dès la fin de son dernier
  // test (voir releaseAfterLastTest plus bas) — plutôt que d'attendre la fin du run pendant laquelle TOUS les
  // modèles testés jusqu'ici restent installés simultanément. `null` (espace
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
  // Étape 230 : registre des modèles que le test a téléchargés LUI-MÊME, gardé à côté du fichier de résultats.
  // Sans lui, un test coupé (Jaris fermé, PC éteint) juste après un téléchargement laissait ce modèle sur le
  // disque, et la reprise le prenait ensuite pour un modèle installé par Léo : jamais supprimé (jusqu'à 25 Go).
  const ledgerPath = `${RESULTS_PATH}.telecharges.json`
  const readLedger = () => {
    try {
      return new Set(JSON.parse(readFileSync(ledgerPath, 'utf-8')))
    } catch {
      return new Set()
    }
  }
  const downloadedByTest = DELETE_AFTER_TEST ? readLedger() : new Set()
  const saveLedger = () => {
    if (DELETE_AFTER_TEST) writeFileSync(ledgerPath, JSON.stringify([...downloadedByTest]), 'utf-8')
  }
  const initiallyInstalledSet = new Set(installed.filter((m) => !downloadedByTest.has(m)))
  // Un modèle téléchargé par un run précédent, dont tous les tests sont déjà faits (repris) : supprimé tout de suite.
  for (const model of [...downloadedByTest]) {
    const stillToTest = conversationPhase.includes(model) || visionToRun.includes(model) || codeToRun.includes(model)
    if (stillToTest) continue
    if (installed.includes(model)) {
      try {
        await deleteModelViaApi(model)
        console.log(`  ${model} : supprimé (téléchargé par un test précédent, déjà testé)`)
      } catch (err) {
        console.log(`  ${model} : échec de la suppression (${err.message}), ignoré`)
        continue
      }
    }
    downloadedByTest.delete(model)
  }
  saveLedger()

  // Espace disque serré (étape 162) : un modèle téléchargé par CE run est supprimé dès la fin de son DERNIER
  // test (conversation, puis vision, puis code). L'ancien tri par « champion de palier » n'a plus de sens depuis
  // que chaque rôle choisit dans tous les modèles (étape 160) ; Jaris retélécharge ensuite, à la fin de
  // l'analyse, les modèles qu'il a choisis (« Retester la configuration »).
  const lastPhaseOf = (model) => (codeToRun.includes(model) ? 'code' : visionToRun.includes(model) ? 'vision' : 'conversation')
  async function releaseAfterLastTest(model, phase) {
    if (!(tightDiskMode || DELETE_AFTER_TEST) || initiallyInstalledSet.has(model) || lastPhaseOf(model) !== phase) return
    try {
      await deleteModelViaApi(model)
      downloadedByTest.delete(model)
      saveLedger()
      console.log(`  ${model} : supprimé après son test${tightDiskMode ? ' (espace disque limité)' : ''}`)
    } catch (err) {
      console.log(`  ${model} : échec de la suppression après test (${err.message}), ignoré`)
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
    // Noté AVANT le téléchargement : coupé en plein milieu, le modèle reste à la charge du test.
    downloadedByTest.add(model)
    saveLedger()
    let ok = true
    try {
      await pullModel(model, budgetFor(model), diskCtx, (bucket) => {
        // Crédit PARTIEL en cours de téléchargement (pas juste à la fin) : sans ça, un seul gros modèle en
        // téléchargement ferait stagner la barre globale plusieurs minutes malgré une vraie progression.
        console.log(`##PROGRESS## ${(weightDone + (weight * bucket) / 100).toFixed(2)} ${totalWeight.toFixed(2)}`)
      })
    } catch (err) {
      ok = false
      skipReasons.set(model, `téléchargement impossible : ${err.message}`)
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
  const errors = []
  // Détail par modèle (étape 230) : d'abord celui des modèles repris d'un run précédent, remplacé au fur et à
  // mesure par celui des modèles testés ce run-ci.
  const conversationDetails = new Map(previousDetails)
  const scenarioRaw = new Map(previousRaw)
  const codeRaw = new Map(previousCodeRaw)
  let testsDone = 0
  const testsTotal =
    toRun.length * CONVERSATION_TOTAL +
    scenarioToRun.length * SCENARIO_TOTAL +
    visionToRun.length * VISION_TOTAL +
    codeToRun.length * CODE_TOTAL
  // Remonté avant les boucles de test (pas défini seulement à l'écriture des résultats comme avant) :
  // utilisée pendant le run, pas seulement à la toute fin.
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
    // Trois sections séparées ("## Conversation/Vision/Code"), PAS un seul tableau par nom de modèle — même
    // correctif que readVerifiedModels un peu plus haut dans ce fichier (voir son commentaire), appliqué ici
    // au fichier JUMEAU qui l'avait manqué : un modèle candidat à plusieurs paliers (ex: ministral-3:8b,
    // Conversation ET Vision) écrivait sinon DEUX lignes sous le même nom dans un tableau plat, la seconde
    // écrasant silencieusement la première au moment de la relecture (parseLocalBenchmark, hardwareScan.ts) —
    // repéré directement sur une capture d'écran de Léo montrant le même score "2/3" dans les deux paliers.
    const byRole = { conversation: [], vision: [], code: [], scenarios: [] }
    for (const r of results) byRole[r.role].push(r)

    const lines = []
    lines.push(`# Résultats du benchmark Jaris — ${new Date().toLocaleString('fr-FR')}`)
    lines.push('')
    lines.push(`Version du test de conversation : ${CONVERSATION_TEST_VERSION}`)
    lines.push(`Version du test des demandes complètes : ${SCENARIO_TEST_VERSION}`)
    lines.push(`Version du test de vision : ${VISION_TEST_VERSION}`)
    lines.push(`Version du test de code : ${CODE_TEST_VERSION}`)
    lines.push(`Ollama : ${ollamaVersion}`)
    lines.push('')
    lines.push(
      "Quatre épreuves distinctes, une section chacune : premier appel d'outil (Conversation), compréhension " +
        "d'image (Vision), génération de HTML valide (Code) et demandes jouées de bout en bout (Demandes " +
        'complètes) — jamais la même mesure sous le même nom de modèle.'
    )
    for (const [role, heading] of [
      ['conversation', 'Conversation'],
      ['vision', 'Vision'],
      ['code', 'Code'],
      ['scenarios', 'Demandes complètes']
    ]) {
      lines.push('')
      lines.push(`## ${heading}`)
      lines.push('')
      if (role === 'scenarios') {
        // Étape 232 : durée d'une demande ENTIÈRE (tous ses appels), médiane et 95e centile — la moyenne
        // cacherait les demandes très lentes, celles qui donnent l'impression que Jaris est bloqué.
        lines.push(
          `${SCENARIOS.length} demandes de bout en bout dans la boucle de Jaris (relances comprises), dont ${REPEATED_SCENARIOS.length} rejouées une 2e fois ` +
            `(autre graine, résultats différents) : ${SCENARIO_TOTAL} passages, outils simulés (benchmark-scenarios.mjs). Réussite moyenne par demande dans le détail.`
        )
        lines.push('')
        lines.push('| Modèle | Durée médiane | Durée 95 % | Réussite |')
      } else {
        lines.push('| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |')
      }
      lines.push('|---|---|---|---|')
      const testedThisRun = new Set(byRole[role].map((r) => r.model))
      for (const r of byRole[role]) {
        const acc = r.total ? `${r.correct}/${r.total}` : '—'
        if (role === 'scenarios') {
          const seconds = (q) => {
            const ms = quantile(r.latencies, q)
            return ms === null ? '—' : `${fmt(ms / 1000)} s`
          }
          lines.push(`| ${r.model} | ${seconds(0.5)} | ${seconds(0.95)} | ${acc} |`)
        } else {
          lines.push(`| ${r.model} | ${fmt(avg(r.latencies), 0)} ms | ${fmt(avg(r.speeds))} tok/s | ${acc} |`)
        }
      }
      for (const [model, row] of existingRows[role]) {
        if (testedThisRun.has(model)) continue
        lines.push(`| ${model} | ${row.latency} | ${row.speed} | ${row.reliability} |`)
      }
    }

    // Étape 230 : une section par modèle — questions ratées (combien de passages sur CONVERSATION_REPEATS, et ce
    // qu'il a fait à la place), puis ses réponses aux questions sans outil, à juger soi-même. Les modèles repris
    // d'un run interrompu (JARIS_RESUME) gardent la section écrite par le run précédent.
    lines.push('')
    lines.push(CONVERSATION_DETAIL_HEADING)
    lines.push('')
    for (const block of conversationDetails.values()) lines.push(block)

    for (const [heading, raws] of [
      [SCENARIO_RAW_HEADING, scenarioRaw],
      [CODE_RAW_HEADING, codeRaw]
    ]) {
      if (!raws.size) continue
      lines.push(heading)
      lines.push('')
      for (const [model, json] of raws) lines.push(`- \`${model}\` ${json}`)
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

    if (skipReasons.size) {
      lines.push('## Modèles non testés')
      lines.push('')
      for (const [model, reason] of skipReasons) lines.push(`- **${model}** : ${reason}`)
      lines.push('')
    }

    // Écrit aussi le rapport dans un fichier : plus simple à envoyer/coller ailleurs qu'à faire défiler et
    // copier depuis le terminal, surtout avec autant de modèles testés d'affilée.
    writeFileSync(RESULTS_PATH, lines.join('\n'), 'utf-8')
    return lines.join('\n')
  }

  /** Les 26 questions × 3 (benchmark-cases.mjs) : le premier appel d'outil, question par question. */
  async function runConversationCases(model) {
    const perModel = { model, role: 'conversation', latencies: [], speeds: [], correct: 0, total: 0 }
    const guard = timeoutGuard()

    // Étape 230 : détail par question (combien de passages ratés, et ce que le modèle a fait à la place) —
    // le fichier ne gardait que le total, impossible de savoir CE QUE granite4.2:3b avait raté.
    const detail = TEST_CASES.map((testCase) => ({ prompt: testCase.prompt, expectedTool: testCase.expectedTool, missed: 0, got: [], answers: [] }))
    for (let pass = 1; pass <= CONVERSATION_REPEATS; pass++) for (const [caseIndex, testCase] of TEST_CASES.entries()) {
      const { prompt, expectedTool } = testCase
      const caseDetail = detail[caseIndex]
      process.stdout.write(`  [${pass}/${CONVERSATION_REPEATS}] "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      // Étape 162 : chaque question compte, y compris celles où il ne faut AUCUN outil, et un appel n'est
      // réussi que si son contenu l'est aussi (bon délai de rappel, bon nom d'application...).
      perModel.total++
      try {
        guard.check()
        const r = await chat(model, testCase)
        guard.passed()
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)
        const ok = isCorrectAnswer(testCase, r)
        trace({
          type: 'question',
          model,
          pass,
          index: caseIndex,
          ok,
          ms: Math.round(r.wallMs),
          think: r.think,
          messages: compactMessages(buildCaseMessages(testCase)),
          response: r.data.message ?? null,
          meta: ollamaMeta(r.data)
        })
        if (ok) perModel.correct++
        const got = r.toolName ? `${r.toolName} ${JSON.stringify(r.toolArgs ?? {})}` : 'aucun outil'
        console.log(`${ok ? 'OK' : 'RATÉ'} (attendu: ${expectedTool ?? 'aucun outil'}, obtenu: ${got}) — ${fmt(r.wallMs, 0)}ms`)
        const said = r.toolName ? got : `aucun outil : « ${oneLine(r.content) || 'réponse vide'} »`
        if (!ok) {
          caseDetail.missed++
          caseDetail.got.push(said)
        }
        // Étape 230 (Léo : « je veux que ça note toutes les réponses, fausses et vraies ») : chaque réponse, avec son
        // jugement, pour pouvoir corriger un score à la main dans les deux sens.
        caseDetail.answers.push(`${ok ? 'compté juste' : 'compté faux'} : ${said}`)
      } catch (err) {
        // Ollama injoignable : l'analyse s'arrête AVANT d'enregistrer ce modèle (jamais un faux score).
        if (err instanceof OllamaDownError) throw err
        guard.failed(err)
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
        caseDetail.missed++
        caseDetail.got.push(`erreur : ${err.message}`)
        // Une erreur figure aussi dans la liste complète : sinon la liste compte moins de réponses que le total.
        caseDetail.answers.push(`compté faux : erreur : ${err.message}`)
        trace({ type: 'question', model, pass, index: caseIndex, ok: false, reason: `erreur : ${err.message}`, timeout: err instanceof CallTimeoutError, skipped: Boolean(err.skipped) })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model)
      emitProgress()
    }

    results.push(perModel)
    const config = await recordModelConfig(model, 'questions')
    conversationDetails.set(model, formatConversationDetail(model, perModel, detail, CONVERSATION_REPEATS, [], [`Configuration : ${config}.`]))
    // Lu par le tableau de suivi en direct (OptionsMenu.tsx) : ce modèle a fini tous ses tests, avec ce score.
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()
  }

  /**
   * Étape 232, puis 233 : les demandes complètes (benchmark-scenarios.mjs), jouées de bout en bout dans une copie
   * vérifiée de la boucle de converse() — 40 demandes différentes, puis 8 rejouées avec une autre graine et des
   * résultats différents. Chaque passage a sa graine ; la trace lisible va dans le fichier de résultats, la trace
   * COMPLÈTE (requêtes exactes, réflexion, tokens, durées) dans le fichier de traces.
   */
  async function runScenarioPhase(model) {
    const perModel = { model, role: 'scenarios', latencies: [], speeds: [], correct: 0, total: 0 }
    const guard = timeoutGuard()
    const thinkModes = new Set()
    const detail = SCENARIOS.map((sc) => ({ prompt: `${sc.id} — ${sc.turns.join(' → ')}`, expectedTool: undefined, missed: 0, runs: 0, got: [], answers: [] }))
    const raw = []
    const outcomes = []
    const stats = { promptTokens: [], firstToolMs: [], nudges: 0, truncated: 0, emptyAfterThinking: 0, timeouts: 0 }
    for (const { scenario, index, pass, variant } of SCENARIO_RUNS) {
      const seed = scenarioSeed(pass, index)
      process.stdout.write(`  [${pass}/2] demande « ${scenario.id} » ... `)
      perModel.total++
      detail[index].runs++
      // Relecture ChatGPT (v0.28.1) : chaque requête est écrite AVANT l'envoi, chaque réponse et chaque résultat
      // d'outil dès qu'ils arrivent. La ligne « demande » complète suit à la fin ; si la demande s'interrompt
      // (erreur, Jaris fermé, PC éteint), ces lignes gardent tout ce qui s'était passé avant.
      const where = { model, id: scenario.id, pass, variant, seed }
      const onEvent = ({ kind, messages, ...event }) =>
        trace({ type: `demande-${kind}`, ...where, ...event, ...(messages ? { messages: compactMessages(messages) } : {}) })
      try {
        guard.check()
        const run = await runScenario(scenario, (messages) => chatScenario(model, messages, seed, thinkModes), { variant, onEvent })
        guard.passed()
        // Dans le fichier de résultats : de quoi rejuger (appels, réponses), sans les requêtes entières (traces).
        const turns = run.turns.map(({ messages: _messages, ...turn }) => turn)
        raw.push({ id: scenario.id, pass, variant, seed, ok: run.ok, reason: run.reason, ms: Math.round(run.wallMs), turns, calls: run.calls })
        trace({
          type: 'demande',
          model,
          id: scenario.id,
          family: scenario.family,
          pass,
          variant,
          seed,
          ok: run.ok,
          reason: run.reason,
          ms: Math.round(run.wallMs),
          turns: run.turns.map((turn) => ({ ...turn, messages: compactMessages(turn.messages) })),
          modelCalls: run.modelCalls,
          calls: run.calls,
          finalState: run.finalState
        })
        for (const call of run.modelCalls) {
          if (call.meta.prompt_eval_count) stats.promptTokens.push(call.meta.prompt_eval_count)
          if (call.meta.done_reason === 'length') stats.truncated++
          if (!call.response?.content && !call.response?.tool_calls?.length && call.response?.thinking) stats.emptyAfterThinking++
        }
        for (const turn of run.turns) {
          stats.nudges += turn.nudges.length
          if (turn.msFirstTool !== null) stats.firstToolMs.push(turn.msFirstTool)
        }
        outcomes.push({ id: scenario.id, ok: run.ok })
        perModel.latencies.push(run.wallMs)
        if (run.ok) perModel.correct++
        else {
          detail[index].missed++
          detail[index].got.push(run.reason)
        }
        const nudgeNote = run.turns.some((t) => t.nudges.length) ? ` — relancé par Jaris : ${run.turns.flatMap((t) => t.nudges).join(', ')}` : ''
        detail[index].answers.push(`${run.ok ? 'compté juste' : `compté faux (${run.reason})`} — graine ${seed}${variant ? ', variante 2' : ''}${nudgeNote} — ${describeRun(run)}`)
        console.log(`${run.ok ? 'OK' : `RATÉ (${run.reason})`} — ${fmt(run.wallMs / 1000)} s`)
        // Une demande ratée montre aussi ce qui s'est passé, sans attendre le fichier de fin de modèle.
        if (!run.ok) console.log(`      ${describeRun(run)}`)
      } catch (err) {
        if (err instanceof OllamaDownError) throw err
        guard.failed(err)
        const timeout = err instanceof CallTimeoutError
        if (timeout && !err.skipped) stats.timeouts++
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt: scenario.turns[0], message: err.message })
        detail[index].missed++
        detail[index].got.push(`erreur : ${err.message}`)
        detail[index].answers.push(`compté faux : erreur : ${err.message}`)
        // Ce qui avait déjà été joué avant l'erreur (runScenario le joint à l'erreur) : avant, tout était perdu.
        const partial = err.partial
        const ms = partial ? Math.round(partial.wallMs) : null
        const turns = partial ? partial.turns.map(({ messages: _messages, ...turn }) => turn) : []
        const skipped = Boolean(err.skipped)
        raw.push({ id: scenario.id, pass, variant, seed, ok: false, reason: `erreur : ${err.message}`, timeout, skipped, ms, turns, calls: partial?.calls ?? [] })
        trace({
          type: 'demande',
          ...where,
          family: scenario.family,
          ok: false,
          reason: `erreur : ${err.message}`,
          timeout,
          skipped,
          ...(partial
            ? {
                ms,
                turns: partial.turns.map((turn) => ({ ...turn, messages: compactMessages(turn.messages) })),
                modelCalls: partial.modelCalls,
                calls: partial.calls,
                finalState: partial.finalState
              }
            : {})
        })
        outcomes.push({ id: scenario.id, ok: false })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model) * SCENARIO_WEIGHT
      emitProgress()
    }
    results.push(perModel)
    const config = await recordModelConfig(model, 'demandes', { thinkSent: [...thinkModes] })
    const median = (values) => quantile(values, 0.5)
    const intro = [
      `Configuration : ${config}, réflexion envoyée ${[...thinkModes].join(' / ') || '—'}, contexte ${CONVERSATION_NUM_CTX}, ` +
        `graines passage × 1000 + numéro de la demande, Ollama ${ollamaVersion}.`,
      '',
      // Relecture ChatGPT : la moyenne de chaque demande d'abord, puis celle des demandes — une demande jouée deux
      // fois ne compte pas double.
      `Réussite moyenne par demande : ${Math.round(100 * demandSuccessRate(outcomes))} % (${SCENARIOS.length} demandes, dont ${REPEATED_SCENARIOS.length} jouées deux fois).`,
      `Relances de Jaris : ${stats.nudges} ; réponses coupées (fenêtre pleine) : ${stats.truncated} ; réponses vides après réflexion : ${stats.emptyAfterThinking} ; ` +
        `tokens envoyés : médiane ${median(stats.promptTokens) ?? '—'}, maximum ${stats.promptTokens.length ? Math.max(...stats.promptTokens) : '—'} sur ${CONVERSATION_NUM_CTX} ; ` +
        `premier outil : médiane ${median(stats.firstToolMs) === null ? '—' : `${fmt(median(stats.firstToolMs) / 1000)} s`} ; ` +
        `délais dépassés (${CALL_TIMEOUT_LABEL} par appel) : ${stats.timeouts}.`,
      '',
      // Une ligne compacte, demande par demande : pour comparer deux modèles sur les MÊMES demandes.
      `Par demande : ${SCENARIOS.map((sc, i) => `${sc.id} ${detail[i].runs - detail[i].missed}/${detail[i].runs}`).join(', ')}.`,
      ''
    ]
    scenarioRaw.set(model, JSON.stringify(raw))
    conversationDetails.set(`${model} (demandes)`, formatConversationDetail(`${model} (demandes)`, perModel, detail, 1, intro))
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()
  }

  for (const model of conversationPhase) {
    const ready = await ensureReady(model)
    if (!ready) {
      console.log(`##MODEL_SKIPPED## ${model} ${skipReasons.get(model) ?? ''}`.trimEnd())
      continue
    }
    console.log(`\n=== ${model} ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    if (toRun.includes(model)) await runConversationCases(model)
    if (scenarioToRun.includes(model)) await runScenarioPhase(model)
    await releaseAfterLastTest(model, 'conversation')
  }

  // Modèles Vision : les images sont lues une seule fois ici, elles ne dépendent que du test.
  const visionImages = VISION_TEST_CASES.map((c) => loadVisionImage(c))
  const pilotImages = VISION_PILOT_CASES.map((c) => loadVisionImage(c))
  const pilotTargets = loadPilotTargets()
  const sha = (base64) => createHash('sha256').update(base64).digest('hex').slice(0, 16)

  for (const model of visionToRun) {
    const readyVision = await ensureReady(model)
    if (!readyVision) {
      console.log(`##MODEL_SKIPPED## ${model} ${skipReasons.get(model) ?? ''}`.trimEnd())
      continue
    }
    console.log(`\n=== ${model} (vision) ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    const perModel = { model, role: 'vision', latencies: [], speeds: [], correct: 0, total: 0 }
    const guard = timeoutGuard()

    // Étape 230 : chaque question posée VISION_REPEATS fois, avec le détail des ratés comme en conversation.
    // Étape 233 : puis les cas de visée (une étape de pilotage de l'écran).
    const visionDetail = [
      ...VISION_TEST_CASES.map((c) => ({ prompt: c.prompt, expectedTool: undefined, missed: 0, got: [], answers: [] })),
      ...VISION_PILOT_CASES.map((c) => ({ prompt: `visée ${c.id} — ${c.goal}`, expectedTool: undefined, missed: 0, got: [], answers: [] }))
    ]
    const cases = [...VISION_TEST_CASES.map((c, i) => ({ kind: 'lecture', c, i })), ...VISION_PILOT_CASES.map((c, i) => ({ kind: 'visée', c, i }))]
    let pilotOk = 0
    for (let pass = 1; pass <= VISION_REPEATS; pass++) for (const [d, { kind, c, i }] of cases.entries()) {
      const label = kind === 'lecture' ? c.prompt : `visée : ${c.goal}`
      process.stdout.write(`  [${pass}/${VISION_REPEATS}] "${label.slice(0, 40)}${label.length > 40 ? '…' : ''}" ... `)
      perModel.total++
      try {
        guard.check()
        const image = kind === 'lecture' ? visionImages[i] : pilotImages[i]
        const r = kind === 'lecture' ? await chatVision(model, c.prompt, image) : await chatPilot(model, c, image)
        guard.passed()
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec != null) perModel.speeds.push(r.tokPerSec)
        const verdict = kind === 'lecture' ? (isCorrectVisionAnswer(c, r.content) ? null : 'réponse fausse') : judgePilotStep(c, r.content, pilotTargets)
        const reason = verdict === null ? null : verdict + cutNote(r.data)
        const ok = reason === null
        trace({
          type: 'vision',
          model,
          kind,
          file: c.file,
          id: c.id ?? null,
          pass,
          ok,
          reason,
          ms: Math.round(r.wallMs),
          prompt: kind === 'lecture' ? c.prompt : c.goal,
          image: sha(image),
          messages: kind === 'visée' ? r.messages.map((m) => (m.images ? { ...m, images: [sha(m.images[0])] } : m.role === 'system' ? { role: 'system', ref: textRef(m.content) } : m)) : undefined,
          response: r.data.message ?? null,
          meta: ollamaMeta(r.data)
        })
        // Étape 230 (Léo : « on sait ce qu'il a répondu, on peut corriger les scores ») : TOUTES les réponses de
        // vision sont recopiées, justes comprises — la vérification peut se tromper dans les deux sens.
        visionDetail[d].answers.push(`${ok ? 'compté juste' : `compté faux${kind === 'visée' ? ` (${reason})` : cutNote(r.data)}`} : ${r.content || 'réponse vide'}`)
        if (ok) {
          perModel.correct++
          if (kind === 'visée') pilotOk++
        } else {
          visionDetail[d].missed++
          visionDetail[d].got.push(kind === 'visée' ? reason : `« ${oneLine(r.content) || 'réponse vide'} »${cutNote(r.data)}`)
        }
        console.log(`${ok ? 'OK' : 'RATÉ'} (réponse: "${r.content.slice(0, 60)}") — ${fmt(r.wallMs, 0)}ms`)
      } catch (err) {
        // Ollama injoignable : l'analyse s'arrête AVANT d'enregistrer ce modèle (jamais un faux score).
        if (err instanceof OllamaDownError) throw err
        guard.failed(err)
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt: label, message: err.message })
        visionDetail[d].missed++
        visionDetail[d].got.push(`erreur : ${err.message}`)
        visionDetail[d].answers.push(`compté faux : erreur : ${err.message}`)
        trace({ type: 'vision', model, kind, file: c.file, id: c.id ?? null, pass, ok: false, reason: `erreur : ${err.message}`, timeout: err instanceof CallTimeoutError, skipped: Boolean(err.skipped) })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model)
      emitProgress()
    }

    results.push(perModel)
    const config = await recordModelConfig(model, 'vision')
    const intro = [
      `Configuration : ${config}, réflexion désactivée (comme look_at_screen et computer_use_task), contexte ${CONVERSATION_NUM_CTX}.`,
      `Lecture : ${perModel.correct - pilotOk}/${VISION_TEST_CASES.length * VISION_REPEATS} ; visée (pilotage de l'écran) : ${pilotOk}/${VISION_PILOT_CASES.length * VISION_REPEATS}.`,
      ''
    ]
    conversationDetails.set(`${model} (vision)`, formatConversationDetail(`${model} (vision)`, perModel, visionDetail, VISION_REPEATS, [], intro.filter(Boolean)))
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()

    await releaseAfterLastTest(model, 'vision')
  }

  // Modèles Code : une seule passe de génération par cas (pas de critique/réparation) — « juste » = l'application
  // générée, ouverte dans le navigateur avec les règles de l'aperçu de Jaris, fait vraiment ce qui est demandé.
  for (const model of codeToRun) {
    const readyCode = await ensureReady(model)
    if (!readyCode) {
      console.log(`##MODEL_SKIPPED## ${model} ${skipReasons.get(model) ?? ''}`.trimEnd())
      continue
    }
    console.log(`\n=== ${model} (code) ===`)
    console.log(`##MODEL_TESTING## ${model}`)
    const perModel = { model, role: 'code', latencies: [], speeds: [], correct: 0, total: 0 }
    const guard = timeoutGuard()
    const codeDetail = CODE_TEST_CASES.map((c) => ({ prompt: `${c.id} — ${c.prompt}`, expectedTool: undefined, missed: 0, got: [], answers: [] }))
    const raw = []

    for (const [index, testCase] of CODE_TEST_CASES.entries()) {
      const { prompt } = testCase
      process.stdout.write(`  « ${testCase.id} » ... `)
      perModel.total++
      // Hors du try : si l'ouverture dans le navigateur plante APRÈS la génération, le code généré est gardé quand
      // même (relecture ChatGPT : ne rien perdre de ce qui ne se régénère pas à l'identique).
      let r = null
      let html = null
      // Chaque geste du navigateur automatique (clic, saisie, lecture de l'écran), écrit avec le verdict.
      const steps = []
      try {
        guard.check()
        r = await chatCode(model, prompt)
        guard.passed()
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)

        html = extractHtml(r.content)
        // Relecture ChatGPT (v0.28.2) : la génération est écrite AVANT d'ouvrir le navigateur. Une panne du navigateur
        // (qui arrête le test) ou un PC éteint pendant la vérification ne fait plus perdre une génération de
        // plusieurs minutes, qui ne se refait jamais à l'identique. La ligne « code » complète suit le verdict.
        trace({
          type: 'code-generation',
          model,
          id: testCase.id,
          ms: Math.round(r.wallMs),
          think: r.think,
          prompt,
          systemRef: textRef(CODE_GENERATE_SYSTEM_PROMPT),
          response: r.data.message ?? null,
          meta: ollamaMeta(r.data),
          html
        })
        const issues = html ? validateGeneratedHtml(html) : []
        const verdict = html ? await checkInBrowser(testCase, html, steps) : 'pas de code HTML exploitable dans la réponse'
        const reason = verdict === null ? null : verdict + cutNote(r.data)
        const ok = reason === null
        if (ok) perModel.correct++
        else {
          codeDetail[index].missed++
          codeDetail[index].got.push(reason)
        }
        codeDetail[index].answers.push(
          `${ok ? 'compté juste' : `compté faux (${reason})`}${issues.length ? ` — relecture du fichier : ${issues.join(' ; ')}` : ''}` +
            (steps.length ? ` — gestes : ${steps.join(' → ')}` : '')
        )
        // Le HTML entier : pour revérifier l'application plus tard (vérification corrigée) sans la régénérer.
        raw.push({ id: testCase.id, ok, reason, html: html ?? r.content })
        trace({
          type: 'code',
          model,
          id: testCase.id,
          ok,
          reason,
          issues,
          ms: Math.round(r.wallMs),
          think: r.think,
          prompt,
          systemRef: textRef(CODE_GENERATE_SYSTEM_PROMPT),
          response: r.data.message ?? null,
          meta: ollamaMeta(r.data),
          html,
          steps,
          previewCsp: PREVIEW_CSP_FOR_TEST
        })
        console.log(`${ok ? 'OK' : `RATÉ (${reason})`} — ${fmt(r.wallMs / 1000)} s, ${fmt(r.tokPerSec)} tok/s`)
      } catch (err) {
        // Ollama injoignable : l'analyse s'arrête AVANT d'enregistrer ce modèle (jamais un faux score).
        if (err instanceof OllamaDownError || err instanceof BrowserDownError) throw err
        guard.failed(err)
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
        codeDetail[index].missed++
        codeDetail[index].got.push(`erreur : ${err.message}`)
        codeDetail[index].answers.push(`compté faux : erreur : ${err.message}`)
        raw.push({ id: testCase.id, ok: false, reason: `erreur : ${err.message}`, html: html ?? r?.content ?? null })
        trace({
          type: 'code',
          model,
          id: testCase.id,
          ok: false,
          reason: `erreur : ${err.message}`,
          timeout: err instanceof CallTimeoutError,
          skipped: Boolean(err.skipped),
          steps,
          ...(r ? { ms: Math.round(r.wallMs), think: r.think, prompt, response: r.data.message ?? null, meta: ollamaMeta(r.data), html } : {})
        })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
      weightDone += testWeightOf(model) * CODE_WEIGHT
      emitProgress()
    }

    results.push(perModel)
    const config = await recordModelConfig(model, 'code')
    conversationDetails.set(`${model} (code)`, formatConversationDetail(`${model} (code)`, perModel, codeDetail, 1, [], [`Configuration : ${config}, réflexion « high » (comme le mode Code), contexte 16384.`]))
    codeRaw.set(model, JSON.stringify(raw))
    console.log(`##MODEL_DONE## ${model} ${perModel.correct} ${perModel.total}`)
    persistResults()
    await releaseAfterLastTest(model, 'code')
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

main().catch((err) => {
  console.log(`\n${err instanceof OllamaDownError || err instanceof BrowserDownError ? err.message : `Erreur : ${err.message}`}`)
  process.exit(1)
})
