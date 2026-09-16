/** Types partagés entre le process principal (electron/) et le renderer (src/). */

export type JarisEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

/**
 * Identifiants des sons courts du design sonore de Jaris (étape 31) — synthétisés à la volée côté renderer
 * (voir src/lib/soundDesign.ts, Web Audio API), jamais de vrais fichiers audio embarqués : reste léger et ne
 * dépend d'aucun asset à maintenir. 'listening'/'thinking'/'success'/'error' suivent les mêmes transitions
 * que JarisEmotion (voix) ; 'click'/'scan' accompagnent un appel d'outil précis (click_mouse/look_at_screen/
 * computer_use_task), en Voix comme en Chat puisque les deux partagent converse() (tools.ts). 'send' est
 * Chat uniquement (ChatPanel.tsx) : joué directement au clic sur Envoyer/Entrée, sans passer par l'IPC
 * main -> renderer comme les autres (l'action vient de CETTE fenêtre, pas besoin d'un aller-retour).
 */
export type SoundCue = 'listening' | 'thinking' | 'success' | 'error' | 'click' | 'scan' | 'send'

export interface VoiceReplyPayload {
  transcript: string
  reply: string
  /** WAV brut (converti en Blob côté renderer pour la lecture). */
  audio: ArrayBuffer
}

/** Résultat du dernier VRAI essai de démarrage du pipeline vocal (voir startVoicePipeline, main.ts) —
 * `ready: true` par défaut tant qu'aucun échec n'a eu lieu, plus de pré-vérification de fichiers depuis
 * le retrait du mot d'activation (openWakeWord). */
export interface VoiceSetupStatusPayload {
  ready: boolean
  missing: string[]
}

/** Les 3 paliers de modèles Ollama choisis par le scan de capacité (étape 13), selon la VRAM détectée. */
export interface ModelTiers {
  flash: string
  medium: string
  large: string
}

export interface Profile {
  name: string
  /** Voix Supertonic HD choisie dans le menu Options (ex: "M3"), vide = valeur par défaut de .env. */
  ttsVoice?: string
  /** true une fois le scan de capacité (étape 13) effectué après le premier lancement. */
  capacityScanDone?: boolean
  /** Modèles rapide/médium/puissant choisis par le scan de capacité, vide = OLLAMA_MODEL de .env pour les trois. */
  models?: ModelTiers
  /** Modèle de vision choisi par le scan de capacité selon la VRAM, vide = OLLAMA_VISION_MODEL de .env. */
  visionModel?: string
  /**
   * Tous les modèles candidats (hardwareScan.ts) connus lors du dernier scan de capacité (étape 13/29) :
   * sert à repérer, au lancement suivant, les modèles ajoutés depuis (nouvelle version de Jaris) pour
   * prévenir l'utilisateur au lieu d'attendre qu'il pense à relancer l'analyse lui-même. `undefined` pour
   * un profil créé avant cette fonctionnalité, jamais traité comme "aucun modèle connu".
   */
  knownModelCandidates?: string[]
  /** Index PortAudio (sounddevice) du micro choisi dans Options → Voix, `undefined`/`null` = défaut système. */
  audioInputDeviceIndex?: number | null
  /** deviceId MediaDevices (WebRTC) du haut-parleur choisi dans Options → Voix, vide = sortie par défaut du système. */
  audioOutputDeviceId?: string
  /**
   * Meilleur modèle du mode Code pour cette machine (pickBestCodeModel, hardwareScan.ts), calculé et
   * enregistré par runQuickSetup/runModelAnalysis (benchmarkRunner.ts) exactement comme `visionModel`
   * ci-dessus — pas de choix manuel dans Options, resolveCodeModel (codeGenerator.ts) lit cette valeur
   * directement. `undefined` seulement pour un profil créé avant l'étape 46.
   */
  codeModel?: string
  /** Design sonore (étape 31) : absent/true par défaut, false pour couper les bips d'interface (Options → Voix). */
  soundEffectsEnabled?: boolean
  /**
   * Options → Activation (étape 81) : les 3 façons de déclencher l'écoute sont toutes activables/
   * désactivables indépendamment, absent/true par défaut pour chacune. `activationWakeWordEnabled` est
   * le seul des trois qui redémarre le pipeline vocal quand il change (voir setWakewordEnabled,
   * main.ts) : c'est au démarrage du sidecar Python que le détecteur ONNX est chargé ou non, pas
   * quelque chose qui se bascule à chaud comme les deux autres.
   */
  activationKeyEnabled?: boolean
  activationWakeWordEnabled?: boolean
  activationOrbClickEnabled?: boolean
  /**
   * Longueur de contexte choisie manuellement dans Options -> Modèles (curseur "comme sur Ollama", étape
   * suivante) — toujours l'un de CONTEXT_LENGTH_STEPS (hardwareScan.ts), jamais une valeur arbitraire tapée
   * à la main. `undefined` = jamais touché, Jaris garde OLLAMA_NUM_CTX (.env, 8192 par défaut) exactement
   * comme avant l'ajout de ce réglage.
   */
  contextLength?: number
}

/** Résultat de getContextLengthOptions (hardwareScan.ts) : voir son commentaire pour le calcul du plafond. */
export interface ContextLengthOptions {
  /** Palier actuellement retenu (profil ou repli .env), toujours l'un de CONTEXT_LENGTH_STEPS. */
  current: number
  /** Palier maximum sûr pour la VRAM libre actuelle et le modèle du palier Puissant. */
  max: number
  /** Uniquement les paliers de CONTEXT_LENGTH_STEPS qui ne dépassent pas `max`, pour peupler le curseur. */
  availableSteps: number[]
}

/** Un appel de l'historique du téléphone, recopié sur le PC par Mobile connecté (étape 21quater). */
export interface PhoneCall {
  name: string
  number: string
  /** Date ISO, vide si l'horodatage de la base n'a pas pu être interprété (voir toDate, phoneData.ts). */
  date: string
  durationSeconds: number
}

/** Un contact du téléphone, recopié sur le PC par Mobile connecté. */
export interface PhoneContact {
  name: string
  numbers: string[]
}

/** Une base SQLite trouvée dans le cache de Mobile connecté (étape 21ter) — structure seulement. */
export interface PhoneCacheDatabase {
  path: string
  sizeBytes: number
  /** `rows: -1` = table illisible (verrouillée par l'application en cours d'exécution, par exemple). */
  tables: { name: string; rows: number }[]
  error?: string
}

/**
 * Ce que Jaris trouve du cache de Mobile connecté sur le disque. Volontairement SANS aucun contenu de
 * message : on cherche d'abord à savoir si les données sont là et sous quelle forme, avant de décider s'il
 * y a une vraie fonctionnalité à construire dessus. Léo peut donc l'envoyer tel quel sans exposer ses
 * conversations.
 */
export interface PhoneCacheReport {
  packages: string[]
  databases: PhoneCacheDatabase[]
  message: string
}

export interface RuntimeSetupStatus {
  pythonReady: boolean
  ollamaReady: boolean
  ready: boolean
}

/** Avancement de l'installation du premier lancement (voir runFirstRunSetup, firstRunSetup.ts). */
export interface RuntimeSetupProgress {
  step: 'ollama' | 'python'
  message: string
  /** Pourcentage quand il est connu (téléchargement) : absent pour une étape dont on ne peut pas mesurer l'avancement. */
  percent?: number
  /** true si CETTE étape a échoué : l'installation continue quand même avec les autres. */
  failed?: boolean
}

export interface MemoryGraphNode {
  id: string
  /** true pour le nœud central représentant l'utilisateur (pas une vraie note markdown). */
  isCenter?: boolean
}

export interface MemoryGraphLink {
  source: string
  target: string
}

/** Notes de la mémoire de Jaris et leurs liens [[...]], pour la vue graphe 3D (étape 10). */
export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  links: MemoryGraphLink[]
}

/** Un échange voix (question/réponse) journalisé sur le disque, pour l'onglet "Historique" du menu Options. */
export interface ConversationEntry {
  id: string
  timestamp: string
  transcript: string
  reply: string
}

/**
 * Emplacement réel actuel des trois briques lourdes de Jaris (modèles Ollama, environnement Python, cache
 * de reconnaissance/synthèse vocale), lu en direct sur le disque (voir modelsLocation.ts) — jamais une
 * simple valeur de profil qui pourrait dériver de la réalité si l'utilisateur ou un autre outil touche à
 * ces dossiers en dehors de Jaris.
 */
export interface ModelsLocationStatus {
  ollamaModelsDir: string
  pythonRuntimeDir: string
  hfCacheDir: string
}

/** Un micro détecté par PortAudio (sounddevice --list-devices), pour le sélecteur d'Options → Voix. */
export interface AudioInputDevice {
  index: number
  name: string
}

/** Un point de mesure du niveau sonore pendant un test micro (voir mic_test_level dans voice_server.py). */
export interface MicTestLevelPayload {
  level: number
}

/** Verdict final d'un test micro (voir mic_test_done dans voice_server.py). */
export interface MicTestDonePayload {
  detected: boolean
}

/**
 * Périmètre d'un run d'analyse (runModelAnalysis) : 'all' teste tout comme avant, un palier précis ne teste
 * QUE ses propres candidats (bien plus rapide) — utile pour re-tester un seul palier après un changement qui
 * ne concerne que lui (ex: débloquer "Puissant" via VRAM+RAM) sans refaire tourner tout le reste. Les
 * résultats des autres paliers, déjà dans scripts/benchmark-results.md, sont conservés tels quels (voir le
 * commentaire sur la fusion dans benchmark-models.mjs) — jamais effacés par un run ciblé.
 */
export type AnalysisScope = 'all' | 'flash' | 'medium' | 'large' | 'vision' | 'code'

/**
 * Résultat de l'analyse complète des modèles (étape 13, obligatoire au premier lancement — voir
 * CapacityScan.tsx) : GPU détecté et meilleur modèle mesuré pour chaque palier + vision.
 */
export interface CapacityScanResult {
  gpuName: string | null
  vramGb: number | null
  models: ModelTiers
  visionModel: string
  /**
   * Meilleur modèle de code (CODE_CANDIDATES, hardwareScan.ts) qui tient réellement dans la VRAM+RAM de
   * cette machine — même logique que flash/medium/large/vision ci-dessus, exactement à la demande de Léo
   * ("pourquoi on choisit pas le meilleur modèle qu'on peut sur les paliers et télécharger comme vision") :
   * avant l'étape 46, le mode Code ignorait totalement la taille de la machine (2 choix fixes seulement).
   */
  codeModel: string
  /**
   * Modèles qu'il aurait fallu télécharger pour cette configuration mais qui ont été ignorés (trop gros pour
   * la VRAM+RAM combinées, ou pas assez d'espace disque) — voir runQuickSetup, benchmarkRunner.ts. Absent ou
   * vide si tout s'est téléchargé sans accroc : sans ce champ, la configuration se marquait "terminée" avec
   * succès même quand un palier entier manquait, sans jamais le dire clairement à l'utilisateur (étape 45).
   */
  skippedModels?: { model: string; reason: string }[]
}

/**
 * Une ligne de previewHardwareTiers (hardwareScan.ts) : illustre "à quoi ressemble le choix de Jaris" à une
 * VRAM représentative, affichée sur l'écran d'accueil (CapacityScan.tsx) et l'onglet Modèles (OptionsMenu.tsx)
 * pour montrer clairement où se situe la machine de l'utilisateur — jamais utilisée pour choisir un modèle
 * pour de vrai (ça reste le rôle de pickBestModelsFromBenchmark, sur la VRAM/RAM exactes). `vramGb` est une
 * FRONTIÈRE RÉELLE (voir previewVramSteps) où le modèle choisi peut changer, pas un point arbitraire (6/12/24
 * Go) : deux machines dont la VRAM tombe entre deux lignes obtiennent garanti le même modèle. `current`
 * marque la ligne qui correspond à la machine RÉELLE détectée. Chaque palier (flash/medium/large/vision)
 * porte l'entrée COMPLÈTE (vitesse, fiabilité...), pas juste le nom du modèle — voir ModelOverviewEntry
 * ci-dessous.
 */
export interface HardwareTierPreview {
  label: string
  vramGb: number
  current: boolean
  flash: ModelOverviewEntry
  medium: ModelOverviewEntry
  large: ModelOverviewEntry
  vision: ModelOverviewEntry
  code: ModelOverviewEntry
}

/**
 * Un modèle candidat pour UN palier donné (voir ModelOverviewGroup), pour le tableau comparatif de l'onglet
 * Modèles du menu Options. speedTokPerSec/toolCalling viennent soit d'un vrai run local de
 * `npm run benchmark:models` (scripts/benchmark-models.mjs) sur cette machine, soit — pour un modèle déjà
 * vérifié par ailleurs (scripts/verified-tool-scores.md) — d'un score de fiabilité partagé (valable pour
 * tout le monde, ne dépend pas du matériel) combiné à une vitesse estimée par formule pour CETTE machine
 * (voir estimateSpeedTokPerSec dans hardwareScan.ts). `null` si rien de tout ça n'existe pour ce modèle
 * (jamais de chiffre inventé). `speedEstimated` distingue les deux cas pour ne jamais les confondre à
 * l'affichage : true = calculé par formule, false/undefined = vraie mesure locale.
 */
export interface ModelOverviewEntry {
  model: string
  vramGb: number
  speedTokPerSec: number | null
  speedEstimated?: boolean
  toolCalling: string | null
  intelligence: number | null
  /**
   * true si ce modèle est présent dans scripts/verified-tool-scores.md pour SON palier — indépendamment de
   * speedEstimated (qui ne dit que "pas de mesure locale, on affiche le score vérifié à la place") : même un
   * modèle déjà mesuré localement une fois reste, lui aussi, exclu du prochain run de
   * scripts/benchmark-models.mjs s'il est vérifié. Sert à ModelAnalysisProgress.tsx (OptionsMenu.tsx) pour
   * distinguer, dans le tableau de suivi en direct, un modèle qui ne sera JAMAIS touché par ce run (jamais
   * de ##MODEL_TESTING##/##MODEL_DONE## le concernant) d'un modèle simplement pas encore commencé.
   */
  verifiedSkip?: boolean
}

/**
 * Les candidats d'UN palier (Rapide/Médium/Puissant/Vision/Code) — une liste séparée par palier plutôt
 * qu'une liste unique tous paliers confondus, pour que chaque tableau n'affiche que les colonnes qui ont un
 * sens pour lui (ex: Vision n'a pas de score d'intelligence MMLU-Pro, ça ne s'y applique pas — mais a bien
 * sa propre vitesse/fiabilité mesurées, voir VISION_TEST_CASES dans scripts/benchmark-models.mjs).
 * Un même modèle peut apparaître dans plusieurs groupes s'il est candidat à plusieurs paliers (ex: le plus
 * petit modèle, repli ultime de Rapide/Médium/Puissant).
 */
export interface ModelOverviewGroup {
  tier: string
  entries: ModelOverviewEntry[]
}

/** Résultat de getModelOverview : les candidats groupés par palier, plus la VRAM totale détectée sur la
 * machine, pour que l'onglet Modèles puisse expliquer pourquoi certains candidats (trop gros) ne sont
 * jamais testés. */
export interface ModelOverviewResult {
  vramGb: number | null
  groups: ModelOverviewGroup[]
  /**
   * Modèle de code choisi automatiquement pour cette machine (étape 46, voir pickBestCodeModel dans
   * hardwareScan.ts) si aucun choix explicite n'est enregistré dans le profil — toujours défini, jamais null.
   */
  codeModel: string
}

/**
 * Résultat de getOllamaVersionStatus (electron/services/dependencyServices.ts) : compare la version locale
 * d'Ollama à la dernière publiée sur GitHub, pour avertir l'utilisateur AVANT qu'un modèle échoue à se
 * télécharger faute d'une version trop ancienne (ex: qwen3.8:27b) — `null` tant que le check réseau n'a pas
 * abouti (ou a échoué, ex: pas de connexion) : jamais affiché comme "à jour" par défaut, juste absent.
 */
export interface OllamaVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

/**
 * Version de Jaris lui-même comparée à la dernière Release GitHub stable (étape 20, voir appUpdater.ts) —
 * même principe qu'OllamaVersionStatus ci-dessus, `null` tant que le check réseau n'a pas abouti.
 */
export interface AppVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

/** Une entrée du journal des mises à jour (Options → Mise à jour), une par Release GitHub stable publiée. */
export interface ReleaseHistoryEntry {
  version: string
  publishedAt: string
  notes: string
}

/** Résultat d'une recherche manuelle de mise à jour (bouton "Rechercher une mise à jour", Options → Mise à jour). */
export interface UpdateCheckResult {
  status: AppVersionStatus | null
  error: string | null
}

/**
 * Avancement de la mise à jour de Jaris (étape 98), affiché pendant que le bouton "Mettre à jour" travaille.
 *
 * Léo : "quand on demande une mise à jour on ne sait pas quand c'est terminé". L'installeur pèse ~98 Mo
 * (mesuré) et se téléchargeait sans le moindre signe de vie : plusieurs minutes de bouton figé, impossible
 * de distinguer "ça avance" de "c'est planté".
 */
export interface UpdateProgress {
  /**
   * Ce qui se met à jour (étape 112). Le canal est le MÊME pour les deux boutons, donc chaque écran ne doit
   * afficher que les avancements qui le concernent : sans ce champ, mettre Ollama à jour ferait aussi bouger
   * la barre de l'onglet "Mise à jour" de Jaris, qui ne télécharge pourtant rien.
   */
  target: 'jaris' | 'ollama'
  /** 'download' pendant le téléchargement, 'install' une fois l'installeur lancé. */
  phase: 'download' | 'install'
  receivedBytes: number
  /** Taille annoncée par le serveur, `null` s'il ne l'annonce pas (aucune barre possible dans ce cas). */
  totalBytes: number | null
  /** 0-100, `null` quand la taille totale est inconnue. */
  percent: number | null
}

/** Un message du mode Chat (étape 30) — même Jaris et mêmes outils que la voix, mais en écrit. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * Aperçu (data URL) d'une image jointe par l'utilisateur, étape 91 — UNIQUEMENT pour l'affichage dans le
   * fil pendant la session en cours. Jamais renvoyé par le main process ni écrit dans
   * conversation-history.json : y stocker du base64 ferait grossir ce fichier de plusieurs mégaoctets par
   * image, pour une vignette que personne ne relit. Rouvrir Jaris remontre donc la question et la réponse,
   * sans la vignette.
   */
  image?: string
}

/**
 * Une conversation du Chat (étape 96). Jaris n'avait qu'un seul fil continu depuis l'étape 47 ; Léo a
 * demandé de pouvoir en tenir plusieurs. Le titre est dérivé du premier message (voir titleFromMessage,
 * conversationStore.ts) : rien à saisir à la main.
 *
 * Le canal VOCAL écrit toujours dans la conversation ACTIVE : changer de fil dans le Chat change donc aussi
 * celui que la voix continue, ce qui préserve la continuité voix <-> écrit acquise à l'étape 47.
 */
export interface ConversationSummary {
  id: string
  title: string
  /** ISO. */
  createdAt: string
  /** ISO, mis à jour à chaque échange — sert à trier la liste, la plus récente en premier. */
  updatedAt: string
  /** Nombre d'échanges enregistrés : 0 = conversation encore vide. */
  messageCount: number
}

/** Liste des conversations et laquelle est active — renvoyé par tous les canaux qui la modifient, pour que
 *  le renderer n'ait jamais à recharger la liste dans un second appel. */
export interface ConversationList {
  activeId: string
  conversations: ConversationSummary[]
}

/**
 * Formats d'image acceptés par la pièce jointe (Chat et mode Code), en UNE SEULE table partagée : le
 * renderer en tire les types MIME qu'il accepte au collage/glisser-déposer (`ACCEPTED_IMAGE_TYPES`,
 * src/lib/imageAttachment.ts) et le main process en tire à la fois les extensions du sélecteur natif et le
 * type MIME à renvoyer pour le fichier choisi (voir `pickImageFile`, main.ts).
 *
 * Deux listes séparées (une en MIME côté renderer, une en extensions côté main) finiraient forcément par
 * diverger — un format collable mais invisible dans le sélecteur de fichiers, ou l'inverse : c'est
 * exactement le genre de duplication qui a déjà mordu ce projet (voir CLAUDE.md, la copie locale de
 * CapacityScanResult dans hardwareScan.ts).
 */
export const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

/**
 * Fichier image choisi via le sélecteur NATIF ouvert par le main process (voir `pickImageFile`) : les
 * octets bruts, tels que lus sur le disque, à réduire ensuite côté renderer par le MÊME chemin que le
 * collage et le glisser-déposer (fileToImageAttachment/pickedFileToImageAttachment).
 */
export interface PickedImageFile {
  /** Nom du fichier, affiché sous l'aperçu. */
  name: string
  /** Type MIME déduit de l'extension, vide si elle n'est pas dans IMAGE_TYPES_BY_EXTENSION. */
  type: string
  /** Octets du fichier encodés en base64, sans préfixe `data:`. */
  base64: string
}

/**
 * Résultat d'une génération d'application en mode Code (étape 30) : le code complet d'une page autonome
 * (HTML + CSS + JS dans un seul fichier, aucune dépendance réseau) et l'endroit où il a été enregistré sur
 * le disque, pour pouvoir le rouvrir/modifier en dehors de Jaris.
 */
export interface GeneratedApp {
  html: string
  /** URL isolée ajoutée par le main lors de l'envoi au renderer. */
  previewUrl?: string
  /** Dossier du projet généré sur le disque (contient index.html). */
  path: string
  /**
   * Problèmes structurels encore détectés après la passe de réparation (voir validateGeneratedHtml) :
   * vide si le fichier est sain. Affichés tels quels à l'utilisateur plutôt que de faire passer une page
   * cassée pour un succès — sur un petit modèle local, ça arrive.
   */
  issues: string[]
}

/**
 * Avancement EN DIRECT de l'étape en cours d'une génération (mode Code, étape 99).
 *
 * Léo : "quand on demande une mise à jour [d'une application, en mode Code] on ne sait pas quand c'est
 * terminé et des fois c'est bloqué et ça fait rien". Une génération enchaîne 2 à 4 appels au modèle local,
 * chacun pouvant durer plusieurs minutes sans rien afficher : rien ne distinguait un modèle qui travaille
 * d'un modèle bloqué. `charsWritten` est la preuve du mouvement — il monte tant que le modèle écrit.
 *
 * Contrairement à `codeGenStatus` (une ligne AJOUTÉE au journal à chaque étape franchie), ce message
 * REMPLACE le précédent : c'est l'état courant, pas un historique.
 */
export interface CodeGenProgress {
  /** Ce que Jaris fait en ce moment ("Écriture de l'application", "Relecture du code"…). */
  label: string
  /** Étape courante sur le nombre total prévu — "étape 2 sur 3". */
  stepIndex: number
  stepCount: number
  /** Caractères déjà écrits par le modèle pour CETTE étape. */
  charsWritten: number
  /** true tant que le modèle réfléchit sans avoir encore écrit le moindre caractère de code. */
  thinking: boolean
  /**
   * Temps écoulé depuis le dernier signe de vie du modèle. Envoyé toutes les secondes pendant une étape
   * (battement de cœur) : c'est ce qui permet de dire "ça n'avance plus depuis 40 s" au lieu de laisser
   * l'utilisateur deviner — un chronomètre côté écran, lui, continuerait de tourner même si Ollama était
   * mort.
   */
  idleMs: number
}

/**
 * Une application déjà générée, listée dans "Récents" (mode Code) — repéré par Léo en usage réel : chaque
 * génération est enregistrée sur le disque, mais rien n'en gardait la liste avant, donc relancer Jaris
 * perdait l'accès à tout ce qui avait déjà été généré. `label` vient du nom de dossier (déjà lisible),
 * jamais recalculé depuis le HTML pour rester rapide même avec beaucoup d'applications.
 */
export interface GeneratedAppSummary {
  path: string
  label: string
  /** Date de génération (Date.now() au moment de l'enregistrement, voir codeGenerator.ts). */
  timestamp: number
}

/** Canaux IPC main -> renderer pour piloter le visage et afficher la conversation. */
export const IPC_CHANNELS = {
  emotion: 'jaris:emotion',
  transcript: 'jaris:transcript',
  reply: 'jaris:reply',
  log: 'jaris:log',
  setupStatus: 'jaris:setup-status',
  /** renderer -> main : déclenche l'écoute manuellement (sans dire le mot d'activation). */
  triggerWake: 'jaris:trigger-wake',
  /** renderer <-> main : profil utilisateur (prénom), demandé une seule fois au premier lancement. */
  getProfile: 'jaris:get-profile',
  saveProfile: 'jaris:save-profile',
  /** renderer -> main : ouvre le dossier de mémoire markdown de Jaris dans l'explorateur de fichiers. */
  openMemoryFolder: 'jaris:open-memory-folder',
  /** renderer <-> main : récupère les notes de la mémoire et leurs liens, pour la vue graphe 3D. */
  getMemoryGraph: 'jaris:get-memory-graph',
  /** renderer <-> main : récupère le contenu markdown complet d'une note (clic sur un nœud du graphe). */
  getMemoryNoteContent: 'jaris:get-memory-note-content',
  /** renderer -> main : la lecture audio de la dernière réponse est terminée, on peut repasser en idle. */
  audioEnded: 'jaris:audio-ended',
  /** renderer <-> main : synthétise une phrase d'exemple avec une voix donnée, pour la comparer avant de la choisir. */
  previewVoice: 'jaris:preview-voice',
  /** renderer (fenêtre réglages) -> main : l'onboarding vient de se terminer, bascule vers le widget flottant. */
  onboardingFinished: 'jaris:onboarding-finished',
  /** renderer (widget) -> main : ouvre la fenêtre de réglages (Options, cerveau de Jaris). */
  openSettings: 'jaris:open-settings',
  /** renderer <-> main : récupère l'historique complet des échanges voix (transcription, réponse, date). */
  getConversationHistory: 'jaris:get-conversation-history',
  /** renderer <-> main : efface définitivement l'historique des échanges (fichier + court terme en mémoire). */
  clearConversationHistory: 'jaris:clear-conversation-history',
  /** renderer -> main : révèle le fichier conversation-history.json dans l'explorateur de fichiers. */
  openConversationHistoryFile: 'jaris:open-conversation-history-file',
  /** renderer <-> main : liste tous les modèles candidats (tous paliers + vision) avec leurs métriques, pour l'onglet Modèles. */
  getModelOverview: 'jaris:get-model-overview',
  getOllamaVersionStatus: 'jaris:get-ollama-version-status',
  updateOllama: 'jaris:update-ollama',
  /** renderer -> main : lance le benchmark complet (scripts/benchmark-models.mjs) puis choisit et active le
   * meilleur modèle de chaque palier d'après les résultats (résout une fois toute l'analyse terminée). */
  runModelAnalysis: 'jaris:run-model-analysis',
  /** main -> renderer : une ligne de sortie du benchmark en cours, au fil de l'eau (progression comprise, voir OptionsMenu.tsx). */
  modelBenchmarkLine: 'jaris:model-benchmark-line',
  /** renderer -> main : aperçu instantané (sans rien télécharger) des modèles choisis à 3 échelles de VRAM
   * représentatives, pour l'écran d'accueil (voir previewHardwareTiers, hardwareScan.ts). */
  previewHardwareTiers: 'jaris:preview-hardware-tiers',
  /** renderer -> main : détecte le matériel et télécharge directement les modèles déjà choisis pour lui
   * (voir runQuickSetup, benchmarkRunner.ts) — le nouveau chemin par défaut de l'écran d'accueil, sans passer
   * par le benchmark comparatif complet. Réutilise modelBenchmarkLine pour la progression des téléchargements. */
  runQuickSetup: 'jaris:run-quick-setup',
  /** renderer <-> main : envoie un message écrit à Jaris (mode Chat, étape 30) et renvoie sa réponse. */
  sendChatMessage: 'jaris:send-chat-message',
  /** main -> renderer : un fragment de la réponse en cours de génération (étape 48), affiché au fil de
   * l'eau dans ChatPanel.tsx plutôt que d'attendre la réponse complète de sendChatMessage. */
  chatStreamToken: 'jaris:chat-stream-token',
  /**
   * renderer <-> main : ouvre le sélecteur de fichier image du Chat/mode Code et renvoie le fichier choisi
   * (null si annulé). Passe par le main process — et non par un `<input type="file">` côté renderer — parce
   * que c'est le SEUL endroit où le garde `dialogOpen` peut encadrer l'ouverture du dialogue natif : sans
   * lui, le 'blur' provoqué par ce dialogue repliait Jaris en widget en plein milieu du choix de l'image
   * (signalé en usage réel par Léo).
   */
  pickImageFile: 'jaris:pick-image-file',
  /** renderer <-> main : récupère les messages du mode Chat, amorcés depuis conversation-history.json au
   * premier appel après un lancement (voir ChatSession.ensureLoaded) — plus seulement ceux de la session en cours. */
  getChatHistory: 'jaris:get-chat-history',
  /** renderer <-> main : liste les conversations du Chat (étape 96) et laquelle est active. */
  listConversations: 'jaris:list-conversations',
  /** renderer <-> main : crée une conversation vide et la rend active (réutilise l'active si elle est déjà
   * vide, pour ne pas empiler des fils identiques à chaque clic). Renvoie la liste à jour. */
  createConversation: 'jaris:create-conversation',
  /** renderer <-> main : change la conversation active — Chat ET voix, qui écrivent dans la même. */
  selectConversation: 'jaris:select-conversation',
  /** renderer <-> main : supprime définitivement une conversation et ses messages. Renvoie la liste à jour. */
  deleteConversation: 'jaris:delete-conversation',
  /** renderer <-> main : génère une application autonome à partir d'une description (mode Code, étape 30). */
  generateApp: 'jaris:generate-app',
  /** main -> renderer : messages d'avancement pendant la génération d'application (étapes de la boucle). */
  codeGenStatus: 'jaris:code-gen-status',
  /** main -> renderer : avancement EN DIRECT de l'étape en cours (étape 99) — voir CodeGenProgress. */
  codeGenProgress: 'jaris:code-gen-progress',
  /** renderer -> main : arrête la génération en cours (bouton "Arrêter", étape 99). */
  cancelCodeGen: 'jaris:cancel-code-gen',
  /** renderer -> main : ouvre le dossier de l'application générée dans l'explorateur de fichiers. */
  openGeneratedApp: 'jaris:open-generated-app',
  /** renderer <-> main : liste les applications déjà générées (les plus récentes d'abord), pour l'écran
   * "Récents" du mode Code — survit à un redémarrage de Jaris puisque lu directement sur le disque. */
  getGeneratedApps: 'jaris:get-generated-apps',
  /** renderer <-> main : recharge une application déjà générée (depuis "Récents") pour la remontrer dans
   * l'aperçu, avec une nouvelle URL d'aperçu isolée (voir generatedAppPreview.ts). */
  loadGeneratedApp: 'jaris:load-generated-app',
  /** renderer -> main : supprime définitivement une application générée (son dossier). Le chemin est
   * revérifié côté main avant tout effacement, voir deleteGeneratedApp (codeGenerator.ts). */
  deleteGeneratedApp: 'jaris:delete-generated-app',
  /** renderer <-> main : modèles candidats (hardwareScan.ts) apparus depuis le dernier scan de capacité (étape 29), à afficher en popup. */
  getNewModels: 'jaris:get-new-models',
  /** renderer -> main : l'utilisateur a vu le popup de nouveaux modèles, ne plus le remontrer avant les prochains. */
  acknowledgeNewModels: 'jaris:acknowledge-new-models',
  /** renderer <-> main : liste les micros détectés par PortAudio (voir --list-devices dans voice_server.py). */
  listAudioInputDevices: 'jaris:list-audio-input-devices',
  /** renderer <-> main : change le micro utilisé par le sidecar vocal (redémarre le pipeline vocal). */
  setAudioInputDevice: 'jaris:set-audio-input-device',
  /** renderer -> main : démarre le test micro sur le micro actuellement en écoute (reste actif jusqu'à stopTestMicrophone). */
  testMicrophone: 'jaris:test-microphone',
  /** renderer -> main : arrête un test micro démarré par testMicrophone. */
  stopTestMicrophone: 'jaris:stop-test-microphone',
  /** main -> renderer : mesure de niveau sonore pendant un test micro en cours. */
  micTestLevel: 'jaris:mic-test-level',
  /** main -> renderer : verdict final d'un test micro (un signal a été détecté ou non). */
  micTestDone: 'jaris:mic-test-done',
  /** renderer <-> main : version de Jaris comparée à la dernière Release GitHub stable (étape 20). */
  getAppVersionStatus: 'jaris:get-app-version-status',
  /** renderer -> main : télécharge et lance l'installeur de la dernière version, puis ferme Jaris. */
  updateApp: 'jaris:update-app',
  /** main -> renderer : avancement de ce téléchargement, au fil de l'eau (étape 98). */
  updateProgress: 'jaris:update-progress',
  /** renderer <-> main : version réellement installée (app.getVersion()), jamais bloquée par le réseau. */
  getAppVersion: 'jaris:get-app-version',
  /** renderer <-> main : active/désactive le mot d'activation "Jaris" (redémarre le pipeline vocal, voir
   * Profile.activationWakeWordEnabled) — les deux autres bascules de l'onglet Activation (touche "+", clic
   * sur l'orbe) sont de simples champs du profil, relus à la volée sans redémarrage nécessaire. */
  setWakewordEnabled: 'jaris:set-wakeword-enabled',
  /** renderer -> main : recherche une mise à jour pour de vrai (jamais depuis le cache), erreur remontée
   * telle quelle en cas d'échec — bouton "Rechercher une mise à jour" (Options → Mise à jour). */
  checkForUpdate: 'jaris:check-for-update',
  /** renderer <-> main : journal des mises à jour (toutes les Releases GitHub stables), pour Options → Mise à jour. */
  getReleaseHistory: 'jaris:get-release-history',
  /** renderer <-> main : emplacement réel actuel des modèles/environnement (voir modelsLocation.ts). */
  getModelsLocationStatus: 'jaris:get-models-location-status',
  /** renderer -> main : ouvre un sélecteur de dossier puis déplace tout dedans (résout une fois terminé). */
  chooseModelsLocation: 'jaris:choose-models-location',
  /** main -> renderer : avancement de ce déplacement, au fil de l'eau. */
  modelsLocationProgress: 'jaris:models-location-progress',
  /** renderer <-> main : ce qui reste à installer sur la machine (Python, Ollama) au premier lancement. */
  getRuntimeSetupStatus: 'jaris:get-runtime-setup-status',
  /** renderer <-> main : installe ce qui manque (étape 16), résout avec le statut final. */
  runRuntimeSetup: 'jaris:run-runtime-setup',
  /** main -> renderer : avancement de cette installation, au fil de l'eau. */
  runtimeSetupProgress: 'jaris:runtime-setup-progress',
  /**
   * renderer -> main : la fenêtre de réglages (`?mode=full`) prévient à chaque changement d'onglet
   * (Agent vocal/Chat/Code, App.tsx) — utilisé pour suspendre l'écoute vocale (VoicePipeline) tant que
   * l'utilisateur est sur Chat ou Code, à sa demande explicite : Jaris ne doit pas réagir à sa voix (mot
   * d'activation, transcription) quand il est en train d'écrire dans un autre mode.
   */
  setActiveMode: 'jaris:set-active-mode',
  /**
   * renderer -> main : OptionsMenu.tsx prévient à chaque ouverture/fermeture de la page Options (elle vit
   * dans la fenêtre normale, pas une fenêtre à part — voir `optionsOpen`, main.ts). Léo : "quand on est
   * dans les option, jaris ne doit pas partir en widget quand on part" — le handler `'blur'` de la fenêtre
   * principale (repli en widget sur perte de focus, étape 73) doit ignorer ce cas comme il ignore déjà un
   * dialogue natif (`dialogOpen`) ou une fermeture volontaire (`quitting`).
   */
  setOptionsOpen: 'jaris:set-options-open',
  /** main -> renderer : un son court à jouer (design sonore, étape 31) — voir SoundCue plus haut. */
  soundCue: 'jaris:sound-cue',
  /**
   * renderer <-> main : derniers appels du téléphone, lus dans le cache de Mobile connecté (étape
   * 21quater). Les MESSAGES n'y sont pas : le constat sur la machine de Léo n'a trouvé que `calling.db` et
   * `contacts.db`, jamais de base de messages — pour un iPhone, Mobile connecté les affiche sans les garder.
   */
  getPhoneCalls: 'jaris:get-phone-calls',
  /** renderer -> main : ouvre "Mobile connecté" (pour l'appairer au téléphone la première fois). */
  openPhoneLink: 'jaris:open-phone-link',
  /**
   * renderer <-> main : regarde ce que Mobile connecté range sur le disque (étape 21ter) — quelles bases,
   * quelles tables, combien de lignes. Aucun contenu de message n'est lu : c'est un CONSTAT destiné à
   * décider la suite avec des faits, pas une fonctionnalité de lecture de messages.
   */
  inspectPhoneCache: 'jaris:inspect-phone-cache',
  /**
   * renderer <-> main : calcule le curseur de longueur de contexte (Options -> Modèles) pour la VRAM
   * ACTUELLEMENT libre et le modèle du palier Puissant — jamais mis en cache, recalculé à chaque ouverture
   * de l'onglet (voir computeContextLengthOptions, hardwareScan.ts).
   */
  getContextLengthOptions: 'jaris:get-context-length-options',
  /** renderer -> main : enregistre la longueur de contexte choisie dans le profil (Profile.contextLength). */
  setContextLength: 'jaris:set-context-length'
} as const
