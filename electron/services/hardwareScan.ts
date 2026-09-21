import { exec } from 'child_process'
import { readFileSync } from 'fs'
import { resourcesRoot } from '../paths'
import { join } from 'path'
import { promisify } from 'util'
import { RESOURCE_SAFETY_MARGIN_GB, detectRamGb } from './systemResources'
import { getInstalledModelSizeBytes, getModelInfo } from './ollama'
import type {
  CapacityScanResult,
  ContextLengthOptions,
  HardwareTierPreview,
  ModelOverviewEntry,
  ModelOverviewResult,
  ModelTiers,
  Profile
} from '../../shared/ipc'

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
  // ministral-3:3b/8b/14b (Mistral AI, Apache 2.0) ajoutés suite à une recherche externe demandée par Léo
  // ("cherche meilleur model... regarde benchmark arena"), PAS pris à sa parole — tailles/architecture/
  // support vision+tools revérifiés directement sur ollama.com/library/ministral-3/tags (3b: 3,0 Go dense,
  // 8b: 6,0 Go, 14b: 9,1 Go, tous "Text, Image" natif) et les bugs cités confirmés réels sur
  // github.com/ollama/ollama (voir MEDIUM_CANDIDATES plus bas pour le détail complet). Le 3b, lui, a DÉJÀ un
  // vrai score mesuré sur la machine de Léo (6/6, `scripts/verified-tool-scores.md`) — pas juste informatif
  // en attente de test, déjà confirmé fiable pour de vrai. Rejoint Rapide.
  { model: 'ministral-3:3b', vramGb: 3.0 },
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
// gemma4:12b et granite4.1:8b ajoutés après vérification directe sur ollama.com/library (proposés par une
// IA externe via le prompt de recherche du journal des mises à jour, PAS pris à sa parole) :
// - gemma4:12b (tag réel confirmé, 7,6 Go) : entre gemma4:e4b et qwen3.5:9b en taille, nativement
//   multimodal comme gemma4:e4b (donc aussi ajouté à VISION_CANDIDATES plus bas).
// - granite4.1:8b (tag réel confirmé, 5,3 Go, licence Apache 2.0) : PAS "ibm/granite4.1:8b" comme proposé —
//   ce préfixe n'existe pas dans la bibliothèque officielle Ollama (`granite4.1:8b` tout court), l'utiliser
//   aurait risqué de tirer une requantification tierce non vérifiée d'un namespace communautaire au lieu du
//   modèle officiel IBM.
// Deux autres propositions de la même IA rejetées : llama3.2:1b (présenté à tort comme "récent 2026" —
// c'est un modèle Meta de septembre 2024, largement dépassé par qwen3:1.7b déjà en place) et
// deepseek-r1:1.5b/32b (appel d'outils cassé sur Ollama malgré le badge "tools" affiché — bug connu,
// voir github.com/ollama/ollama/issues/10935 — rédhibitoire puisque Jaris appelle un outil à chaque action).
// granite4.2:8b/3b (IBM, sorti le 25/08/2026, Apache 2.0, tags réels confirmés sur ollama.com/library —
// 5,3 Go et 2,2 Go, quasi identiques en taille à granite4.1) : ajoutés à CÔTÉ de granite4.1, PAS à leur
// place, contrairement au remplacement direct granite4:3b -> granite4.1:3b fait plus haut dans l'historique
// de ce fichier — cette fois granite4.1:8b/3b ont un vrai score d'appel d'outils mesuré (6/6, voir
// verified-tool-scores.md, mesuré sur la machine de Léo début septembre 2026), alors que 4.2 n'a encore
// aucune mesure : les remplacer perdrait une preuve réelle au profit d'un chiffre encore jamais vérifié.
const MEDIUM_CANDIDATES: ModelCandidate[] = [
  { model: 'gemma4:e4b', vramGb: 9.6 },
  // ministral-3:14b/8b (voir FLASH_CANDIDATES plus haut pour le contexte de cet ajout) : function calling
  // natif annoncé par Mistral, mais un bug OUVERT (github.com/ollama/ollama/issues/13750) fait ignorer les
  // outils quand `response_format`/`format` est envoyé EN MÊME TEMPS que `tools` sur une instance Ollama
  // auto-hébergée. VÉRIFIÉ dans ollama.ts : Jaris n'envoie JAMAIS `format` en même temps que `tools`, sur
  // aucun appel — ce bug ne s'applique donc pas à l'usage réel de Jaris, contrairement à une réserve
  // générique. D'autres bugs Ministral existants (#13328/#13334, "plus de 2 outils" / appels multiples) sont
  // antérieurs et non reconfirmés sur les tailles ajoutées ici.
  { model: 'ministral-3:14b', vramGb: 9.1 },
  { model: 'gemma4:12b', vramGb: 7.6 },
  { model: 'qwen3.5:9b', vramGb: 6.6 },
  { model: 'ministral-3:8b', vramGb: 6.0 },
  { model: 'granite4.2:8b', vramGb: 5.3 },
  { model: 'granite4.1:8b', vramGb: 5.3 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  { model: 'granite4.2:3b', vramGb: 2.2 },
  { model: 'granite4.1:3b', vramGb: 2.1 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
]
const LARGE_CANDIDATES: ModelCandidate[] = [
  { model: 'qwen3.5:35b', vramGb: 24 },
  // Variante DENSE de la famille qwen3.6 (distincte de qwen3.6:35b-a3b, le MoE déjà en Code) : tag réel
  // confirmé sur ollama.com/library/qwen3.6/tags (vision+tools+thinking natifs, disponible en 27b et 35b —
  // qwen3.6:27b est déjà candidat plus bas). Taille EXACTE désormais confirmée (23 Go, ollama.com/library/
  // qwen3.6/tags) — remplace le poids "en attendant" de qwen3.5:35b utilisé jusqu'ici faute de chiffre réel
  // (revue complète des candidats, demande de Léo "revoire tous les model pour des meilleurs").
  { model: 'qwen3.6:35b', vramGb: 23 },
  { model: 'qwen3.5:27b', vramGb: 17 },
  // Ajouté après vérification directe sur ollama.com/library/qwen3.8 (18 Go, vision+tools+thinking natifs,
  // contexte 256K) suite à deux analyses externes (PDF fournis par Léo) le signalant comme successeur de
  // qwen3.5:27b — gain en code/agentic rapporté par des sources tierces uniquement (pas de chiffre MMLU-Pro
  // OFFICIEL trouvé à l'époque). Depuis (question de Léo, "pourquoi on regarde pas les vrais benchmarks pour
  // départager les 6/6 ?") : un score MMLU-Pro de 84.3 a été trouvé via BenchLM.ai — un agrégateur tiers, PAS
  // la fiche officielle Alibaba, donc à prendre avec la même réserve que les autres chiffres "sources
  // tierces" de ce fichier. Ajouté à INTELLIGENCE_MMLU_PRO plus bas malgré cette réserve, DÉLIBÉRÉMENT plus
  // bas que qwen3.5:27b (86.1) et qwen3.5:35b (85.3) déjà en place : ce chiffre ne confirme donc PAS le
  // "gain" rapporté par les PDF de Léo sur l'axe connaissance générale — seulement sur code/agentic (jamais
  // confirmé par un vrai chiffre comparatif ici, voir pickBestFrom dans computeModelPicks : le départage
  // entre candidats à 6/6 utilise maintenant MMLU-Pro quand les deux le connaissent, VRAM sinon).
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
  // granite4.2:30b (IBM, sorti le 25/08/2026, Apache 2.0) : tag réel confirmé sur ollama.com/library/
  // granite4.2/tags (18 Go, tools natifs, 128K contexte) — voir MEDIUM_CANDIDATES plus haut pour le
  // raisonnement complet sur pourquoi granite4.1 reste en parallèle plutôt que d'être remplacé.
  { model: 'granite4.2:30b', vramGb: 18 },
  { model: 'gemma4:26b', vramGb: 19 },
  { model: 'gpt-oss:20b', vramGb: 14 },
  // Command R (Cohere) : orienté RAG/tool-use long contexte (128K), tools confirmés. Vérifié sur
  // ollama.com/library/command-r (19 Go).
  { model: 'command-r:35b', vramGb: 19 },
  // Mistral Small : la conclusion précédente ("3.1"/"3.2" n'existent pas sous ce nom sur Ollama") était
  // FAUSSE — vérifiée à nouveau sur ollama.com/library/mistral-small3.2 (revue des 5 listes de candidats,
  // demande de Léo "regarde lm studio... fait tes analyse de ton coté") : mistral-small3.2:24b est un tag
  // officiel distinct, 15 Go, qui améliore explicitement l'appel d'outils par rapport à la version utilisée
  // jusqu'ici (`mistral-small:24b`, en réalité l'ancienne Mistral Small 3/2501, jamais versionnée 3.1/3.2,
  // 32K de contexte seulement, texte uniquement) et ajoute la vision + un contexte de 128K. Remplacé : aucune
  // raison de garder l'ancienne version une fois la bonne trouvée.
  { model: 'mistral-small3.2:24b', vramGb: 15 },
  // GLM-4.7-Flash (Zhipu/Z.ai) : plus récent que GLM-4.6V-Flash déjà en Vision (2 mois vs plus ancien),
  // tools+thinking, texte seul. Vérifié sur ollama.com/library/glm-4.7-flash/tags (tag q4_K_M, 19 Go).
  // Réexaminé (même revue que Mistral Small ci-dessus) : plusieurs bugs OFFICIELS (github.com/ollama/ollama,
  // issues #13840/#13820/#14273/#16497, de janvier à juin 2026, jamais dits résolus) montrent que l'appel
  // d'outils peut casser en cours de conversation avec CE modèle précis sur Ollama — même famille de risque
  // que DeepSeek-R1 (déjà exclu plus haut pour la même raison). Léo, informé, a choisi de le garder : le vrai
  // test de Jaris est passé 6/6 sur sa machine (verified-tool-scores.md), aucun signalement réel ici — à
  // retirer si un vrai échec d'appel d'outils avec ce modèle est un jour rapporté en usage réel.
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
  'qwen3.6:35b',
  'qwen3.5:27b',
  'qwen3.8:27b',
  'qwen3.6:27b',
  'granite4.2:30b',
  'gemma4:26b',
  'gpt-oss:20b',
  'command-r:35b',
  'mistral-small3.2:24b',
  'glm-4.7-flash:q4_K_M',
  'qwen3.6:35b-a3b',
  'qwen3-coder:30b',
  'north-mini-code-1.0',
  'qwen2.5-coder:32b',
  'devstral-small-2:24b',
  // devstral-2:123b et qwen3-coder-next (CODE_CANDIDATES, 75 et 52 Go) : encore plus indispensable ici que
  // pour les autres candidats Code — aucun GPU grand public n'a assez de VRAM à lui seul pour les atteindre,
  // seule la RAM système les rend joignables du tout.
  'devstral-2:123b',
  'qwen3-coder-next'
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
  // gemma4:31b (Google, Apache 2.0) : ajouté suite à la même recherche externe que ministral-3 ci-dessus,
  // vérifié directement sur ollama.com/library/gemma4:31b (20 Go, 31,3 Md de paramètres DENSE, vision
  // native "Text, Image", ~550M de paramètres dans l'encodeur visuel). Volontairement PAS ajouté en
  // Médium/Puissant/Code : plusieurs bugs de parsing d'appel d'outils OUVERTS sur toute la famille Gemma 4
  // (github.com/ollama/ollama/issues/18390, #17888, #15539 — clés d'objet sans guillemets, séparateur `=`
  // non géré, appel abandonné sur un accolade manquante) rendent l'appel d'outils non fiable pour ce
  // modèle sur Ollama ; la Vision n'a pas cette exigence (look_at_screen ne rappelle pas d'outil depuis ce
  // modèle). En tête de liste (le plus gros candidat vision) : l'ordre doit rester strictement décroissant.
  { model: 'gemma4:31b', vramGb: 20 },
  // Même candidat "réutilisation" que gemma4:e4b/gemma4:12b plus bas, mais pour gemma4:26b (déjà dans
  // LARGE_CANDIDATES, palier Puissant) — signalé par Léo, vérifié directement sur ollama.com/library/gemma4 :
  // le tag `gemma4:26b` porte bien le badge "Text, Image" (vision native), pas seulement les tags plus
  // petits de la famille.
  { model: 'gemma4:26b', vramGb: 19 },
  // Candidat "réutilisation" : gemma4:e4b (déjà dans MEDIUM_CANDIDATES) est NATIVEMENT multimodal (vérifié
  // sur ollama.com/library/gemma4 : badge vision+tools+thinking), donc candidat légitime pour la vision
  // aussi — pas juste un modèle de conversation qu'on force à faire autre chose. Intérêt concret : s'il tient
  // tête à un qwen3-vl/GLM dédié sur VISION_TEST_CASES, Jaris pourrait un jour réutiliser le modèle de
  // conversation déjà chargé pour look_at_screen, sans jamais charger un second modèle (zéro swap VRAM). Pas
  // encore le cas aujourd'hui : resolveVisionModel continue de choisir dans cette liste normalement, ce test
  // sert juste à savoir si ça vaudrait le coup.
  { model: 'gemma4:e4b', vramGb: 9.6 },
  { model: 'qwen3-vl:8b', vramGb: 8 },
  // Même candidat "réutilisation" que gemma4:e4b ci-dessus, mais pour gemma4:12b (déjà dans
  // MEDIUM_CANDIDATES, tag réel confirmé sur ollama.com/library/gemma4).
  { model: 'gemma4:12b', vramGb: 7.6 },
  // Pas de tag officiel dans la bibliothèque Ollama : import depuis le dépôt GGUF de ggml-org (mainteneurs
  // de llama.cpp), à partir du modèle officiel zai-org/GLM-4.6V-Flash. Le tag Q4_K_M est important : les
  // autres quantifications communautaires (Q2_K, Q3_K) sont purement textuelles, sans le module de vision.
  // ~6,2 Go mesurés en Q4_K_M, marge de sécurité incluse ci-dessous.
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  // Candidat "réutilisation" : ministral-3:8b (déjà dans MEDIUM_CANDIDATES) est NATIVEMENT multimodal
  // (vérifié sur ollama.com/library/ministral-3, badge "Text, Image"). Aucune exigence de tool-calling ici
  // (voir gemma4:31b plus haut) : la réserve response_format+tools qui vaut pour son usage en Médium ne
  // s'applique pas à ce rôle.
  { model: 'ministral-3:8b', vramGb: 6.0 },
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
  // devstral-2:123b (Mistral AI) et qwen3-coder-next (Alibaba) : ajoutés suite à la même recherche externe
  // que ministral-3/gemma4:31b ci-dessus, réservés aux très grosses machines (VRAM+RAM, LARGE_RAM_OFFLOAD_MODELS
  // plus bas — aucun GPU grand public n'a 52-75 Go de VRAM à lui seul).
  // - devstral-2:123b : vérifié sur ollama.com/library/devstral-2:123b (75 Go en Q4_K_M — la page indique
  //   "125B parameters" alors que le tag dit "123b" ; probablement le nombre de paramètres actifs/publiés
  //   diffère légèrement du nom commercial, sans lien avec un bug — le tag Ollama exact reste `devstral-2:123b`).
  //   DENSE, orienté agents de code (SWE-Bench Verified ~72%). Licence Mistral (usage commercial limité pour
  //   les grandes entreprises, sans effet pour Jaris). Aucun bug Ollama de tool-calling trouvé pour ce modèle
  //   précis au moment de la recherche — contrairement à Devstral Small 2 (24b), qui a des soucis de
  //   paramètres d'outils connus dans sa propre famille : garder un œil dessus via "Lancer l'analyse".
  // - qwen3-coder-next : vérifié sur ollama.com/library/qwen3-coder-next (52 Go en q4_K_M, 80 Md total/
  //   3 Md actifs MoE, appel d'outils annoncé "out of the box" pour agents de code). Ne remplace pas
  //   qwen3.6:35b-a3b déjà en tête (pas de gain confirmé sur TOUS les benchmarks de code), plutôt un
  //   complément haut de gamme pour le travail agentique sur de grosses bases de code.
  { model: 'devstral-2:123b', vramGb: 75 },
  { model: 'qwen3-coder-next', vramGb: 52 },
  { model: 'qwen3.6:35b-a3b', vramGb: 22 },
  { model: 'qwen3-coder:30b', vramGb: 19 },
  { model: 'north-mini-code-1.0', vramGb: 19 },
  { model: 'qwen2.5-coder:32b', vramGb: 20 },
  // Mistral, agent de code autonome (exploration de dépôt, édition multi-fichiers). DENSE comme
  // qwen2.5-coder:32b ci-dessus (pas de "-a3b"/MoE dans son nom) : même remarque, débordement RAM plus
  // pénalisant qu'un MoE de taille comparable. Vérifié sur ollama.com/library/devstral-small-2 (15 Go).
  { model: 'devstral-small-2:24b', vramGb: 15 },
  // Palier intermédiaire entre 32b et 7b ci-dessous, absent jusqu'ici (relecture Codex, étape 46) : taille
  // vérifiée sur ollama.com/library/qwen2.5-coder:14b (9 Go).
  { model: 'qwen2.5-coder:14b', vramGb: 9 },
  { model: 'qwen2.5-coder:7b', vramGb: 4.7 }
]

// Revue complète des 5 listes ci-dessus (demande de Léo, "revoire tous les model pour des meilleurs") :
// aucune famille majeure manquante trouvée par rapport à ce qui est déjà candidat quelque part dans ce
// fichier. Vérifié en particulier : pas de Qwen4 stable publié à ce jour (Qwen3.8-Flash-Next n'est qu'un
// aperçu d'architecture, 125 Md de paramètres, MLX UNIQUEMENT — inutilisable sur les GPU NVIDIA visés ici) ;
// pas de Gemma 5 ni de Granite 4.3 publiés (Gemma4/Granite4.1 déjà candidats restent les dernières versions
// réelles) ; qwen3.6:35b recalé au vrai poids (23 Go, voir son commentaire dans LARGE_CANDIDATES) au lieu du
// placeholder précédent. Deux suggestions d'agrégateurs externes examinées et REJETÉES : "Qwen3 8B" (~4,8
// Go, sans le ".5") ignoré comme déjà dépassé par qwen3.5:9b (même éditeur, génération plus récente, déjà
// candidat Médium) ; "Hermes 4 14B" introuvable comme modèle OFFICIEL sur ollama.com — recherche sur
// ollama.com/search?q=hermes ne remonte que Hermes 3 (Nous Research, officiel) et divers "Hermes 4.x" dans
// des espaces de noms COMMUNAUTAIRES non vérifiés (ericli1018, steelpuddles, MonomythDevelopment...), jamais
// le fabricant d'origine — même risque déjà écarté ailleurs dans ce fichier (voir granite4.1:8b) d'importer
// une requantification tierce non vérifiée à la place du modèle officiel.
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

// Curseur de longueur de contexte (Options -> Modèles, demande de Léo : "jaris voit les model et regarde
// la vram et propose une barre comme sur ollama mais qui est personnaliser a chacun pour que le dernier ne
// dépasse pas la vram") — même idée que le curseur "Context length" de l'app Ollama (capture envoyée par
// Léo), sauf que le MAXIMUM du curseur est calculé pour cette machine plutôt que de monter jusqu'à 256k
// pour tout le monde. Le palier "Puissant" (le plus gros modèle de conversation, donc celui qui laisse le
// MOINS de VRAM libre pour le cache K/V) sert de référence : si un contexte donné tient pour lui, il tient
// forcément aussi pour Rapide/Médium (modèles plus petits, donc plus de marge), ce qui évite de calculer
// les 3 paliers séparément pour un seul curseur global.

/**
 * Mêmes paliers que le curseur "Context length" d'Ollama (capture de Léo), moins son plancher de 4096 —
 * étape 118, après le retour de Léo sur un test de "palier 4" (le curseur donnant alors 4096 ou une valeur
 * interpolée proche) qui a produit des réponses incohérentes/hallucinées avec un ami. Mesuré ailleurs dans ce
 * fichier (config.ts, OLLAMA_NUM_CTX) : le système prompt + la liste d'outils (TOOLS, tools.ts) consomment à
 * eux seuls environ 4200-4500 tokens AVANT même le premier message — 4096 ne peut donc même pas contenir le
 * prompt système, laissant zéro place pour la conversation elle-même, ce qui explique le comportement erratique
 * observé. 8192 est déjà le plancher par défaut retenu ailleurs pour cette même raison : il devient aussi le
 * plancher de ce curseur, pour ne plus jamais pouvoir en sélectionner un plus bas.
 */
export const CONTEXT_LENGTH_STEPS = [8192, 16384, 32768, 65536, 131072, 262144]

/**
 * Format générique du champ `model_info` renvoyé par `POST /api/show` (getModelInfo, ollama.ts) : les clés
 * sont préfixées par l'ARCHITECTURE du modèle ("llama.block_count", "qwen3.attention.head_count_kv",
 * "gemma3.embedding_length"...), jamais un nom fixe — lues par SUFFIXE plutôt que par une liste
 * d'architectures connues à maintenir à la main à chaque nouvelle famille de modèle (même raisonnement que
 * le retry sans `think` dans ollama.ts, déjà motivé par la même fragilité).
 */
export interface ModelArchInfo {
  blockCount: number
  headCount: number
  headCountKv: number
  embeddingLength: number
  /** Taille de contexte maximale supportée par LE MODÈLE LUI-MÊME — jamais dépassée, même si la VRAM le permettrait. */
  maxContextLength: number
}

export function parseModelArchInfo(modelInfo: Record<string, unknown> | null): ModelArchInfo | null {
  if (!modelInfo) return null
  const find = (suffix: string): number | null => {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith(suffix) && typeof value === 'number' && Number.isFinite(value)) return value
    }
    return null
  }
  const blockCount = find('.block_count')
  const headCount = find('.attention.head_count')
  const headCountKv = find('.attention.head_count_kv')
  const embeddingLength = find('.embedding_length')
  const maxContextLength = find('.context_length')
  if (blockCount == null || headCount == null || headCountKv == null || embeddingLength == null || maxContextLength == null) {
    return null
  }
  return { blockCount, headCount, headCountKv, embeddingLength, maxContextLength }
}

/**
 * Octets de VRAM consommés par le cache K/V pour UN token de contexte en plus. Formule standard des
 * transformeurs : 2 (clé + valeur) x nombre de couches x têtes K/V (PAS les têtes d'attention — l'attention
 * groupée/GQA partage les mêmes clés-valeurs entre plusieurs têtes de requête, d'où head_count_kv <
 * head_count sur la plupart des modèles récents) x dimension d'une tête (embedding_length / head_count,
 * jamais fournie telle quelle par Ollama) x 2 octets par valeur (cache par défaut d'Ollama en f16 — Jaris ne
 * configure jamais OLLAMA_KV_CACHE_TYPE, donc jamais q8_0/q4_0 en pratique ici).
 */
export function kvCacheBytesPerToken(arch: ModelArchInfo): number {
  const BYTES_PER_KV_VALUE_F16 = 2
  const headDim = arch.embeddingLength / arch.headCount
  return 2 * arch.blockCount * arch.headCountKv * headDim * BYTES_PER_KV_VALUE_F16
}

/**
 * Contexte maximum (en tokens, PAS encore arrondi à un palier de CONTEXT_LENGTH_STEPS) qui tient dans la
 * VRAM LIBRE actuelle une fois le poids du modèle déduit, sans jamais dépasser ce que le modèle supporte
 * nativement. `freeVramGb` doit être une mesure RÉELLE et récente (getLiveGpuStatus), pas un budget
 * théorique — même marge de sécurité que le reste de ce fichier pour ce genre de calcul (LIVE_SAFETY_MARGIN_GB).
 */
export function computeMaxSafeContext(arch: ModelArchInfo, modelWeightVramGb: number, freeVramGb: number): number {
  const availableForKvGb = freeVramGb - LIVE_SAFETY_MARGIN_GB - modelWeightVramGb
  if (availableForKvGb <= 0) return 0
  const GB = 1024 ** 3
  const maxTokensFromVram = Math.floor((availableForKvGb * GB) / kvCacheBytesPerToken(arch))
  return Math.min(arch.maxContextLength, maxTokensFromVram)
}

/**
 * Le plus grand palier de CONTEXT_LENGTH_STEPS qui tient dans `maxSafeTokens` — jamais en dessous du plus
 * petit palier (8192 depuis l'étape 118, le plancher déjà retenu pour OLLAMA_NUM_CTX dans config.ts, seul
 * budget qui laisse de la place à la fois pour le système prompt + les outils et pour une vraie conversation)
 * même si le calcul VRAM tombe encore plus bas : mieux vaut proposer ce plancher que de renvoyer 0.
 */
export function roundDownToContextStep(maxSafeTokens: number): number {
  let result = CONTEXT_LENGTH_STEPS[0]
  for (const step of CONTEXT_LENGTH_STEPS) {
    if (step <= maxSafeTokens) result = step
  }
  return result
}

/** Nombre minimum de paliers à toujours proposer sur le curseur, voir computeAvailableSteps ci-dessous. */
const MIN_CONTEXT_CHOICES = 4

/**
 * Les paliers du curseur pour un `max` donné (étape 117, Léo, capture à l'appui : "il ya écrit 4k8k
 * coller... essaye de proposer plusieurs choix pas 2 il en faut 4"). Sur une machine dont la VRAM ne laisse
 * de la place que pour les deux ou trois premiers doublements d'Ollama (4k, 8k[, 16k]), filtrer
 * CONTEXT_LENGTH_STEPS ne laissait parfois que 2 valeurs — les deux graduations se retrouvaient alors
 * collées l'une à l'autre sur le curseur (voir aussi le correctif CSS de `.options-menu__row-control`,
 * index.css, qui réglait la moitié visuelle du même symptôme).
 *
 * D'abord les paliers "ronds" de CONTEXT_LENGTH_STEPS qui tiennent (les mêmes que le curseur d'Ollama) ;
 * s'il en manque pour atteindre MIN_CONTEXT_CHOICES, complétés par des paliers intermédiaires — multiples
 * de 1024, donc toujours un "Xk" propre avec formatContextLength — régulièrement espacés entre le plancher
 * (8192 depuis l'étape 118, jamais en dessous) et `max`. Aucun de ces paliers intermédiaires ne dépasse
 * jamais `max` : ils ne rendent rien de MOINS sûr que ce que `max` autorisait déjà, ils remplissent
 * seulement l'intervalle. Si `max` vaut déjà le plancher lui-même (aucune marge du tout), il n'y a rien à
 * ajouter : un seul palier existe, point final.
 */
export function computeAvailableSteps(max: number): number[] {
  const fromLadder = CONTEXT_LENGTH_STEPS.filter((s) => s <= max)
  const floor = CONTEXT_LENGTH_STEPS[0]
  if (fromLadder.length >= MIN_CONTEXT_CHOICES || max <= floor) return fromLadder

  const GRANULARITY = 1024
  const steps = new Set(fromLadder)
  steps.add(floor)
  steps.add(max)
  for (let i = 1; i < MIN_CONTEXT_CHOICES - 1; i++) {
    const raw = floor + ((max - floor) * i) / (MIN_CONTEXT_CHOICES - 1)
    steps.add(Math.round(raw / GRANULARITY) * GRANULARITY)
  }
  return [...steps].sort((a, b) => a - b)
}

/**
 * Calcule le curseur pour l'onglet Modèles : `model` doit être le modèle du palier PUISSANT (le plus gros
 * modèle de conversation configuré, donc celui qui laisse le moins de VRAM libre pour le cache K/V — voir le
 * commentaire en tête de section). Recalculé à CHAQUE ouverture de l'onglet (jamais mis en cache) : la VRAM
 * libre change d'un lancement à l'autre selon ce qui tourne en parallèle sur la machine.
 *
 * Si la moindre donnée réelle manque (Ollama injoignable, modèle pas installé, architecture non reconnue),
 * le repli est TOUJOURS le palier déjà en usage aujourd'hui — jamais un maximum optimiste inventé faute de
 * mieux : proposer plus de marge sans preuve serait exactement le genre d'hypothèse non vérifiée que ce
 * dépôt a appris à ses dépens à ne jamais présenter comme un fait (voir la saga SearXNG, CLAUDE.md).
 */
export async function computeContextLengthOptions(model: string, currentContext: number): Promise<ContextLengthOptions> {
  const fallbackMax = roundDownToContextStep(currentContext)
  const fallback: ContextLengthOptions = {
    current: fallbackMax,
    max: fallbackMax,
    availableSteps: computeAvailableSteps(fallbackMax)
  }

  const [{ freeVramGb }, modelInfo, weightBytes] = await Promise.all([
    getLiveGpuStatus(),
    getModelInfo(model).catch(() => null),
    getInstalledModelSizeBytes(model).catch(() => null)
  ])
  const arch = parseModelArchInfo(modelInfo)
  if (freeVramGb === null || !arch || weightBytes === null) return fallback

  const modelWeightVramGb = weightBytes / 1024 ** 3
  const maxSafe = roundDownToContextStep(computeMaxSafeContext(arch, modelWeightVramGb, freeVramGb))
  const max = Math.max(maxSafe, CONTEXT_LENGTH_STEPS[0])
  return {
    current: Math.min(fallbackMax, max),
    max,
    availableSteps: computeAvailableSteps(max)
  }
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
  'qwen3.6:35b-a3b': 85.2,
  // Source : BenchLM.ai (agrégateur tiers, PAS la fiche officielle Alibaba — voir le commentaire sur
  // qwen3.8:27b dans LARGE_CANDIDATES plus haut pour le contexte complet). Volontairement inférieur à
  // qwen3.5:27b/qwen3.5:35b ci-dessus : ce chiffre ne confirme PAS un gain de connaissance générale, jamais
  // à prendre pour argent comptant sans vérification sur une fiche officielle si l'écart avec un autre
  // chiffre ici devient un jour déterminant pour un choix de modèle.
  'qwen3.8:27b': 84.3
}

/**
 * Artificial Analysis Intelligence Index officiel, relevé directement sur artificialanalysis.ai le
 * 21/09/2026 (méthodologie v4.3.2) — étape 122 : Léo a rempli une bonne partie de ce tableau lui-même
 * (page "Tous les modèles", système d'édition manuelle d'une version précédente), demandant ensuite de
 * finir la recherche pour les modèles restants puis de retirer la possibilité d'éditer — cette table
 * remplace donc à la fois l'ancienne version (15 modèles) et le système d'édition manuelle (revert complet,
 * voir externalScoresStore.ts dans l'historique du dépôt). Pour les familles proposant deux variantes, on
 * reprend la variante Reasoning, celle qui correspond au mode de réflexion employé par Jaris. Absence ici =
 * Artificial Analysis n'a pas publié de score pour ce modèle EXACT (vérifié un par un, jamais un
 * rapprochement approximatif ni un chiffre repris d'un agrégateur tiers).
 *
 * **Correction, étape 125 — Léo : "mais on est d'accord que Qwen3.6 35B A3B c'est qwen3.6 35b ?"** : la
 * version précédente de ce commentaire affirmait que `qwen3.5:35b`/`qwen3.6:35b` (les tags utilisés par
 * Jaris) étaient des variantes DENSES différentes de `qwen3.6:35b-a3b`, sans fiche Artificial Analysis
 * dédiée. C'était FAUX — vérifié cette fois directement sur ollama.com/library/qwen3.6/tags et
 * ollama.com/library/qwen3.5/tags (le digest du fichier, pas juste son nom) : `qwen3.6:35b` et
 * `qwen3.6:35b-a3b` partagent EXACTEMENT le même digest (096fdbd02fe6, 23 Go) — ce sont deux ÉTIQUETTES pour
 * le MÊME fichier, jamais deux modèles différents ; même chose pour `qwen3.5:35b`/`qwen3.5:35b-a3b`
 * (3460ffeede54, 24 Go). Il n'existe donc pas de variante "dense" séparée à ces tailles chez Qwen3.5/3.6 :
 * le tag court (`:35b`) est un simple alias du tag complet (`:35b-a3b`). La fiche Artificial Analysis de la
 * variante A3B s'applique donc bien telle quelle aux deux tags. Leçon retenue : une absence de fiche dédiée
 * pour un NOM ne prouve pas l'absence d'un modèle — toujours vérifier le DIGEST du fichier avant de conclure
 * que deux tags désignent des modèles différents, pas seulement leurs noms.
 *
 * À fiabilité égale, ce score départage deux modèles exacts couverts ; MMLU-Pro reste le repli quand cette
 * comparaison officielle n'est pas possible.
 */
const ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX: Record<string, number> = {
  'qwen3.5:0.8b': 6,
  'qwen3.5:2b': 7,
  'qwen3.5:4b': 13,
  'qwen3.5:9b': 14,
  'qwen3.5:27b': 23,
  'qwen3.5:35b': 19,
  'qwen3.6:27b': 21,
  'qwen3.6:35b': 18,
  'qwen3.6:35b-a3b': 18,
  'qwen3.8:27b': 34,
  'gpt-oss:20b': 9,
  'gemma4:12b': 14,
  'gemma4:26b': 17,
  'gemma4:31b': 19,
  'gemma4:e4b': 9,
  'ministral-3:14b': 6,
  'ministral-3:3b': 5,
  'granite4.1:3b': 6,
  'granite4.2:3b': 9,
  'ministral-3:8b': 5,
  'granite4.2:8b': 11,
  'granite4.1:8b': 7,
  'mistral-small3.2:24b': 8,
  'granite4.2:30b': 15,
  // "(estimated)" sur la fiche Artificial Analysis elle-même (méthode d'estimation, pas une mesure directe
  // complète) — gardé tel quel, c'est le seul chiffre officiel publié pour ce modèle.
  'command-r:35b': 5,
  'qwen3:1.7b': 5,
  'glm-4.7-flash:q4_K_M': 15,
  'qwen3-vl:8b': 7,
  'qwen3-vl:4b': 6,
  'devstral-2:123b': 9,
  'qwen3-coder-next': 9,
  'qwen3-coder:30b': 10,
  'north-mini-code-1.0': 10,
  'qwen2.5-coder:32b': 7,
  'devstral-small-2:24b': 8,
  'qwen2.5-coder:7b': 6
}

/**
 * Vitesse de génération (tokens/s) publiée par Artificial Analysis pour ce modèle — relevée en même temps
 * que ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX ci-dessus, le 21/09/2026, avec la même discipline (jamais un
 * chiffre estimé ou repris d'un agrégateur tiers). PAS la vitesse estimée par formule pour la machine de
 * l'utilisateur (`speedTokPerSec`, ModelOverviewEntry, calculée séparément par estimateSpeedTokPerSec) : une
 * mesure Artificial Analysis, indépendante du matériel de qui regarde. Absence ici = Artificial Analysis
 * publie l'Intelligence Index de ce modèle mais pas encore de mesure de vitesse fiable ("N/A" sur sa fiche).
 */
const ARTIFICIAL_ANALYSIS_SPEED: Record<string, number> = {
  'qwen3.5:4b': 19,
  'qwen3.5:9b': 56,
  'qwen3.5:27b': 75,
  'qwen3.5:35b': 148,
  'qwen3.6:27b': 60,
  'qwen3.6:35b': 115,
  'qwen3.6:35b-a3b': 115,
  'qwen3.8:27b': 47,
  'gpt-oss:20b': 168,
  'gemma4:12b': 114,
  'gemma4:31b': 35,
  'gemma4:e4b': 41,
  'ministral-3:14b': 87,
  'ministral-3:3b': 221,
  'granite4.2:3b': 218,
  'ministral-3:8b': 87,
  'granite4.2:8b': 94,
  'granite4.1:8b': 84,
  'mistral-small3.2:24b': 146,
  'granite4.2:30b': 73,
  'glm-4.7-flash:q4_K_M': 79,
  'qwen3-vl:8b': 109,
  'devstral-2:123b': 133,
  'qwen3-coder-next': 111,
  'qwen3-coder:30b': 87,
  'north-mini-code-1.0': 100,
  'devstral-small-2:24b': 131
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
    raw = readFileSync(join(resourcesRoot(), 'scripts', 'verified-tool-scores.md'), 'utf-8')
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
 * Relit scripts/benchmark-results.md (généré par `npm run benchmark:models`/le bouton "Lancer l'analyse",
 * voir ce script) s'il existe, pour remonter de vraies mesures faites sur LA machine de l'utilisateur plutôt
 * que des chiffres publiés génériques. Absent (jamais lancé) : renvoie des maps vides, sans faire échouer
 * l'aperçu pour autant. Exportée en plus de son usage dans getModelOverview ci-dessous : sert aussi à
 * benchmarkRunner.ts pour savoir quels modèles ont été testés lors du dernier run (et donc candidats à un
 * nettoyage après coup).
 *
 * **Trois maps séparées par palier (sections "## Conversation/Vision/Code" du fichier), PAS une seule map
 * globale par nom de modèle** — même correctif déjà appliqué à `parseVerifiedToolScores` ci-dessus pour
 * `verified-tool-scores.md`, ici étendu à son fichier jumeau qui l'avait manqué : `ministral-3:8b` (candidat
 * à la fois Médium et Vision, voir MEDIUM_CANDIDATES/VISION_CANDIDATES) a un score de 2/3 en Vision qui, une
 * fois testé LOCALEMENT lors du même run (bouton "Lancer l'analyse"), écrasait silencieusement son propre
 * score de conversation (sur 6) dans une map plate — repéré directement sur une capture d'écran envoyée par
 * Léo montrant "2/3" identique dans les deux paliers, jamais deviné. L'ancien format (une seule table sans
 * section) n'est plus reconnu : un `benchmark-results.md` généré par une version antérieure se lit comme
 * "rien de connu localement" (repli sûr sur verified-tool-scores.md/un re-test, jamais un score corrompu
 * affiché comme s'il était correct) plutôt que d'essayer de le deviner section par section.
 */
export function parseLocalBenchmark(): Record<VerifiedTier, Map<string, LocalBenchmarkEntry>> {
  const results: Record<VerifiedTier, Map<string, LocalBenchmarkEntry>> = {
    conversation: new Map(),
    vision: new Map(),
    code: new Map()
  }
  let raw: string
  try {
    raw = readFileSync(join(resourcesRoot(), 'scripts', 'benchmark-results.md'), 'utf-8')
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
    // v0.15.29 a brièvement ajouté une 5e colonne « Qualité locale ». Elle n'est plus utilisée, mais lire
    // encore ses fichiers évite de jeter les vrais scores de rôle déjà mesurés par cette version.
    if (cells.length !== 4 && cells.length !== 5) continue

    const [model, , speed, tool] = cells
    const speedNum = parseFloat(speed)
    results[currentTier].set(model, {
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
export async function getModelOverview(profile?: Profile | null): Promise<ModelOverviewResult> {
  const localBenchmark = parseLocalBenchmark()
  const verifiedToolScores = parseVerifiedToolScores()
  const { name: gpuName, vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), gpuName, localBenchmark, verifiedToolScores)
  const activeModels = {
    flash: profile?.models?.flash ?? picks.flash.model,
    medium: profile?.models?.medium ?? picks.medium.model,
    large: profile?.models?.large ?? picks.large.model,
    vision: profile?.visionModel ?? picks.vision.model,
    code: profile?.codeModel ?? picks.code.model
  }
  const usageByModel = new Map<string, string[]>()
  const addUsage = (model: string, label: string): void => {
    const labels = usageByModel.get(model) ?? []
    labels.push(label)
    usageByModel.set(model, labels)
  }
  addUsage(activeModels.flash, 'Rapide')
  addUsage(activeModels.medium, 'Médium')
  addUsage(activeModels.large, 'Puissant')
  addUsage(activeModels.vision, 'Vision')
  addUsage(activeModels.code, 'Code')

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
    const artificialAnalysisIndex = ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[model] ?? null
    const artificialAnalysisSpeed = ARTIFICIAL_ANALYSIS_SPEED[model] ?? null
    const local = localBenchmark[tier].get(model)
    if (local) {
      return { model, vramGb: modelVramGb, usedIn: usageByModel.get(model) ?? [], speedTokPerSec: local.speedTokPerSec, toolCalling: local.toolCalling, intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null, verifiedSkip, artificialAnalysisIndex, artificialAnalysisSpeed }
    }
    const verifiedTool = verifiedToolScores[tier].get(model)
    if (verifiedTool) {
      return {
        model,
        vramGb: modelVramGb,
        usedIn: usageByModel.get(model) ?? [],
        speedTokPerSec: estimateSpeedTokPerSec(modelVramGb, gpuName),
        speedEstimated: true,
        toolCalling: verifiedTool,
        intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null,
        verifiedSkip,
        artificialAnalysisIndex,
        artificialAnalysisSpeed
      }
    }
    return { model, vramGb: modelVramGb, usedIn: usageByModel.get(model) ?? [], speedTokPerSec: null, toolCalling: null, intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null, verifiedSkip, artificialAnalysisIndex, artificialAnalysisSpeed }
  }

  // Léo, sur la page "Tous les modèles" (Options → Modèles) : "fait pour rapide etc... celui qui faut le
  // moin de ram avec le plus pour tout" — chaque palier trié par VRAM CROISSANTE (le moins gourmand
  // d'abord), pour lire d'un coup d'œil le meilleur rapport capacité/VRAM sans avoir à comparer des chiffres
  // dispersés. PUREMENT un tri d'AFFICHAGE, sur une COPIE (`.map` renvoie déjà un nouveau tableau, `.sort`
  // le trie en place sans toucher à l'original) : `TIER_CANDIDATES`/`VISION_CANDIDATES`/`CODE_CANDIDATES`
  // eux-mêmes restent en ordre décroissant, l'ordre dont `pickBestFrom` (computeModelPicks, plus bas dans ce
  // fichier) a besoin pour choisir le VRAI modèle de Jaris — jamais reliés, une réponse à Léo confirmée avant
  // de coder : ce tri ne change RIEN au modèle réellement choisi, ni chez lui ni chez personne d'autre.
  const byAscendingVram = (entries: ModelOverviewEntry[]): ModelOverviewEntry[] => [...entries].sort((a, b) => a.vramGb - b.vramGb)

  const groups = [
    ...(Object.keys(TIER_CANDIDATES) as Tier[]).map((tier) => ({
      tier: TIER_LABELS[tier],
      entries: byAscendingVram(TIER_CANDIDATES[tier].map((c) => buildEntry(c.model, c.vramGb, 'conversation')))
    })),
    { tier: 'Vision', entries: byAscendingVram(VISION_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb, 'vision'))) },
    { tier: 'Code', entries: byAscendingVram(CODE_CANDIDATES.map((c) => buildEntry(c.model, c.vramGb, 'code'))) }
  ]

  return { vramGb, groups, codeModel: picks.code.model }
}

/**
 * Résultat connu pour UN candidat donné : une vraie mesure locale (benchmark-results.md) si elle existe,
 * sinon la fiabilité partagée (verified-tool-scores.md, valable pour tout le monde) combinée à une vitesse
 * estimée par formule pour CETTE machine — `undefined` si rien de connu du tout (jamais de chiffre inventé).
 * Extrait de computeModelPicks (pickBestFrom l'utilise pour départager les candidats) pour être réutilisé
 * tel quel par previewVramSteps ci-dessous : les deux doivent s'accorder EXACTEMENT sur "ce candidat a un
 * score connu ou non", sinon les frontières de VRAM affichées à l'écran d'accueil ne correspondraient plus
 * aux vraies frontières où pickBestFrom peut changer de gagnant.
 */
function resolveBenchmarkResult(
  candidate: ModelCandidate,
  tier: VerifiedTier,
  gpuName: string | null,
  localBenchmark: Record<VerifiedTier, Map<string, LocalBenchmarkEntry>>,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>
): LocalBenchmarkEntry | undefined {
  const local = localBenchmark[tier].get(candidate.model)
  if (local) return local
  const verifiedTool = verifiedToolScores[tier].get(candidate.model)
  if (!verifiedTool) return undefined
  return { speedTokPerSec: estimateSpeedTokPerSec(candidate.vramGb, gpuName), toolCalling: verifiedTool, speedEstimated: true }
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
  localBenchmark: Record<VerifiedTier, Map<string, LocalBenchmarkEntry>>,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>,
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

  const resultFor = (candidate: ModelCandidate, tier: VerifiedTier): LocalBenchmarkEntry | undefined =>
    resolveBenchmarkResult(candidate, tier, gpuName, localBenchmark, verifiedToolScores)

  // Départage à égalité de fiabilité (6/6) : d'abord par MMLU-Pro (INTELLIGENCE_MMLU_PRO) quand les DEUX
  // candidats à égalité ont un chiffre connu, sinon par la VRAM du candidat (le plus GROS gagne) — à la
  // demande explicite de Léo, qui a fait remarquer qu'un score "parfait" ne veut pas dire "le meilleur" (nos
  // 6/6 questions ne distinguent pas "juste assez bon" de "vraiment plus intelligent" une fois le score max
  // atteint) et qu'il fallait aller chercher un VRAI signal externe (benchmark) avant de se rabattre sur la
  // taille. La VRAM reste le repli : MMLU-Pro n'est renseigné que pour une poignée de modèles (voir la table),
  // donc la plupart des départages continuent de se faire par taille faute de chiffre comparable pour les deux
  // candidats à la fois.
  const pickBestFrom = (candidates: ModelCandidate[], tier: VerifiedTier): ModelOverviewEntry => {
    const benchmarked = candidates
      .filter((c) => c.vramGb <= budgetForCandidate(c.model))
      .map((c) => ({ model: c.model, vramGb: c.vramGb, result: resultFor(c, tier) }))
      // toolCalling (pas speedTokPerSec) est le critère de validité : un modèle vérifié dont la vitesse n'a
      // pas pu être estimée (carte inconnue, voir estimateSpeedTokPerSec) reste un candidat légitime, juste
      // départagé par 0 dans le tri ci-dessous plutôt qu'exclu.
      .filter((c): c is { model: string; vramGb: number; result: LocalBenchmarkEntry } => c.result?.toolCalling != null)

    // Repli VRAM seule (jamais élargi) : aucun candidat ne tient dans le budget de ce palier (ex: le plus
    // petit modèle vision, 3 Go, ne rentre déjà plus dans les 1,5 Go restants une fois la réservation STT
    // déduite sur le palier "Petite"). On garde quand même son score/sa vitesse s'il en a un connu (mesure
    // locale ou verified-tool-scores.md) plutôt que de les effacer : le modèle affiché EST celui-là qu'on le
    // veuille ou non (repli ultime), donc autant montrer ce qu'on sait vraiment de lui — seul un modèle
    // jamais testé nulle part garde des cases vides ci-dessous.
    if (!benchmarked.length) {
      const model = pickForBudget(candidates, budgetGb)
      const candidate = candidates.find((c) => c.model === model)
      const result = candidate ? resultFor(candidate, tier) : undefined
      return {
        model,
        vramGb: candidate?.vramGb ?? 0,
        speedTokPerSec: result?.speedTokPerSec ?? null,
        speedEstimated: result?.speedEstimated,
        toolCalling: result?.toolCalling ?? null,
        intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null,
        artificialAnalysisIndex: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[model] ?? null,
        artificialAnalysisSpeed: ARTIFICIAL_ANALYSIS_SPEED[model] ?? null
      }
    }

    const artificialAnalysisFor = (model: string): number | undefined => ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[model]

    benchmarked.sort((a, b) => {
      const toolDiff = parseToolScore(b.result.toolCalling) - parseToolScore(a.result.toolCalling)
      if (toolDiff !== 0) return toolDiff
      // À fiabilité égale, privilégie l'Intelligence Index demandé par Léo, mais uniquement quand
      // Artificial Analysis a évalué les DEUX modèles exacts. Une absence ne vaut jamais zéro.
      const aArtificialAnalysis = artificialAnalysisFor(a.model)
      const bArtificialAnalysis = artificialAnalysisFor(b.model)
      if (
        aArtificialAnalysis !== undefined &&
        bArtificialAnalysis !== undefined &&
        aArtificialAnalysis !== bArtificialAnalysis
      ) {
        return bArtificialAnalysis - aArtificialAnalysis
      }
      const aIntel = INTELLIGENCE_MMLU_PRO[a.model]
      const bIntel = INTELLIGENCE_MMLU_PRO[b.model]
      if (aIntel !== undefined && bIntel !== undefined && aIntel !== bIntel) return bIntel - aIntel
      return b.vramGb - a.vramGb
    })
    const winner = benchmarked[0]
    return {
      model: winner.model,
      vramGb: winner.vramGb,
      speedTokPerSec: winner.result.speedTokPerSec,
      speedEstimated: winner.result.speedEstimated,
      toolCalling: winner.result.toolCalling,
      intelligence: INTELLIGENCE_MMLU_PRO[winner.model] ?? null,
      artificialAnalysisIndex: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[winner.model] ?? null,
      artificialAnalysisSpeed: ARTIFICIAL_ANALYSIS_SPEED[winner.model] ?? null
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
    visionModel: picks.vision.model,
    codeModel: picks.code.model
  }
}

/**
 * Meilleur modèle de code pour la VRAM+RAM RÉELLE de cette machine (étape 46) — utilisé par
 * resolveCodeModel (codeGenerator.ts) quand aucun choix explicite n'est enregistré ('auto'/profil
 * antérieur à ce réglage), à la place de l'ancien repli fixe (qualité si déjà installée, sinon rapide) qui
 * ignorait complètement la taille de la machine. Même calcul que pickBestModelsFromBenchmark ci-dessus,
 * extrait à part : resolveCodeModel n'a besoin QUE du pick Code, pas des 4 autres paliers.
 */
export async function pickBestCodeModel(): Promise<string> {
  const { name, vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), name, parseLocalBenchmark(), parseVerifiedToolScores())
  return picks.code.model
}

/**
 * Chaque VRAM DISTINCTE parmi les candidats Rapide/Médium/Puissant qui ont un score connu (resolveBenchmarkResult)
 * est déjà, par construction, une frontière EXACTE où pickBestFrom peut changer de gagnant (voir son filtre
 * `c.vramGb <= budget` dans computeModelPicks) : deux machines dont le budget tombe entre deux de ces
 * frontières obtiennent TOUJOURS le même modèle, quel que soit l'écart de VRAM entre elles. Les anciens 3
 * points fixes (6/12/24 Go, "Petite/Moyenne/Grande configuration") masquaient ça : deux machines dans la
 * même tranche "Moyenne" (7 et 11 Go) pouvaient déjà recevoir des modèles différents en réalité (une
 * frontière réelle, ex: qwen3.5:9b — qui pèse 6,6 Go, donc atteignable dès 11,1 Go de VRAM TOTALE une fois
 * STT_RESERVED_GB déduit — tombe ENTRE les deux) sans que l'étiquette ne le montre — Léo a
 * demandé qu'à VRAM égale, tout le monde ait garanti le même modèle, palier par palier ("tu vas regarder sur
 * internet les benchmark si plusieurs model sont 6/6" puis "je veux que tout le monde ait le même model dans
 * palier 1 et 2 et 3, met minimum 30go... " → clarifié en "ajoute 10 palier, mais les 10 palier doivent etre
 * exact pour tout le monde"). Utiliser les VRAIES frontières comme lignes de l'écran d'accueil (au lieu de 3
 * points arbitraires) le garantit directement, puisque chaque ligne EST déjà une frontière réelle.
 *
 * PAS un retour à la tentative abandonnée plus haut dans l'historique de ce fichier ("regrouper le choix en
 * 3 paliers matériels stricts") : cette tentative calculait UN SEUL budget combiné pour les 3 rôles à la
 * fois, ce qui laissait le débordement RAM autorisé pour "Puissant" gonfler à tort le palier "Rapide" (qui
 * n'en bénéficie jamais). Ici, chaque ligne appelle toujours computeModelPicks séparément pour Rapide/
 * Médium/Puissant/Vision/Code (comme avant), donc le budget VRAM+RAM propre à "Puissant" ne contamine jamais
 * les 2 autres rôles — seul le NOMBRE et le CHOIX des points représentatifs change, pas le calcul lui-même.
 */
function previewVramSteps(
  gpuName: string | null,
  ramGb: number,
  localBenchmark: Record<VerifiedTier, Map<string, LocalBenchmarkEntry>>,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>
): number[] {
  const hasScore = (c: ModelCandidate): boolean =>
    resolveBenchmarkResult(c, 'conversation', gpuName, localBenchmark, verifiedToolScores)?.toolCalling != null

  // `candidate.vramGb` est le poids DU MODÈLE (comparé à budgetForCandidate dans computeModelPicks), pas la
  // VRAM TOTALE de la machine (le paramètre attendu par computeModelPicks, qui lui retire STT_RESERVED_GB
  // avant de comparer) : reconvertir en "VRAM totale minimale requise" pour que la ligne de l'écran d'accueil
  // corresponde vraiment à la machine qui atteint tout juste ce candidat. Les candidats "Puissant"
  // (LARGE_RAM_OFFLOAD_MODELS) peuvent en plus déborder sur la RAM (ramOffloadBudgetGb dans
  // computeModelPicks) : leur seuil de VRAM totale est donc réduit d'autant, jamais sous 0.
  const totalVramNeededFor = (c: ModelCandidate): number => {
    const ramOffloadAllowance = LARGE_RAM_OFFLOAD_MODELS.has(c.model) ? Math.max(0, ramGb - RESOURCE_SAFETY_MARGIN_GB) : 0
    return Math.max(0, c.vramGb - ramOffloadAllowance + STT_RESERVED_GB)
  }

  const sizes = [...FLASH_CANDIDATES, ...MEDIUM_CANDIDATES, ...LARGE_CANDIDATES].filter(hasScore).map(totalVramNeededFor)
  return [...new Set(sizes)].sort((a, b) => a - b)
}

/** Mot descriptif par tiers de la liste (léger/intermédiaire/robuste) — le numéro exact ("Palier N") et la
 * VRAM précise sont déjà affichés séparément par HardwareTierPreview.tsx, ce mot ne sert qu'à donner une
 * impression générale en un coup d'œil sans avoir à lire chaque chiffre. */
function previewLabelFor(index: number, total: number): string {
  const ratio = total <= 1 ? 0 : index / (total - 1)
  if (ratio < 1 / 3) return 'Configuration légère'
  if (ratio < 2 / 3) return 'Configuration intermédiaire'
  return 'Configuration robuste'
}

/**
 * Autant de lignes que de frontières de VRAM réellement atteignables (previewVramSteps, une dizaine en
 * pratique) pour l'écran d'accueil et l'onglet Modèles — la ligne "ta configuration" (current) coïncide
 * donc TOUJOURS exactement avec l'une des lignes fixes (jamais une approximation arrondie au palier le plus
 * proche), puisque chaque ligne fixe EST déjà la frontière réelle où le résultat peut changer. Sans jamais
 * lancer le moindre téléchargement (computeModelPicks est pur, verified-tool-scores.md/benchmark-results.md
 * sont déjà sur le disque).
 *
 * Léo a repéré plusieurs paliers D'AFFILÉE strictement identiques (mêmes 5 modèles pour Rapide/Médium/
 * Puissant/Vision/Code) : chaque VALEUR de `previewVramSteps` est bien une frontière réelle où AU MOINS UN
 * candidat devient/cesse d'être atteignable, mais ça ne garantit pas que ce changement soit VISIBLE dans les
 * 5 lignes affichées — un repli "aucun candidat ne rentre encore" (pickForBudget dans computeModelPicks)
 * peut déjà afficher le même modèle qu'une fois son propre seuil réellement atteint, et le tout premier
 * palier (VRAM=0) n'a par définition rien "avant" lui à distinguer. Fusionne donc les paliers consécutifs
 * dont les 5 modèles sont identiques : une seule ligne par combinaison VRAIMENT distincte, gardant la
 * frontière du PREMIER palier du groupe (celle où ce résultat apparaît réellement) et le statut "actuel" s'il
 * appartenait à N'IMPORTE LEQUEL des paliers fusionnés.
 */
export async function previewHardwareTiers(): Promise<HardwareTierPreview[]> {
  const { name, vramGb: actualVramGb } = await detectGpu()
  const ramGb = detectRamGb()
  const localBenchmark = parseLocalBenchmark()
  const verifiedToolScores = parseVerifiedToolScores()

  const steps = previewVramSteps(name, ramGb, localBenchmark, verifiedToolScores)

  // Le palier atteint = le plus haut dont la VRAM tient dans le budget réel de cette machine — jamais hors
  // tableau (repli sur le premier palier si même le plus petit ne rentre pas encore).
  let currentIndex = 0
  for (let i = 0; i < steps.length; i++) {
    if (actualVramGb !== null && steps[i] <= actualVramGb) currentIndex = i
  }

  const rows = steps.map((vramGb, i) => ({
    vramGb,
    current: i === currentIndex,
    // Ligne "ta configuration" calculée avec la VRAM RÉELLE de cette machine, les autres avec leur propre
    // point représentatif — mathématiquement identique dans les deux cas puisque `vramGb` ci-dessus EST déjà
    // la frontière exacte où le résultat change (voir previewVramSteps), mais garder le calcul sur la VRAM
    // réelle pour "ta configuration" reste la source la plus directe de vérité, sans intermédiaire.
    ...computeModelPicks(i === currentIndex && actualVramGb !== null ? actualVramGb : vramGb, ramGb, name, localBenchmark, verifiedToolScores)
  }))

  const sameCombo = (a: (typeof rows)[number], b: (typeof rows)[number]): boolean =>
    a.flash.model === b.flash.model &&
    a.medium.model === b.medium.model &&
    a.large.model === b.large.model &&
    a.vision.model === b.vision.model &&
    a.code.model === b.code.model

  const merged: typeof rows = []
  for (const row of rows) {
    const last = merged[merged.length - 1]
    if (last && sameCombo(last, row)) {
      if (row.current) last.current = true
      continue
    }
    merged.push({ ...row })
  }

  return merged.map((row, i) => ({
    label: previewLabelFor(i, merged.length),
    ...row
  }))
}
