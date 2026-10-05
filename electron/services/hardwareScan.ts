import { exec } from 'child_process'
import { readFileSync } from 'fs'
import { resourcesRoot } from '../paths'
import { join } from 'path'
import { promisify } from 'util'
import { RESOURCE_SAFETY_MARGIN_GB, detectRamGb } from './systemResources'
import { getInstalledModelSizeBytes, getModelInfo, listInstalledModels } from './ollama'
import type {
  CapacityScanResult,
  ContextLengthOptions,
  ModelCategory,
  ModelOverviewEntry,
  ModelOverviewResult,
  ModelRole,
  MyModelPicks,
  Profile
} from '../../shared/ipc'

const execAsync = promisify(exec)

/**
 * VRAM gardée hors de portée des modèles d'Ollama : Windows (affichage), le pilote et la fenêtre de Jaris. À
 * soustraire du total avant de choisir des modèles, sinon on risque de dépasser la VRAM réellement disponible.
 *
 * Étape 158 : 4,5 -> 1 Go. Les 4,5 Go d'avant réservaient surtout la transcription (Cohere Transcribe, 3,9 Go
 * mesurés sur la RTX 3070 de Léo), chargée en permanence sur la carte. Elle tourne désormais en RAM (Parakeet v3,
 * voir voice_server.py) : la carte revient au modèle de conversation — sur 6 Go, Rapide/Médium passent de
 * qwen3.5:0.8b à des modèles fiables à 6/6 ; sur 8 Go, Médium passe de qwen3.5:4b à qwen3.5:9b. 1 Go, comme
 * la marge du script d'analyse (VRAM_SAFETY_MARGIN_GB, benchmark-models.mjs).
 *
 * Volontairement basé sur la VRAM *totale* de la carte (fixe), pas sur la VRAM libre à l'instant du
 * scan : cette dernière varie selon ce qui tourne au même moment (jeu, navigateur...), ce qui donnerait
 * un résultat différent à chaque scan pour la même machine. Le bouton "relancer l'analyse" du menu
 * Options sert à re-choisir les modèles si la config matérielle change (nouvelle carte...), pas à
 * s'adapter à l'usage instantané du GPU.
 */
const GPU_RESERVED_GB = 1

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
  // granite4.2:3b (déjà candidat Médium, voir MEDIUM_CANDIDATES plus bas) rejoint aussi Rapide — étape 127,
  // proposé par ChatGPT (relayé par Léo, "vas sur le site .../recommend") après avoir ouvert le
  // comparateur interactif, inaccessible depuis cet environnement (voir le commentaire au-dessus de
  // ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX). Score Artificial Analysis (9) confirmé plus haut que les 3
  // candidats déjà présents ici (qwen3.5:0.8b 6, ministral-3:3b/qwen3:1.7b 5), pour une taille intermédiaire
  // (2,2 Go) entre eux — comme granite4.1:3b/4.2:3b en Médium, rejette `think` (voir le filet "sans think"
  // dans chatWithOllama, ollama.ts). Sa fiabilité d'appel d'outils reste à mesurer localement
  // (`npm run benchmark:models`) : ce score externe ne le fait pas gagner tout seul, seulement candidat.
  // Nanbeige4.1-3B : voir le commentaire de l'étape 229 dans FLASH_CANDIDATES.
  { model: 'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M', vramGb: 2.4 },
  { model: 'granite4.2:3b', vramGb: 2.2 },
  { model: 'qwen3:1.7b', vramGb: 2 },
  // Étape 132, Léo : "on a bien les meilleur model... regarde bien". Déjà présent dans
  // scripts/benchmark-models.mjs comme candidat EXPLORATOIRE depuis longtemps (import Hugging Face direct,
  // quantification GGUF par bartowski — quantifieur reconnu de la communauté Ollama/llama.cpp, PAS le même
  // risque qu'un réupload communautaire non vérifié sur la bibliothèque Ollama elle-même, voir plus bas) à
  // partir du dépôt OFFICIEL ai9stars/G9v3-3B, mais jamais promu dans les vraies listes de candidats : un
  // oubli, pas un choix délibéré. Déjà VÉRIFIÉ 6/6 en appel d'outils sur la machine de Léo
  // (verified-tool-scores.md, mesuré le 12/09/2026) — meilleur que TOUS les autres candidats de ce palier à
  // cette taille (granite4.2:3b n'a que 5/6). Score Artificial Analysis Intelligence Index 11, vérifié
  // directement sur sa fiche (voir ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX plus haut) — le meilleur du palier
  // Rapide, devant granite4.2:3b (9). Poids réel 1,9 Go (scripts/benchmark-models.mjs), plus léger que
  // granite4.2:3b (2,2 Go). Repose sur ce que Jaris fait déjà ailleurs pour des modèles sans tag officiel
  // Ollama (GLM-4.6V-Flash-GGUF, MiniCPM5-1B, LFM2.5-1.2B) : un import `hf.co/<dépôt>` direct depuis
  // Hugging Face est un mécanisme OFFICIEL d'Ollama, pas un contournement — à ne pas confondre avec un tag
  // republié par un tiers non vérifié DANS la bibliothèque Ollama elle-même (voir la réserve sur "Hermes 4
  // 14B" et les namespaces communautaires, plus bas dans ce fichier). Rejoint aussi Médium (voir
  // MEDIUM_CANDIDATES), même raisonnement que granite4.2:3b.
  { model: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', vramGb: 1.9 },
  // Étape 226, Léo : « et MiniCPM5-2B ». OpenBMB, sorti le 07/09/2026, 2,52 milliards de paramètres, Apache 2.0,
  // pensé pour l'appel d'outils sur appareil. Vérifié avant de l'ajouter : GGUF OFFICIEL d'OpenBMB (créateur du
  // modèle), architecture `llama` déjà connue de llama.cpp ; téléchargé et chargé ici par Ollama 0.35.1, qui
  // annonce `tools` et `thinking` (`/api/show`, 1,56 Go) et a bien appelé un outil sur un essai. Intelligence
  // Index Artificial Analysis 12,5 (variante Reasoning). Ne gagne pas tout seul : choisi seulement d'après son
  // score d'appel d'outils (verified-tool-scores.md), que Léo mesure lui-même.
  // Étape 229, Léo : « ajoute Nanbeige4.1-3B et LFM2.5-2.6B ». Vérifiés avant de les ajouter :
  // - LFM2.5-2.6B (Liquid AI) : GGUF OFFICIEL du créateur, architecture `lfm2` (déjà chargée par Ollama pour
  //   l'ancien LFM2.5-1.2B), 1,67 Go en Q4_K_M ; 8,4 chez Artificial Analysis (variante Reasoning).
  // - Nanbeige4.1-3B (Nanbeige) : AUCUN GGUF publié par le créateur — requantification de mradermacher,
  //   quantifieur reconnu de la communauté llama.cpp (même règle que bartowski pour G9v3) ; architecture
  //   `llama`, 2,44 Go en Q4_K_M ; 8,4 chez Artificial Analysis (variante Reasoning).
  // Tous deux sous MiniCPM5-2B (12,5) et granite4.2:3b (9,1) en intelligence ; choisis seulement d'après leur
  // score d'appel d'outils (verified-tool-scores.md), que Léo mesure lui-même.
  { model: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M', vramGb: 1.7 },
  { model: 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M', vramGb: 1.6 },
  { model: 'qwen3.5:0.8b', vramGb: 1.0 }
  // Étape 196, Léo : « on peut ajouter K2 Horizon 3.7B ? il est le meilleur sur les benchmarks ». Vérifié le
  // 28/09/2026 et PAS ajouté pour l'instant : le modèle existe bien (IFM/MBZUAI, Apache 2.0, GGUF officiel
  // hf.co/IFM/K2-Horizon-3.7B-GGUF, Q4_K_M 3,16 Go, Intelligence Index Artificial Analysis 16), mais son GGUF
  // déclare une architecture NOUVELLE (`k2-horizon`) que le llama.cpp officiel ne sait pas encore charger
  // (« unknown model architecture: 'k2-horizon' », github.com/ggml-org/llama.cpp/issues/28361 et #29424,
  // ouverts) et aucune note de version d'Ollama (jusqu'à 0.34.4 / 0.40.0 pré-version) ne l'annonce. Jaris le
  // téléchargerait (3 Go) pour un modèle qui ne démarre pas. Autres réserves : modèle annoncé en anglais
  // seulement, et format d'appel d'outils propre (parseur `k2_horizon` dans vLLM). À revoir dès qu'une version
  // d'Ollama le charge : l'ajouter ici, puis mesurer son score d'outils (verified-tool-scores.md) avant qu'il
  // puisse être choisi.
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
  // Étape 219, Léo : « tu peux ajouter Ling 3.0 Tiny ». inclusionAI (Ant Group), sorti le 06/08/2026 :
  // MoE de 7,9 milliards de paramètres dont 1,3 actifs par mot (donc rapide pour sa taille), 256K de contexte,
  // appel d'outils natif, réflexion activable. Vérifié avant de l'ajouter, pas pris sur parole :
  // - pas de tag dans la bibliothèque officielle d'Ollama : import `hf.co/` du GGUF OFFICIEL d'inclusionAI
  //   (créateur du modèle), même mécanisme que G9v3 plus haut — jamais le réupload communautaire
  //   `maternion/ling-3.0-tiny` ;
  // - architecture NOUVELLE `bailingmoe3` (attention KDA + MLA) : contrairement à K2 Horizon (FLASH_CANDIDATES),
  //   llama.cpp la charge depuis github.com/ggml-org/llama.cpp/pull/26608 (fusionnée le 17/08/2026), et
  //   Ollama aussi (signalement github.com/ollama/ollama/issues/18221 sous 0.33.3). Revérifié pour de vrai :
  //   téléchargé et chargé par Ollama 0.35.0, qui annonce `tools` et `thinking` (`/api/show`), 4,82 Go ;
  // - Intelligence Index Artificial Analysis 11 (variante Reasoning, la seule publiée), 58 tokens/s.
  // Ne gagne pas tout seul : choisi seulement d'après son score d'appel d'outils (verified-tool-scores.md).
  { model: 'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M', vramGb: 4.8 },
  { model: 'qwen3.5:4b', vramGb: 3.4 },
  { model: 'qwen3.5:2b', vramGb: 2.7 },
  // Nanbeige4.1-3B : voir le commentaire de l'étape 229 dans FLASH_CANDIDATES.
  { model: 'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M', vramGb: 2.4 },
  { model: 'granite4.2:3b', vramGb: 2.2 },
  { model: 'granite4.1:3b', vramGb: 2.1 },
  // Candidat "réutilisation" : hf.co/bartowski/ai9stars_G9v3-3B-GGUF (voir FLASH_CANDIDATES pour le détail
  // complet de la vérification) — même raisonnement que granite4.2:3b, déjà candidat dans les deux paliers.
  { model: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', vramGb: 1.9 },
  // LFM2.5-2.6B et MiniCPM5-2B : voir FLASH_CANDIDATES, même raisonnement que G9v3.
  { model: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M', vramGb: 1.7 },
  { model: 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M', vramGb: 1.6 },
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
  // Nemotron 3.5 Lightning (NVIDIA, août 2026) — ajouté à la demande de Léo (étape 167) : « moi ça tient pas
  // dans ma carte mais un autre utilisateur peut-être ». 30B MoE, 3B actifs, tools+thinking, vérifié sur
  // ollama.com/library/nemotron-3.5-lightning/tags (tag 30b = q4_K_M, 25 Go). Intelligence Index 13, vitesse
  // 264 tokens/s (artificialanalysis.ai/models/nemotron-3-5-lightning, v4.3.2). Sa force est la vitesse, pas
  // l'intelligence : utile en Rapide sur une carte de 32 Go+. Pas encore de score d'appel d'outils (trop
  // gros pour être testé ici comme sur la machine de Léo) : Jaris ne le choisit pas tant qu'il n'est pas mesuré.
  { model: 'nemotron-3.5-lightning:30b', vramGb: 25 },
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
  'mistral-small3.2:24b',
  'glm-4.7-flash:q4_K_M',
  'nemotron-3.5-lightning:30b',
  'qwen3.6:35b-a3b',
  'qwen3-coder:30b',
  'north-mini-code-1.0',
  'qwen2.5-coder:32b',
  'devstral-small-2:24b'
])

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
  // Candidat "réutilisation" : qwen3.8:27b (déjà dans LARGE_CANDIDATES, palier Puissant) — étape 127,
  // proposé par ChatGPT (via le comparateur .../models/recommend, inaccessible depuis cet environnement,
  // voir le commentaire au-dessus de ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX). Vérifié directement sur sa
  // fiche ollama.com : "text, image, and video" en entrée, la FAQ confirme explicitement le support de
  // l'analyse d'image. Score Artificial Analysis (34) largement au-dessus de gemma4:31b (15), le meilleur
  // candidat Vision jusqu'ici — et déjà téléchargé pour qui l'a comme modèle Puissant, aucun poids
  // supplémentaire. Deux chiffres du même rapport se sont révélés FAUX en les revérifiant nous-mêmes avant
  // d'y toucher (gemma4:31b annoncé à 15 au lieu de 19, qwen3.6:35b-a3b annoncé à 19 au lieu de 18 — la
  // table ci-dessous n'a pas bougé sur ces deux-là) : seule cette proposition-ci a été retenue, après
  // vérification indépendante du score ET du support image.
  { model: 'qwen3.8:27b', vramGb: 18 },
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
  // Étape 225 (Léo : « même un modèle 8b est plus fort que lui ») : devstral-2:123b RETIRÉ. Vérifié sur
  // Artificial Analysis : 8,6, sous granite4.2:8b (11,1) et qwen3.5:9b (11,2), pour 75 Go dense.
  // Étape 227 (Léo : « il est nul ») : qwen3-coder-next RETIRÉ pour la même raison. Vérifié : 9,2 chez Artificial
  // Analysis, deux fois moins que qwen3.6:35b-a3b (18,2) juste en dessous, pour 52 Go contre 22.
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
 * Étape 160, Léo : « que tous les modèles soient au même endroit, pas des modèles code, pas des modèles
 * rapide : Jaris choisit le plus rapide dans tous les modèles, le meilleur pour le code — ça peut être des
 * modèles puissants — il n'y a plus de catégorie, sauf pour que l'utilisateur voie quel modèle est rapide ».
 * Déclencheur : le modèle Code (qwen3.6:35b-a3b, Intelligence 18) était moins fort que le Puissant
 * (qwen3.8:27b, 34), simplement parce que le Code ne cherchait QUE dans CODE_CANDIDATES.
 *
 * Les listes ci-dessus restent le CATALOGUE (avec l'historique de recherche de chaque modèle), mais plus aucun
 * rôle ne se limite à « sa » liste : chaque rôle cherche dans ALL_MODELS, avec son propre critère (voir
 * computeModelPicks). Seules les CAPACITÉS réelles d'un modèle restreignent encore un rôle : lire une image
 * (Vision) — un fait sur le modèle, pas une catégorie.
 */
/**
 * Rôle Rapide (étape 161) : part de la vitesse de référence qu'un modèle doit garder pour rester candidat — au
 * plus deux fois plus lent. Au-dessus de ce seuil, c'est l'intelligence qui départage (voir
 * fastEnoughThenSmartest dans computeModelPicks). 75 % jusqu'au 04/10/2026, abaissé à 50 % par Léo en fixant
 * les trois réglages ensemble : Rapide 50 %, Médium 20 %, Puissant/Vision/Code sans minimum.
 */
const RAPIDE_MIN_SPEED_RATIO = 0.5

/**
 * Rôle Médium (Léo, 04/10/2026). Même principe que Rapide, bien moins strict : seuls les modèles vraiment lents
 * (moins d'un cinquième de la vitesse de référence — le plus rapide parmi les meilleurs aux outils, comme Rapide,
 * choix « A » de Léo) sont écartés. Médium fait TOUTES les actions de Jaris : l'intelligence passe avant. Essayé
 * à 50 % : sur une carte de 24 Go, Médium passait de qwen3.8:27b (intelligence 34, vitesse 46) à qwen3.5:27b (23,
 * 75) — un tiers d'intelligence perdue pour le rôle qui agit. Qu'un même modèle serve Médium et Puissant (ou
 * Rapide et Médium) n'est pas un défaut : c'est le meilleur pour les deux, et rien à recharger en changeant de
 * rôle. Différence avec Rapide, au choix de Léo : un modèle sans vitesse publiée reste candidat.
 */
const MEDIUM_MIN_SPEED_RATIO = 0.2

const ALL_MODELS: ModelCandidate[] = (() => {
  const byModel = new Map<string, ModelCandidate>()
  for (const c of [...FLASH_CANDIDATES, ...MEDIUM_CANDIDATES, ...LARGE_CANDIDATES, ...VISION_CANDIDATES, ...CODE_CANDIDATES]) {
    if (!byModel.has(c.model)) byModel.set(c.model, c)
  }
  // Du plus gros au plus petit : l'ordre dont pickForBudget a besoin (premier qui tient = le plus gros).
  return [...byModel.values()].sort((a, b) => b.vramGb - a.vramGb)
})()

/** Modèles qui lisent une image (vision native vérifiée sur ollama.com, voir VISION_CANDIDATES). */
const READS_IMAGES = new Set(VISION_CANDIDATES.map((c) => c.model))

/**
 * Modèles qui savent tenir une conversation avec appel d'outils — tous sauf les spécialistes du code, jamais
 * testés en conversation. Sert au repli en direct (pickSafeModel) : jamais basculer une conversation sur un
 * modèle qui n'a pas fait ses preuves pour ça.
 */
const CONVERSATION_MODELS = new Set([...FLASH_CANDIDATES, ...MEDIUM_CANDIDATES, ...LARGE_CANDIDATES].map((c) => c.model))

/**
 * Étiquette AFFICHÉE seulement (Léo : « garde quand même rapide, moyen, pour que les utilisateurs voient ») —
 * n'entre dans AUCUN choix. Seuils tirés des anciennes listes : Rapide allait jusqu'à 3 Go, Médium jusqu'à
 * ~10 Go, Puissant commençait à 14 Go.
 */
export function modelCategory(vramGb: number): ModelCategory {
  if (vramGb <= 3) return 'Rapide'
  if (vramGb <= 10) return 'Moyen'
  return 'Puissant'
}

/**
 * Tous les identifiants de modèles candidats (tous paliers + vision confondus, sans doublon), pour l'étape
 * 29 (veille) : comparé au dernier snapshot connu du profil pour détecter les modèles ajoutés à ce fichier
 * depuis (nouvelle version de Jaris) et prévenir l'utilisateur au lieu d'attendre qu'il relance l'analyse
 * de lui-même.
 */
export function getAllCandidateModelIds(): string[] {
  return ALL_MODELS.map((c) => c.model)
}

function pickForBudget(candidates: ModelCandidate[], budgetGb: number): string {
  const fit = candidates.find((c) => c.vramGb <= budgetGb)
  return (fit ?? candidates[candidates.length - 1]).model
}

export async function detectGpu(): Promise<{ name: string | null; vramGb: number | null }> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
      windowsHide: true
    })
    const firstLine = stdout.trim().split('\n')[0] ?? ''
    const [name, mibRaw] = firstLine.split(',').map((s) => s.trim())
    const mib = parseInt(mibRaw, 10)
    return { name: name || null, vramGb: Number.isFinite(mib) ? Math.round((mib / 1024) * 10) / 10 : null }
  } catch {
    // Étape 208 : pas de nvidia-smi = pas forcément pas de carte (AMD, Intel) — voir detectGpuFromRegistry.
    return process.platform === 'win32' ? detectGpuFromRegistry() : { name: null, vramGb: null }
  }
}

/**
 * Étape 208 (Léo, PC d'un ami avec une AMD Radeon RX 7600 de 8 Go : « aucune carte graphique NVIDIA détectée,
 * mais j'en ai assez ? ») : nvidia-smi n'existe QUE sur les cartes NVIDIA, donc une AMD ou une Intel passait pour
 * « pas de carte du tout » — vidéo refusée, et modèles Ollama choisis comme pour une machine sans carte. Windows
 * note la mémoire de chaque carte graphique, toutes marques confondues, dans le registre de sa classe de
 * périphériques (valeur `HardwareInformation.qwMemorySize`, sur 64 bits). `Win32_VideoController.AdapterRAM`
 * n'est PAS utilisé : il est limité à 32 bits et plafonne à 4 Go, donc faux pour une carte de 8 Go.
 * Script sans aucune donnée venue de l'extérieur, passé encodé (`-EncodedCommand`) : rien à échapper.
 */
export const REGISTRY_GPU_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |",
  "  Where-Object { $_.'HardwareInformation.qwMemorySize' } |",
  "  ForEach-Object {",
  "    $v = $_.'HardwareInformation.qwMemorySize'",
  '    if ($v -is [byte[]]) { $v = [BitConverter]::ToUInt64($v, 0) }',
  '    [pscustomobject]@{ name = [string]$_.DriverDesc; bytes = [double]$v }',
  '  } | ConvertTo-Json -Compress'
].join('\n')

/**
 * Lit la sortie du script ci-dessus : la carte qui a le PLUS de mémoire (une carte intégrée Intel à côté d'une
 * AMD dédiée n'a que quelques centaines de Mo). PowerShell 5.1 sort UN objet seul au lieu d'un tableau d'un
 * élément (`ConvertTo-Json` sans `-AsArray`, piège déjà rencontré à l'étape 32) : les deux formes sont acceptées.
 */
export function parseRegistryGpus(stdout: string): { name: string | null; vramGb: number | null } {
  let data: unknown
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return { name: null, vramGb: null }
  }
  const entries = (Array.isArray(data) ? data : [data]) as Array<{ name?: unknown; bytes?: unknown }>
  let best: { name: string | null; bytes: number } | null = null
  for (const entry of entries) {
    const bytes = typeof entry?.bytes === 'number' ? entry.bytes : NaN
    if (!Number.isFinite(bytes) || bytes <= 0) continue
    if (!best || bytes > best.bytes) best = { name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null, bytes }
  }
  // Moins de 1 Go : une carte intégrée seule, qui n'accélère rien de ce que fait Jaris — traitée comme « pas de carte ».
  if (!best || best.bytes < 1024 ** 3) return { name: null, vramGb: null }
  return { name: best.name, vramGb: Math.round((best.bytes / 1024 ** 3) * 10) / 10 }
}

async function detectGpuFromRegistry(): Promise<{ name: string | null; vramGb: number | null }> {
  try {
    const encoded = Buffer.from(REGISTRY_GPU_SCRIPT, 'utf16le').toString('base64')
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { windowsHide: true, timeout: 10_000 })
    return parseRegistryGpus(stdout)
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
export function pickSafeModel(freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  if (LARGE_RAM_OFFLOAD_MODELS.has(fallbackModel)) return fallbackModel
  return pickSafeAmong(ALL_MODELS.filter((c) => CONVERSATION_MODELS.has(c.model)), freeVramGb, installedModels, fallbackModel)
}

/**
 * Étape 160 : le modèle choisi est GARDÉ tant qu'il tient dans la VRAM libre — seul un modèle qui ne tient
 * plus est remplacé, par le plus gros modèle installé qui tient. Avant, chaque rôle avait sa propre petite
 * liste, donc « le plus gros qui tient » restait dans le même genre de modèle ; dans une liste unique, sans ce
 * garde, le modèle Rapide aurait été remplacé par un plus gros (plus lent) à chaque question.
 */
function pickSafeAmong(pool: ModelCandidate[], freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  const budget = Math.max(0, freeVramGb - LIVE_SAFETY_MARGIN_GB)
  const current = pool.find((c) => c.model === fallbackModel)
  if (current && current.vramGb <= budget) return fallbackModel
  const installedCandidates = pool.filter((c) => installedModels.includes(c.model))
  if (installedCandidates.length === 0) return fallbackModel
  return pickForBudget(installedCandidates, budget)
}

/**
 * Même logique que pickSafeModel ci-dessus, mais pour le modèle de vision (liste de candidats séparée, pas
 * un palier de ModelTiers) : le modèle choisi une fois pour toutes au scan de capacité peut ne plus tenir
 * dans la VRAM *libre* à l'instant présent (conversation déjà chargée, jeu ou navigateur en parallèle...),
 * ce qui forcerait sinon Ollama à décharger/recharger un gros modèle et ferait traîner look_at_screen.
 */
export function pickSafeVisionModel(freeVramGb: number, installedModels: string[], fallbackModel: string): string {
  return pickSafeAmong(ALL_MODELS.filter((c) => READS_IMAGES.has(c.model)), freeVramGb, installedModels, fallbackModel)
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
 * fiabilité d'appel d'outils, qui vient des scores mesurés par Léo (verified-tool-scores.md, voir
 * parseVerifiedToolScores ci-dessous), pas d'un score publié. Absent = pas de chiffre MMLU-Pro publié trouvé pour ce modèle.
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
 *
 * **Étape 220 (Léo : « on a pris les scores raisonner ou non raisonner ? … regarde bien tous les scores, ils
 * doivent être exacts ») : tableau entièrement revérifié le 02/10/2026** sur les DONNÉES BRUTES des fiches
 * (champ `intelligenceIndex` de l'objet `currentModel` de chaque page, méthodologie v4.3.2), plus jamais sur
 * un résumé automatique de page (qui s'était déjà trompé pour G9v3). Une décimale, comme dans ces données :
 * les arrondis à l'entier faisaient des égalités artificielles. Règle, confirmée par Léo : la variante
 * RAISONNEMENT quand il y en a deux, à son effort le plus élevé publié (Xhigh pour qwen3.8:27b, High pour
 * gpt-oss:20b) ; le commentaire de chaque ligne donne la fiche exacte. Quatre valeurs étaient fausses :
 * qwen3.5:9b (14, ni Reasoning 11,2 ni Non-reasoning 13,3), gemma4:31b (19 au lieu de 14,7), et
 * qwen3-vl:8b/4b (score de la variante Instruct, alors que les tags Ollama `qwen3-vl:8b`/`:4b` sont les
 * variantes THINKING — même digest que `8b-thinking`/`4b-thinking` sur ollama.com/library/qwen3-vl/tags).
 * Conséquence réelle, recalculée avec les VRAIS scores d'outils (étape 222) : aucun choix ne change sur les
 * configurations vérifiées (8/32, 6/16, 12/32, 16/64 Go). La fiabilité d'outils passe AVANT l'intelligence :
 * à 8 Go, Médium reste granite4.2:8b (17/17), et qwen3.5:4b (15/17) comme qwen3.5:9b (16/17) restent derrière.
 * Sans fiche Artificial Analysis : GLM-4.6V-Flash (la fiche « GLM-4.6V » est le modèle 106B, pas lui),
 * qwen3-vl:2b, qwen2.5-coder:14b.
 */
const ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX: Record<string, number> = {
  'qwen3.5:0.8b': 6.1, // Qwen3.5 0.8B (Reasoning)
  'qwen3.5:2b': 6.9, // Qwen3.5 2B (Reasoning)
  'qwen3.5:4b': 13.1, // Qwen3.5 4B (Reasoning)
  'qwen3.5:9b': 11.2, // Qwen3.5 9B (Reasoning)
  'qwen3.5:27b': 22.9, // Qwen3.5 27B (Reasoning)
  'qwen3.5:35b': 19.3, // Qwen3.5 35B A3B (Reasoning)
  'qwen3.6:27b': 21.4, // Qwen3.6 27B (Reasoning)
  'qwen3.6:35b': 18.2, // Qwen3.6 35B A3B (Reasoning)
  'qwen3.6:35b-a3b': 18.2, // Qwen3.6 35B A3B (Reasoning)
  'qwen3.8:27b': 33.7, // Qwen3.8 27B (Xhigh)
  'gpt-oss:20b': 9.0, // gpt-oss-20b (High)
  'gemma4:12b': 14.2, // Gemma 4 12B (Reasoning)
  'gemma4:26b': 16.7, // Gemma 4 26B A4B (Reasoning)
  'gemma4:31b': 14.7, // Gemma 4 31B (Reasoning)
  'gemma4:e4b': 8.9, // Gemma 4 E4B (Reasoning)
  'ministral-3:14b': 6.0, // Ministral 3 14B
  'ministral-3:3b': 4.8, // Ministral 3 3B
  'granite4.1:3b': 5.9, // Granite 4.1 3B
  'granite4.2:3b': 9.1, // Granite 4.2 3B
  'ministral-3:8b': 5.5, // Ministral 3 8B
  'granite4.2:8b': 11.1, // Granite 4.2 8B
  'granite4.1:8b': 6.6, // Granite 4.1 8B
  'mistral-small3.2:24b': 8.2, // Mistral Small 3.2
  'granite4.2:30b': 14.8, // Granite 4.2 30B
  'qwen3:1.7b': 5.2, // Qwen3 1.7B (Reasoning)
  'glm-4.7-flash:q4_K_M': 14.9, // GLM-4.7-Flash (Reasoning)
  'nemotron-3.5-lightning:30b': 12.9, // Nemotron 3.5 Lightning
  'qwen3-vl:8b': 8.2, // Qwen3 VL 8B (Reasoning)
  'qwen3-vl:4b': 7.0, // Qwen3 VL 4B (Reasoning)
  'qwen3-coder:30b': 9.6, // Qwen3 Coder 30B A3B Instruct
  'north-mini-code-1.0': 9.9, // North Mini Code
  'qwen2.5-coder:32b': 6.7, // Qwen2.5 Coder Instruct 32B
  'devstral-small-2:24b': 7.5, // Devstral Small 2
  'qwen2.5-coder:7b': 5.8, // Qwen2.5 Coder Instruct 7B
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF': 10.8, // G9v3-3B
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M': 11.1, // Ling 3.0 Tiny
  'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M': 12.5, // MiniCPM5-2B (Reasoning) — 12,46 relevé le 02/10/2026, aucune vitesse publiée
  'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M': 8.4, // Nanbeige4.1-3B (Reasoning) — 8,40 relevé le 03/10/2026
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M': 8.4 // LFM2.5-2.6B (Reasoning) — 8,39 relevé le 03/10/2026
}

/**
 * Vitesse de génération (tokens/s) publiée par Artificial Analysis pour ce modèle — relevée en même temps
 * que ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX ci-dessus, le 21/09/2026, avec la même discipline (jamais un
 * chiffre estimé ou repris d'un agrégateur tiers). Mesure Artificial Analysis, indépendante du matériel de
 * qui regarde : depuis l'étape 131, c'est la SEULE vitesse affichée (l'estimation par formule pour la machine
 * de l'utilisateur, et la table de bande passante GPU qu'elle exigeait, ont été retirées avec elle — voir
 * MyModelPicks.tsx pour le pourquoi). Absence ici = Artificial Analysis
 * publie l'Intelligence Index de ce modèle mais pas encore de mesure de vitesse fiable ("N/A" sur sa fiche).
 *
 * Étape 220 : relevée le 02/10/2026 en même temps que l'Intelligence Index ci-dessus, sur la phrase de la fiche
 * du modèle lui-même (« X generates output at N tokens per second »). Ces vitesses bougent avec les
 * fournisseurs : ministral-3:14b était à 87, il est à 65. mistral-small3.2:24b, devstral-2:123b,
 * devstral-small-2:24b et gemma4:26b n'ont plus de vitesse publiée (N/A) : retirées. Les chiffres présents
 * sur leur page appartiennent aux modèles cités en comparaison, pas à eux.
 */
const ARTIFICIAL_ANALYSIS_SPEED: Record<string, number> = {
  'qwen3.5:4b': 22,
  'qwen3.5:9b': 52,
  'qwen3.5:27b': 75,
  'qwen3.5:35b': 148,
  'qwen3.6:27b': 58,
  'qwen3.6:35b': 128,
  'qwen3.6:35b-a3b': 128,
  'qwen3.8:27b': 46,
  'gpt-oss:20b': 187,
  'gemma4:12b': 115,
  'gemma4:31b': 35,
  'gemma4:e4b': 69,
  'ministral-3:14b': 65,
  'ministral-3:3b': 194,
  'granite4.2:3b': 221,
  'ministral-3:8b': 100,
  'granite4.2:8b': 62,
  'granite4.2:30b': 77,
  'glm-4.7-flash:q4_K_M': 61,
  'nemotron-3.5-lightning:30b': 301,
  'qwen3-vl:8b': 115,
  'qwen3-coder:30b': 85,
  'north-mini-code-1.0': 84,
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M': 58
}

/**
 * Résultat connu d'un modèle pour un rôle. Depuis l'étape 166, il vient uniquement de
 * scripts/verified-tool-scores.md (l'analyse locale a été retirée) : `speedTokPerSec` reste donc toujours
 * `null` — la vitesse affichée est celle publiée par Artificial Analysis.
 */
export interface LocalBenchmarkEntry {
  speedTokPerSec: number | null
  toolCalling: string | null
}

/** Les trois paliers couverts par scripts/verified-tool-scores.md, voir parseVerifiedToolScores. */
/**
 * `scenarios` (étape 232) : « Demandes complètes », jouées de bout en bout par scripts/benchmark-scenarios.mjs. Lues
 * ici pour savoir quels modèles restent à tester ; le choix des modèles ne s'en sert pas encore.
 */
export type VerifiedTier = 'conversation' | 'vision' | 'code' | 'scenarios'

/**
 * Relit scripts/verified-tool-scores.md (commité dans le dépôt, voir son en-tête pour le pourquoi) : scores
 * de fiabilité vérifiés une fois par Léo sur sa machine, valables pour tout le monde — jamais de vitesse
 * dedans (l'app affiche la vitesse publiée par Artificial Analysis, voir ARTIFICIAL_ANALYSIS_SPEED). Trois
 * tableaux séparés par palier (sections "## Conversation/Vision/Code"), PAS une seule map globale par nom de
 * modèle : `qwen3.5:4b` (et `gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — un score
 * conversation ne doit jamais être confondu avec, ni écraser, un score vision pour le même nom de modèle
 * (bug déjà rencontré une fois dans benchmark-results.md avant qu'on ne le corrige ici).
 */
export function parseVerifiedToolScores(): Record<VerifiedTier, Map<string, string>> {
  const results: Record<VerifiedTier, Map<string, string>> = {
    conversation: new Map(),
    vision: new Map(),
    code: new Map(),
    scenarios: new Map()
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
      currentTier = heading.startsWith('conversation')
        ? 'conversation'
        : heading.startsWith('vision')
          ? 'vision'
          : heading.startsWith('code')
            ? 'code'
            : heading.startsWith('demandes')
              ? 'scenarios'
              : null
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
 * Nombre de réponses notées par le test de conversation ACTUEL : 26 questions posées 3 fois chacune (étape 230,
 * CONVERSATION_TOTAL dans scripts/benchmark-cases.mjs — copie vérifiée par scripts/test-benchmark-cases.mjs).
 * Un score de conversation sur un autre total (« 16/17 », version 4) vient d'un ancien test.
 */
export const CONVERSATION_TEST_TOTAL = 78

/**
 * Vision : 10 questions de lecture et 7 de visée (une étape de pilotage de l'écran), posées 2 fois (VISION_TOTAL,
 * scripts/benchmark-vision.mjs, étapes 232-233). Avant : sur 20, 18 puis 3.
 */
export const VISION_TEST_TOTAL = 34

/** Étapes 232-233 : demandes complètes, 40 demandes dont 8 rejouées (SCENARIO_TOTAL, scripts/benchmark-scenarios.mjs). */
export const SCENARIO_TEST_TOTAL = 48

/** Étape 232 : code, 5 applications générées puis ouvertes et utilisées (CODE_TOTAL, scripts/benchmark-code.mjs). Avant : sur 3. */
export const CODE_TEST_TOTAL = 5

/** Versions des tests en cours (copies de SCENARIO/VISION/CODE_TEST_VERSION des scripts, vérifiées par test). */
export const SCENARIO_TEST_VERSION = 3
export const VISION_TEST_VERSION = 4
export const CODE_TEST_VERSION = 3

/** Modèles qui ont TOUT fait, sans cas encore à refaire, dans le fichier brut d'une campagne (rôle par rôle). */
export interface CampaignCompletion {
  scenarios: Set<string>
  vision: Set<string>
  code: Set<string>
}

/**
 * Léo, 05/10/2026 (« fais-moi le bouton test, pour que je teste les derniers modèles ») : après une campagne, le
 * bouton ne doit proposer QUE ce qui reste à faire — un modèle sauté, ou un cas arrêté par le délai ou planté —,
 * pas les 42 modèles dont les scores ne sont pas encore recopiés dans verified-tool-scores.md. Même règle que le
 * rejeu du script (replayTimedOut, benchmark-models.mjs) : la DERNIÈRE ligne de chaque cas compte ; un délai
 * dépassé reste à refaire, un plantage aussi tant qu'il n'a pas été rejoué une fois.
 */
export function campaignCompletion(tracesText: string): CampaignCompletion {
  const latest = new Map<string, { role: keyof CampaignCompletion; model: string; pending: boolean }>()
  let versions: Record<string, number> | null = null
  for (const line of tracesText.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type === 'campagne') {
      versions = (row.versions as Record<string, number> | undefined) ?? null
      continue
    }
    const model = String(row.model)
    const pending = Boolean(row.timeout) || (/^erreur/.test(String(row.reason ?? '')) && !row.replay)
    if (row.type === 'demande' && versions?.demandes === SCENARIO_TEST_VERSION) {
      latest.set(`scenarios|${model}|${row.id}|${row.pass}`, { role: 'scenarios', model, pending })
    } else if (row.type === 'vision' && versions?.vision === VISION_TEST_VERSION) {
      latest.set(`vision|${model}|${row.kind}|${row.file}|${row.id}|${row.pass}`, { role: 'vision', model, pending })
    } else if (row.type === 'code' && versions?.code === CODE_TEST_VERSION) {
      latest.set(`code|${model}|${row.id}`, { role: 'code', model, pending })
    }
  }
  const totals: Record<keyof CampaignCompletion, number> = { scenarios: SCENARIO_TEST_TOTAL, vision: VISION_TEST_TOTAL, code: CODE_TEST_TOTAL }
  const counts = new Map<string, { cases: number; pending: boolean }>()
  for (const { role, model, pending } of latest.values()) {
    const key = `${role}|${model}`
    const entry = counts.get(key) ?? { cases: 0, pending: false }
    entry.cases++
    entry.pending ||= pending
    counts.set(key, entry)
  }
  const done: CampaignCompletion = { scenarios: new Set(), vision: new Set(), code: new Set() }
  for (const [key, { cases, pending }] of counts) {
    const [role, ...rest] = key.split('|') as [keyof CampaignCompletion, ...string[]]
    if (cases === totals[role] && !pending) done[role].add(rest.join('|'))
  }
  return done
}

/**
 * Nombre d'actions d'affilée d'une demande typique, pour mettre en balance fiabilité et intelligence
 * (03/10/2026, Léo : « on choisit qwen3.5:35b qui a 78/78 et 19 d'intelligence et pas qwen3.8:27b qui a 77/78
 * et 33 », puis « une vraie analyse, pas un calcul bête qui autorise 1-2 points d'écart »).
 * Note d'un modèle = intelligence × (taux de réussite aux outils)^N : la chance de réussir N actions de suite
 * sans erreur, multipliée par la qualité de ce qu'il dit. Une demande de Jaris enchaîne souvent plusieurs
 * outils (chercher puis lire, ouvrir puis écrire ; jusqu'à 10 tours dans converse()) : avec N = 5, 1 erreur
 * sur 78 coûte 6 % de la note, 1 erreur sur 10 en coûte 41 %. La vision ne fait qu'une lecture par demande : N = 1.
 */
export const TOOL_CHAIN_LENGTH = 5
const VISION_CHAIN_LENGTH = 1

const CONVERSATION_ROLE_MODELS = new Set([...FLASH_CANDIDATES, ...MEDIUM_CANDIDATES, ...LARGE_CANDIDATES].map((c) => c.model))
const VISION_ROLE_MODELS = new Set(VISION_CANDIDATES.map((c) => c.model))
const CODE_ROLE_MODELS = new Set(CODE_CANDIDATES.map((c) => c.model))

/**
 * Modèles de Jaris à tester, du plus léger au plus lourd : la liste que teste le bouton « Tester les modèles »
 * (Tous les modèles, étape 168). Étape 230 : rôle par rôle — un modèle de conversation sans score du test ACTUEL
 * (y compris un ancien score sur 17), un modèle de vision sans score du test de vision ACTUEL (sur 18), un modèle
 * de code sans score de code. Avant, un seul score n'importe où suffisait : gemma4:26b et qwen3.8:27b, candidats Vision, n'avaient
 * jamais été testés en vision sans que rien ne le signale. En attendant, Jaris garde les anciens scores.
 */
export function getUnscoredModels(campaign: CampaignCompletion = { scenarios: new Set(), vision: new Set(), code: new Set() }): string[] {
  const scores = parseVerifiedToolScores()
  // Étape 232 : un modèle de conversation a besoin des DEUX scores — les 78 questions et les demandes complètes.
  // Le script ne rejoue que l'épreuve qui manque. Une épreuve déjà TOUT faite dans la campagne en cours (fichier
  // brut, pas encore recopié dans verified-tool-scores.md) n'est plus à faire non plus.
  const needsConversation = (model: string): boolean =>
    CONVERSATION_ROLE_MODELS.has(model) &&
    (!scores.conversation.get(model)?.endsWith(`/${CONVERSATION_TEST_TOTAL}`) ||
      (!scores.scenarios.get(model)?.endsWith(`/${SCENARIO_TEST_TOTAL}`) && !campaign.scenarios.has(model)))
  const needsVision = (model: string): boolean =>
    VISION_ROLE_MODELS.has(model) && !scores.vision.get(model)?.endsWith(`/${VISION_TEST_TOTAL}`) && !campaign.vision.has(model)
  const needsCode = (model: string): boolean =>
    CODE_ROLE_MODELS.has(model) && !scores.code.get(model)?.endsWith(`/${CODE_TEST_TOTAL}`) && !campaign.code.has(model)
  return [...ALL_MODELS]
    .sort((a, b) => a.vramGb - b.vramGb)
    .filter((c) => needsConversation(c.model) || needsVision(c.model) || needsCode(c.model))
    .map((c) => c.model)
}

/**
 * Tous les modèles de Jaris dans UNE seule liste (étape 160, Léo : « enlève puissant, rapide dans tous les
 * modèles, mais garde quand même rapide, moyen pour que les utilisateurs [voient] »). Plus de tableau par
 * palier : chaque modèle apparaît une fois, avec son étiquette (Rapide/Moyen/Puissant, modelCategory), le fait
 * qu'il lise les images, et les rôles où Jaris l'utilise. Trié du plus léger au plus lourd (Léo, étape 132).
 */
export async function getModelOverview(profile?: Profile | null): Promise<ModelOverviewResult> {
  const verifiedToolScores = parseVerifiedToolScores()
  const { vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), verifiedToolScores)
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
  addUsage(activeModels.flash, 'Faible')
  addUsage(activeModels.medium, 'Moyen')
  addUsage(activeModels.large, 'Élevé')
  addUsage(activeModels.vision, 'Vision')
  addUsage(activeModels.code, 'Code')

  // Fiabilité affichée : le test de conversation quand le modèle l'a passé (le cas général), sinon celui de
  // code, sinon celui de vision.
  // Chaque table reste lue séparément (VerifiedTier) : un score vision ne remplace jamais un score conversation.
  const scoreOf = (model: string): { toolCalling: string | null } => {
    for (const tier of ['conversation', 'code', 'vision'] as VerifiedTier[]) {
      const toolCalling = verifiedToolScores[tier].get(model) ?? null
      if (toolCalling) return { toolCalling }
    }
    return { toolCalling: null }
  }

  const entries: ModelOverviewEntry[] = [...ALL_MODELS]
    .sort((a, b) => a.vramGb - b.vramGb)
    .map((c) => ({
      model: c.model,
      vramGb: c.vramGb,
      category: modelCategory(c.vramGb),
      readsImages: READS_IMAGES.has(c.model),
      usedIn: usageByModel.get(c.model) ?? [],
      ...scoreOf(c.model),
      intelligence: INTELLIGENCE_MMLU_PRO[c.model] ?? null,
      artificialAnalysisIndex: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[c.model] ?? null,
      artificialAnalysisSpeed: ARTIFICIAL_ANALYSIS_SPEED[c.model] ?? null
    }))

  return { vramGb, entries, codeModel: picks.code.model }
}

/**
 * Résultat connu pour UN candidat donné : sa fiabilité mesurée (verified-tool-scores.md, valable pour tout le
 * monde) — `undefined` si rien de connu du tout (jamais de chiffre inventé).
 * Utilisé par computeModelPicks (pickBestFrom l'utilise pour départager les candidats).
 */
function resolveBenchmarkResult(
  candidate: ModelCandidate,
  tier: VerifiedTier,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>
): LocalBenchmarkEntry | undefined {
  const verifiedTool = verifiedToolScores[tier].get(candidate.model)
  if (!verifiedTool) return undefined
  // Pas de vitesse : elle n'était qu'estimée par formule, et n'est plus affichée depuis l'étape 131.
  return { speedTokPerSec: null, toolCalling: verifiedTool }
}

/**
 * "6/6" -> 1, "5/6" -> 0,83, absent/invalide -> -1 (toujours perdant face à un vrai score). En PROPORTION
 * depuis l'étape 160 : le rôle Code compare désormais des modèles testés au test de code (sur 3) et d'autres
 * au test de conversation (sur 6) — en nombre brut, un 6/6 aurait toujours battu un 3/3 pourtant parfait.
 */
function parseToolScore(toolCalling: string | null): number {
  if (!toolCalling) return -1
  const [correct, total] = toolCalling.split('/').map(Number)
  if (!Number.isFinite(correct)) return -1
  return Number.isFinite(total) && total > 0 ? correct / total : correct
}

/**
 * Cœur PUR (aucun accès disque/réseau ici — verifiedToolScores déjà lus par l'appelant) du
 * choix du meilleur modèle de chaque palier (+ vision) pour un profil matériel donné (vramGb/ramGb/gpuName)
 * — partagé par pickBestModelsFromBenchmark (ce qui est téléchargé) et getMyModelPicks (ce qui est affiché),
 * pour que les deux ne puissent jamais diverger.
 *
 * D'après de vraies mesures — la fiabilité mesurée par Léo (parseVerifiedToolScores, valable pour tout le
 * monde, elle ne dépend pas du matériel) — jamais en
 * supposant que le plus gros qui rentre est forcément le meilleur. Priorité à la fiabilité, la VRAM du
 * candidat ne départageant qu'à égalité (le plus gros gagne, pas le plus rapide — voir pickBestFrom
 * ci-dessous). Repli sur pickForBudget (par taille) si aucun candidat n'a de
 * résultat exploitable pour ce palier (jamais mesuré) — renvoie alors une
 * entrée sans fiabilité connue plutôt qu'un chiffre inventé.
 *
 * Renvoie l'entrée COMPLÈTE (pas juste le nom du modèle) pour chaque palier : getMyModelPicks en a
 * besoin pour afficher les scores publiés et la fiabilité à côté de chaque modèle, pas seulement son nom.
 */
function computeModelPicks(
  vramGb: number | null,
  ramGb: number,
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>,
  exclude: ReadonlySet<string> = new Set()
): {
  flash: ModelOverviewEntry
  medium: ModelOverviewEntry
  large: ModelOverviewEntry
  vision: ModelOverviewEntry
  code: ModelOverviewEntry
} {
  const budgetGb = vramGb !== null ? Math.max(0, vramGb - GPU_RESERVED_GB) : 0
  // Budget élargi pour les candidats "Puissant" qui tolèrent de déborder sur la RAM (voir
  // LARGE_RAM_OFFLOAD_MODELS) : VRAM (déjà amputée de la réservation STT) + RAM (moins la marge pour
  // l'OS/les autres logiciels) — jamais pour les autres candidats, qui doivent tenir entièrement en VRAM
  // pour un usage voix/chat temps réel sans à-coups.
  const ramOffloadBudgetGb = budgetGb + Math.max(0, ramGb - RESOURCE_SAFETY_MARGIN_GB)
  const budgetForCandidate = (model: string): number => (LARGE_RAM_OFFLOAD_MODELS.has(model) ? ramOffloadBudgetGb : budgetGb)

  const resultFor = (candidate: ModelCandidate, tier: VerifiedTier): LocalBenchmarkEntry | undefined =>
    resolveBenchmarkResult(candidate, tier, verifiedToolScores)

  const entryOf = (model: string, vramGbOfModel: number, result: LocalBenchmarkEntry | undefined): ModelOverviewEntry => ({
    model,
    vramGb: vramGbOfModel,
    toolCalling: result?.toolCalling ?? null,
    intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null,
    artificialAnalysisIndex: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[model] ?? null,
    artificialAnalysisSpeed: ARTIFICIAL_ANALYSIS_SPEED[model] ?? null
  })

  /**
   * `demands` (étape 241) : taux de réussite aux demandes complètes (sur SCENARIO_TEST_TOTAL), pour les rôles de
   * conversation seulement. Absent pour Vision et Code, dont le test mesure autre chose.
   */
  type Scored = { model: string; vramGb: number; result: LocalBenchmarkEntry; demands?: number }

  /**
   * Étape 241, Léo (« oui » à faire compter les demandes complètes, « tu les fusionnes ? ») : réussite aux
   * demandes complètes du test ACTUEL, `null` sans score sur ce total. Un score d'un ancien test ne compte pas.
   */
  const demandRate = (model: string): number | null => {
    const score = verifiedToolScores.scenarios.get(model)
    if (!score?.endsWith(`/${SCENARIO_TEST_TOTAL}`)) return null
    const rate = parseToolScore(score)
    return rate >= 0 ? rate : null
  }

  /**
   * Le plus intelligent d'abord, à fiabilité égale : Intelligence Index d'Artificial Analysis quand les DEUX
   * modèles en ont un, sinon MMLU-Pro, sinon le plus gros (inchangé depuis l'étape 125). Une absence de score
   * ne vaut jamais zéro.
   */
  const smartestFirst = (a: Scored, b: Scored): number => {
    const aIndex = ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[a.model]
    const bIndex = ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[b.model]
    if (aIndex !== undefined && bIndex !== undefined && aIndex !== bIndex) return bIndex - aIndex
    const aIntel = INTELLIGENCE_MMLU_PRO[a.model]
    const bIntel = INTELLIGENCE_MMLU_PRO[b.model]
    if (aIntel !== undefined && bIntel !== undefined && aIntel !== bIntel) return bIntel - aIntel
    return b.vramGb - a.vramGb
  }

  /**
   * Le plus rapide d'abord : vitesse publiée par Artificial Analysis — le repère comparatif choisi par Léo à
   * l'étape 131 —, un modèle sans vitesse publiée passant après ceux qui en ont une ; entre deux modèles sans
   * vitesse publiée, le plus léger (moins de mémoire à lire par mot écrit).
   */
  const fastestFirst = (a: Scored, b: Scored): number => {
    const aSpeed = ARTIFICIAL_ANALYSIS_SPEED[a.model]
    const bSpeed = ARTIFICIAL_ANALYSIS_SPEED[b.model]
    if (aSpeed !== undefined && bSpeed !== undefined && aSpeed !== bSpeed) return bSpeed - aSpeed
    if (aSpeed !== undefined && bSpeed === undefined) return -1
    if (aSpeed === undefined && bSpeed !== undefined) return 1
    return a.vramGb - b.vramGb
  }

  /**
   * Rôle Rapide (étape 161, Léo : « il ne faut pas le plus rapide sans regarder l'intelligence, par exemple
   * un modèle qui a 5 points d'intelligence en plus mais ne perd que 3 points de vitesse »). Parmi les modèles
   * qui restent au moins à RAPIDE_MIN_SPEED_RATIO de la vitesse du plus rapide, le plus INTELLIGENT (à
   * intelligence égale, le plus rapide). Un modèle sans vitesse publiée ne peut pas prouver qu'il est rapide :
   * écarté tant qu'au moins un modèle en a une ; si aucun n'en a, retour au plus léger.
   */
  const fastEnoughThenSmartest = (scored: Scored[], chain: number): Scored[] => {
    // Le plancher de vitesse se calcule sur les modèles les plus fiables (sans quoi un petit modèle très rapide
    // mais peu fiable relèverait la barre pour tout le monde) ; le classement se fait ensuite sur TOUS ceux qui
    // le passent, par note (intelligence × fiabilité).
    const top = Math.max(...scored.map((c) => parseToolScore(c.result.toolCalling)))
    const reference = scored.filter((c) => parseToolScore(c.result.toolCalling) === top)
    const speeds = reference.map((c) => ARTIFICIAL_ANALYSIS_SPEED[c.model]).filter((v): v is number => v !== undefined)
    if (!speeds.length) return [...reference].sort(fastestFirst)
    const floor = Math.max(...speeds) * RAPIDE_MIN_SPEED_RATIO
    return scored
      .filter((c) => (ARTIFICIAL_ANALYSIS_SPEED[c.model] ?? -1) >= floor)
      .sort((a, b) => bestNoteFirstOrNull(a, b, chain) ?? fastestFirst(a, b))
  }

  /**
   * Médium : le plus intelligent parmi ceux qui gardent au moins MEDIUM_MIN_SPEED_RATIO de la vitesse du plus
   * rapide (plancher calculé comme pour Rapide). Un modèle sans vitesse publiée n'est PAS écarté. Si le plancher
   * écartait tout le monde, on retombe sur le classement sans vitesse plutôt que sur rien.
   */
  const notTooSlowThenSmartest = (scored: Scored[], chain: number): Scored[] => {
    const top = Math.max(...scored.map((c) => parseToolScore(c.result.toolCalling)))
    const speeds = scored
      .filter((c) => parseToolScore(c.result.toolCalling) === top)
      .map((c) => ARTIFICIAL_ANALYSIS_SPEED[c.model])
      .filter((v): v is number => v !== undefined)
    if (!speeds.length) return bestNote(scored, chain)
    const floor = Math.max(...speeds) * MEDIUM_MIN_SPEED_RATIO
    const kept = scored.filter((c) => {
      const speed = ARTIFICIAL_ANALYSIS_SPEED[c.model]
      return speed === undefined || speed >= floor
    })
    return bestNote(kept.length ? kept : scored, chain)
  }

  /**
   * Note d'un modèle pour un rôle : intelligence × (taux de réussite)^chain (voir TOOL_CHAIN_LENGTH), puis, pour
   * les rôles de conversation, × le taux de réussite aux demandes complètes (étape 241). Les deux tests sont
   * MULTIPLIÉS et non remplacés l'un par l'autre : les 78 questions mesurent chaque appel d'outil isolé, les
   * 48 demandes la tâche entière — un modèle doit être bon aux deux. Remplacer la fiabilité par les seules
   * demandes (sans la puissance 5) a été mesuré avant d'être écarté : sur 4 Go de VRAM, MiniCPM5-2B (35/48)
   * battait granite4.2:3b (44/48) sur sa seule intelligence. `null` sans intelligence publiée — jamais un zéro.
   */
  const noteOf = (c: Scored, chain: number): number | null => {
    const index = ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[c.model]
    if (index === undefined) return null
    return index * Math.pow(Math.max(0, parseToolScore(c.result.toolCalling)), chain) * (c.demands ?? 1)
  }

  /** Meilleure note d'abord ; un modèle sans note passe après ; `null` si la note ne départage pas. */
  const bestNoteFirstOrNull = (a: Scored, b: Scored, chain: number): number | null => {
    const aNote = noteOf(a, chain)
    const bNote = noteOf(b, chain)
    if (aNote !== null && bNote !== null && aNote !== bNote) return bNote - aNote
    if (aNote !== null && bNote === null) return -1
    if (aNote === null && bNote !== null) return 1
    return null
  }

  /**
   * Médium, Puissant, Vision, Code : la meilleure note parmi TOUS les modèles testés qui tiennent. Sans
   * intelligence publiée pour personne, retour à l'ancienne règle (la meilleure fiabilité, puis le plus
   * intelligent selon MMLU-Pro, puis le plus gros).
   */
  const bestNote = (scored: Scored[], chain: number): Scored[] => {
    if (scored.every((c) => noteOf(c, chain) === null)) {
      const top = Math.max(...scored.map((c) => parseToolScore(c.result.toolCalling)))
      return scored.filter((c) => parseToolScore(c.result.toolCalling) === top).sort(smartestFirst)
    }
    return [...scored].sort((a, b) => {
      const byNote = bestNoteFirstOrNull(a, b, chain)
      if (byNote !== null) return byNote
      const byScore = parseToolScore(b.result.toolCalling) - parseToolScore(a.result.toolCalling)
      return byScore !== 0 ? byScore : smartestFirst(a, b)
    })
  }

  /**
   * Un rôle = une question posée à TOUS les modèles (étape 160) :
   * - `pool` : les modèles capables de ce rôle (tous, sauf Vision qui exige de lire une image) ;
   * - `resultOf` : le score de fiabilité qui compte pour ce rôle — critère de validité, jamais départagé ;
   * - `allowRam` : le modèle peut-il déborder sur la RAM (LARGE_RAM_OFFLOAD_MODELS) ? Non pour Rapide et
   *   Médium, qui doivent répondre sans à-coups ;
   * - `rank` : le classement du rôle sur tous les modèles testés qui tiennent (fiabilité ET intelligence) ;
   * - `chain` : nombre d'actions d'affilée qui pèse sur la fiabilité (TOOL_CHAIN_LENGTH) ;
   * - `withDemands` : la note tient aussi compte des demandes complètes (rôles de conversation, étape 241). Un
   *   modèle pas encore passé aux demandes complètes est estimé par son taux aux 78 questions : jamais ×1, qui
   *   l'avantagerait sur les modèles testés.
   */
  const pickRole = (
    pool: ModelCandidate[],
    resultOf: (c: ModelCandidate) => LocalBenchmarkEntry | undefined,
    allowRam: boolean,
    rank: (scored: Scored[], chain: number) => Scored[],
    chain: number = TOOL_CHAIN_LENGTH,
    withDemands = false
  ): ModelOverviewEntry => {
    // `exclude` (étape 136) : modèles dont le téléchargement vient d'échouer sur CETTE machine (voir
    // runQuickSetup, benchmarkRunner.ts) — retirés AVANT tout calcul, repli ultime compris. Jamais la liste
    // entière : si tout était exclu, on garde la liste d'origine.
    const filtered = pool.filter((c) => !exclude.has(c.model))
    const candidates = filtered.length ? filtered : pool
    const budgetOf = (c: ModelCandidate): number => (allowRam ? budgetForCandidate(c.model) : budgetGb)
    const scored = candidates
      .filter((c) => c.vramGb <= budgetOf(c))
      .map((c) => ({ model: c.model, vramGb: c.vramGb, result: resultOf(c) }))
      .filter((c): c is Scored => c.result?.toolCalling != null)
      .map((c) => (withDemands ? { ...c, demands: demandRate(c.model) ?? Math.max(0, parseToolScore(c.result.toolCalling)) } : c))

    // Repli : aucun modèle testé ne tient (ex. pas de carte graphique du tout). Le plus gros modèle qui tient,
    // sinon le plus petit — parmi ceux qui ont un score pour ce rôle quand il y en a, pour ne jamais tomber
    // sur un modèle jamais testé pour ça.
    if (!scored.length) {
      const known = candidates.filter((c) => resultOf(c)?.toolCalling != null)
      const fallbackPool = known.length ? known : candidates
      const model = pickForBudget(fallbackPool, budgetGb)
      const candidate = fallbackPool.find((c) => c.model === model)
      return entryOf(model, candidate?.vramGb ?? 0, candidate ? resultOf(candidate) : undefined)
    }

    // Fiabilité et intelligence mises en balance (TOOL_CHAIN_LENGTH), plus de « meilleur score exact d'abord ».
    const winner = rank(scored, chain)[0] ?? scored[0]
    return entryOf(winner.model, winner.vramGb, winner.result)
  }

  const smartest = bestNote
  const conversation = (c: ModelCandidate): LocalBenchmarkEntry | undefined => resultFor(c, 'conversation')
  // Code : le test de code quand le modèle l'a passé, sinon son test de conversation (il suit déjà des
  // consignes précises : c'est ce qui permet à un modèle Puissant, jamais passé par le test de code, d'être
  // choisi — Léo : « le meilleur pour le code, ça peut être des modèles puissants »).
  const code = (c: ModelCandidate): LocalBenchmarkEntry | undefined => resultFor(c, 'code') ?? resultFor(c, 'conversation')

  return {
    // Rapide : le plus intelligent parmi les quasi aussi rapides que le plus rapide, sur la carte seule.
    flash: pickRole(ALL_MODELS, conversation, false, fastEnoughThenSmartest, TOOL_CHAIN_LENGTH, true),
    // Médium : le plus intelligent qui tient entièrement sur la carte, parmi ceux qui ne sont pas trop lents.
    medium: pickRole(ALL_MODELS, conversation, false, notTooSlowThenSmartest, TOOL_CHAIN_LENGTH, true),
    // Puissant : le plus intelligent de tous, même en débordant sur la RAM.
    large: pickRole(ALL_MODELS, conversation, true, smartest, TOOL_CHAIN_LENGTH, true),
    // Vision : le plus intelligent parmi ceux qui lisent une image.
    vision: pickRole(
      ALL_MODELS.filter((c) => READS_IMAGES.has(c.model)),
      (c) => resultFor(c, 'vision'),
      true,
      smartest,
      VISION_CHAIN_LENGTH
    ),
    // Code : le plus intelligent de tous, même lent (choix de Léo, étape 160).
    code: pickRole(ALL_MODELS, code, true, smartest)
  }
}

export async function pickBestModelsFromBenchmark(exclude: ReadonlySet<string> = new Set()): Promise<CapacityScanResult> {
  const { name, vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), parseVerifiedToolScores(), exclude)
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
  const { vramGb } = await detectGpu()
  const picks = computeModelPicks(vramGb, detectRamGb(), parseVerifiedToolScores())
  return picks.code.model
}

/**
 * Les modèles que Jaris choisit pour CETTE machine, rôle par rôle (Rapide/Médium/Puissant/Vision/Code), avec
 * leurs scores — pour l'écran d'accueil et Options → Modèles.
 *
 * Étape 137, Léo : "a la place de plalier 1 2 3 on vas faire un palier personnaliser a chacun, il ya plus de
 * palier jaris regarde la vram les apelle outils Intelligence (Artificial Analysis) et choisit le meilleur
 * model". Remplace previewHardwareTiers (une dizaine de "paliers" hypothétiques calculés à des VRAM
 * représentatives, avec la machine repérée parmi eux) : il n'y a plus de tableau de comparaison, seulement le
 * résultat pour la VRAM ET la RAM réellement détectées — exactement le même calcul que ce qui est téléchargé
 * (pickBestModelsFromBenchmark), donc ce qui s'affiche est toujours ce qui est installé. La RAM de référence
 * fixe de l'étape 135 (qui n'existait que pour rendre la liste de paliers identique d'un PC à l'autre)
 * disparaît avec elle : un choix personnalisé tient compte de la vraie RAM, qui permet à Puissant/Code de
 * déborder au-delà de la VRAM.
 */
export async function getMyModelPicks(profile?: Profile | null): Promise<MyModelPicks> {
  const { name, vramGb } = await detectGpu()
  const ramGb = detectRamGb()
  const verifiedToolScores = parseVerifiedToolScores()
  const ideal = computeModelPicks(vramGb, ramGb, verifiedToolScores)

  // Étape 138, Léo : "dans le palier rapide j'ai G9v3-3B mais il utilise pas G9v3-3B ça a rien telecharger".
  // La carte affichait le modèle IDÉAL, alors que Jaris utilise celui enregistré dans le profil — les deux
  // divergent tant que « Retester la configuration » n'a pas été relancé, ou quand le meilleur modèle n'a
  // pas pu être téléchargé (import Hugging Face bloqué par Ollama 0.34.2 : runQuickSetup retombe alors sur
  // le suivant). La carte montre maintenant le modèle RÉELLEMENT utilisé, et signale à part le meilleur
  // quand ce n'est pas lui, avec la raison s'il est bloqué — jamais plus un modèle affiché mais pas utilisé.
  const inUse: Record<ModelRole, string> = {
    flash: profile?.models?.flash ?? ideal.flash.model,
    medium: profile?.models?.medium ?? ideal.medium.model,
    large: profile?.models?.large ?? ideal.large.model,
    vision: profile?.visionModel ?? ideal.vision.model,
    code: profile?.codeModel ?? ideal.code.model
  }
  // Code : même repli que le calcul (`code` dans computeModelPicks) — un modèle de conversation choisi pour le
  // code n'a jamais passé le test de code, sa ligne affiche alors son score de conversation, jamais « — ».
  const tierOf: Record<ModelRole, VerifiedTier[]> = {
    flash: ['conversation'],
    medium: ['conversation'],
    large: ['conversation'],
    vision: ['vision'],
    code: ['code', 'conversation']
  }
  const upgrades: MyModelPicks['upgrades'] = {}
  const entries = {} as Record<ModelRole, ModelOverviewEntry>
  for (const role of Object.keys(inUse) as ModelRole[]) {
    const model = inUse[role]
    entries[role] = model === ideal[role].model ? ideal[role] : entryForModel(model, tierOf[role], verifiedToolScores)
    if (model !== ideal[role].model) {
      upgrades[role] = { model: ideal[role].model, blockedReason: profile?.blockedModels?.[ideal[role].model] ?? null }
    }
  }
  // Étape 231 : le modèle de pilotage d'écran est utilisé lui aussi — jamais proposé à la suppression.
  const alsoUsed = [...Object.values(profile?.modelChoices ?? {}), ...(profile?.pilotModel ? [profile.pilotModel] : [])]
  return { gpuName: name, vramGb, ramGb, ...entries, upgrades, installCheck: await checkInstalled(inUse, alsoUsed) }
}

/** Ollama liste un modèle sans tag sous `:latest` : les deux écritures désignent le même modèle. */
function sameModel(a: string, b: string): boolean {
  const withTag = (m: string): string => (m.slice(m.lastIndexOf('/') + 1).includes(':') ? m : `${m}:latest`)
  return withTag(a) === withTag(b)
}

/**
 * Étape 140 : ce qu'Ollama a RÉELLEMENT sur le disque, comparé aux modèles affichés. `null` si Ollama ne
 * répond pas — jamais "tout est installé" ni "rien n'est installé" deviné faute de réponse.
 */
async function checkInstalled(
  inUse: Record<ModelRole, string>,
  // Modèles choisis à la main dans Chat/Code/Vocal (étape 141) : utilisés, donc jamais proposés à la suppression.
  chosenByHand: string[] = []
): Promise<MyModelPicks['installCheck']> {
  let installed: string[]
  try {
    installed = await listInstalledModels()
  } catch {
    return null
  }
  const used = [...Object.values(inUse), ...chosenByHand]
  return {
    notInstalled: (Object.keys(inUse) as ModelRole[]).filter((role) => !installed.some((m) => sameModel(m, inUse[role]))),
    otherInstalled: installed.filter((m) => !used.some((u) => sameModel(m, u)))
  }
}

/** Vrai si `model` est installé mais utilisé par AUCUN rôle du profil — seul cas où sa suppression est permise. */
export async function isUnusedInstalledModel(model: string, profile?: Profile | null): Promise<boolean> {
  const picks = await getMyModelPicks(profile)
  return picks.installCheck?.otherInstalled.includes(model) ?? false
}

/** Entrée complète (scores publiés, fiabilité connue) pour un modèle quelconque — le modèle du profil n'est
 * pas forcément le gagnant du calcul, mais sa ligne doit afficher ses VRAIS scores, pas ceux de l'idéal. */
function entryForModel(
  model: string,
  tiers: VerifiedTier[],
  verifiedToolScores: Record<VerifiedTier, Map<string, string>>
): ModelOverviewEntry {
  return {
    model,
    vramGb: ALL_MODELS.find((c) => c.model === model)?.vramGb ?? 0,
    toolCalling: tiers.map((t) => verifiedToolScores[t].get(model)).find(Boolean) ?? null,
    intelligence: INTELLIGENCE_MMLU_PRO[model] ?? null,
    artificialAnalysisIndex: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX[model] ?? null,
    artificialAnalysisSpeed: ARTIFICIAL_ANALYSIS_SPEED[model] ?? null
  }
}
