/** Types partagés entre le process principal (electron/) et le renderer (src/). */

export type JarisEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

export interface VoiceReplyPayload {
  transcript: string
  reply: string
  /** WAV brut (converti en Blob côté renderer pour la lecture). */
  audio: ArrayBuffer
}

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
  /** true une fois l'écran "connecter Gmail ou ignorer" affiché après le premier lancement. */
  gmailOnboardingDone?: boolean
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

/** État de la connexion Gmail (étape 11), pour le menu Options. */
export interface GmailStatus {
  connected: boolean
  email: string | null
}

/** Un micro détecté par PortAudio (sounddevice --list-devices), pour le sélecteur d'Options → Voix. */
export interface AudioInputDevice {
  index: number
  name: string
}

/**
 * Un modèle recommandé par llmfit (github.com/AlexsJones/llmfit) pour le matériel détecté : une estimation
 * instantanée (formule, aucun téléchargement ni exécution), à ne jamais confondre avec les mesures réelles
 * de scripts/benchmark-models.mjs — voir estimateConfidenceLabel ("estimated"/"calibrated"/
 * "measured_local"/"measured_community") pour savoir à quel point s'y fier.
 */
export interface QuickEstimateModel {
  name: string
  /** Tag exact pour `ollama pull`, ex: "qwen2.5-coder:7b-instruct". */
  ollamaName: string
  estimatedTokPerSec: number | null
  confidence: string
  fitLabel: string
  memoryRequiredGb: number
}

/** Résultat de getQuickEstimate : matériel détecté par llmfit + modèles recommandés (déjà filtrés sur Ollama + appel d'outils, voir electron/services/llmfitClient.ts). */
export interface QuickEstimateResult {
  available: boolean
  /** Raison de l'indisponibilité (téléchargement/démarrage de llmfit échoué), affichable telle quelle — null si available. */
  reason: string | null
  gpuName: string | null
  vramGb: number | null
  ramGb: number | null
  models: QuickEstimateModel[]
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
}

/**
 * Un modèle candidat pour UN palier donné (voir ModelOverviewGroup), pour le tableau comparatif de l'onglet
 * Modèles du menu Options. speedTokPerSec/toolCalling viennent d'un run local de `npm run benchmark:models`
 * (scripts/benchmark-models.mjs) s'il a déjà tourné sur cette machine, `null` sinon (jamais de chiffre
 * inventé). intelligence = score MMLU-Pro publié quand il existe, `null` sinon.
 */
export interface ModelOverviewEntry {
  model: string
  vramGb: number
  speedTokPerSec: number | null
  toolCalling: string | null
  intelligence: number | null
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
   * Modèle de code effectivement utilisé si le mode Code (étape 30) était lancé maintenant (voir
   * resolveCodeModel dans codeGenerator.ts) : le modèle qualité s'il est déjà installé, sinon le modèle
   * rapide (toujours défini, jamais null — celui-ci est téléchargé automatiquement au besoin).
   */
  codeModel: string
}

/** Un message du mode Chat (étape 30) — même Jaris et mêmes outils que la voix, mais en écrit. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Résultat d'une génération d'application en mode Code (étape 30) : le code complet d'une page autonome
 * (HTML + CSS + JS dans un seul fichier, aucune dépendance réseau) et l'endroit où il a été enregistré sur
 * le disque, pour pouvoir le rouvrir/modifier en dehors de Jaris.
 */
export interface GeneratedApp {
  html: string
  /** Dossier du projet généré sur le disque (contient index.html). */
  path: string
  /**
   * Problèmes structurels encore détectés après la passe de réparation (voir validateGeneratedHtml) :
   * vide si le fichier est sain. Affichés tels quels à l'utilisateur plutôt que de faire passer une page
   * cassée pour un succès — sur un petit modèle local, ça arrive.
   */
  issues: string[]
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
  /** renderer -> main : marque l'écran de connexion Gmail comme vu (après connexion ou "Ignorer"). */
  markGmailOnboardingDone: 'jaris:mark-gmail-onboarding-done',
  /** renderer -> main : ouvre le dossier de mémoire markdown de Jaris dans l'explorateur de fichiers. */
  openMemoryFolder: 'jaris:open-memory-folder',
  /** renderer <-> main : récupère les notes de la mémoire et leurs liens, pour la vue graphe 3D. */
  getMemoryGraph: 'jaris:get-memory-graph',
  /** renderer <-> main : récupère le contenu markdown complet d'une note (clic sur un nœud du graphe). */
  getMemoryNoteContent: 'jaris:get-memory-note-content',
  /** renderer -> main : la lecture audio de la dernière réponse est terminée, on peut repasser en idle. */
  audioEnded: 'jaris:audio-ended',
  /** renderer <-> main : état de la connexion Gmail. */
  getGmailStatus: 'jaris:get-gmail-status',
  /** renderer <-> main : lance le flux de connexion Gmail (ouvre le navigateur système). */
  connectGmail: 'jaris:connect-gmail',
  /** renderer -> main : déconnecte le compte Gmail. */
  disconnectGmail: 'jaris:disconnect-gmail',
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
  /** renderer -> main : lance le benchmark complet (scripts/benchmark-models.mjs) puis choisit et active le
   * meilleur modèle de chaque palier d'après les résultats (résout une fois toute l'analyse terminée). */
  runModelAnalysis: 'jaris:run-model-analysis',
  /** main -> renderer : une ligne de sortie du benchmark en cours, au fil de l'eau (progression comprise, voir OptionsMenu.tsx). */
  modelBenchmarkLine: 'jaris:model-benchmark-line',
  /** renderer <-> main : envoie un message écrit à Jaris (mode Chat, étape 30) et renvoie sa réponse. */
  sendChatMessage: 'jaris:send-chat-message',
  /** renderer <-> main : récupère les messages déjà échangés en mode Chat depuis le lancement. */
  getChatHistory: 'jaris:get-chat-history',
  /** renderer <-> main : génère une application autonome à partir d'une description (mode Code, étape 30). */
  generateApp: 'jaris:generate-app',
  /** main -> renderer : messages d'avancement pendant la génération d'application (étapes de la boucle). */
  codeGenStatus: 'jaris:code-gen-status',
  /** renderer -> main : ouvre le dossier de l'application générée dans l'explorateur de fichiers. */
  openGeneratedApp: 'jaris:open-generated-app',
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
  /** renderer <-> main : estimation instantanée via llmfit (télécharge/lance le sidecar au besoin), sans lancer le vrai benchmark. */
  getQuickEstimate: 'jaris:get-quick-estimate'
} as const
