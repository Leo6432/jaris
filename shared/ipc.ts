import type { ModelThinkingChoice, StoredThinkChoice } from './effort'
/** Types partagés entre le process principal (electron/) et le renderer (src/). */
import type { ImageModelPick } from './imageModel'
import type { VideoModelPick } from './videoModel'
import type { PilotModelPick } from './pilotModel'

export type JarisEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

/** Les trois modes de la fenêtre de réglages (App.tsx), aussi retenus côté main pour choisir la forme du
 * widget au repli (voir WidgetMode juste en dessous et `setActiveMode`). */
export type AppMode = 'voice' | 'chat' | 'code' | 'image' | 'video'

/**
 * Ce que devient Jaris quand on quitte sa fenêtre, dérivé du dernier mode actif :
 * - 'voice' : le widget cercle qui écoute, tel qu'il a toujours été ;
 * - 'chat-idle' : le petit état inactif du Chat, visible comme l'orbe vocal au repos ;
 * - 'chat' : la barre de texte ouverte par +, pour écrire sans rouvrir l'application ;
 * - depuis le mode Code, aucun widget n'est affiché du tout ("ça doit rien faire aucun widget") : il n'y a
 *   donc pas de valeur 'code' ici, c'est l'absence de fenêtre qui l'exprime (voir showWidgetWindow, main.ts).
 */
export type WidgetMode = 'voice' | 'chat-idle' | 'chat'

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

/** Les trois modes où l'on peut choisir le modèle à la main (étape 141). */
export type ModelChoiceMode = 'chat' | 'code' | 'voice'

/** Ce qu'affiche le sélecteur de modèle d'un mode (getModelChoice, main.ts). */
export interface ModelChoiceInfo {
  /** Rôle choisi (ex. role:flash), ancien modèle explicite, ou `null` = Auto. */
  selected: string | null
  /** Modèles réellement installés dans Ollama et utilisables pour discuter/coder, `null` si Ollama ne répond pas. */
  installed: string[] | null
  /** Ce qu'Auto utilise : un seul modèle en mode Code, `null` en Chat/Vocal (le modèle change selon la question). */
  autoModel: string | null
  /** Les cinq rôles du profil de cette machine et leur modèle actuel. */
  roles: { value: string; label: string; model: string; installed: boolean }[]
  /**
   * Étape 192 : la réflexion du modèle qui sera VRAIMENT utilisé (choisi à la main, ou l'unique modèle d'Auto en
   * Code) et ses vrais choix. `null` en Chat/Vocal Auto : le modèle change selon la question, on ne peut rien
   * proposer d'exact — il faut d'abord choisir un modèle.
   */
  thinking?: ModelThinkingChoice | null
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
   * Étape 231 : modèle de pilotage d'écran (UI-TARS, shared/pilotModel.ts), installé par la configuration quand
   * la machine a la puissance. Absent = pas de rôle : le modèle de vision pilote l'écran, comme avant.
   */
  pilotModel?: string
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
   * enregistré par runQuickSetup (benchmarkRunner.ts) exactement comme `visionModel`
   * ci-dessus — pas de choix manuel dans Options, resolveCodeModel (codeGenerator.ts) lit cette valeur
   * directement. `undefined` seulement pour un profil créé avant l'étape 46.
   */
  codeModel?: string
  /**
   * Étape 138 : meilleurs modèles dont le téléchargement a échoué au dernier « Retester la configuration »
   * (import Hugging Face bloqué par une version d'Ollama, voir runQuickSetup), avec la raison — pour que
   * Options → Modèles explique pourquoi Jaris utilise un autre modèle au lieu de laisser croire que le
   * meilleur est installé. Retiré dès qu'un téléchargement du même modèle réussit.
   */
  blockedModels?: Record<string, string>
  /**
   * Étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto ».
   * Rôle choisi à la main pour chaque mode (`role:flash` etc.) ; absent = Auto. Les anciens noms de modèles
   * explicites restent lisibles pour préserver les préférences enregistrées avant le sélecteur par rôle.
   */
  modelChoices?: Partial<Record<ModelChoiceMode, string>>
  /**
   * Étape 192 : réflexion choisie pour le modèle d'un mode (absent = Auto, la réflexion habituelle de Jaris).
   * Liée au modèle pour lequel elle a été choisie : jamais appliquée à un autre.
   */
  thinkChoices?: Partial<Record<ModelChoiceMode, StoredThinkChoice>>
  /** Design sonore (étape 31) : absent/true par défaut, false pour couper les bips d'interface (Options → Voix). */
  soundEffectsEnabled?: boolean
  /**
   * Étape 207 (Léo : « un correcteur un peu comme Apple ») : absent/true par défaut — la phrase dite est corrigée
   * (mots mal compris) avant que Jaris y réponde (transcriptCorrector.ts). false = la transcription brute.
   */
  voiceCorrectionEnabled?: boolean
  /** Étape 214 : accès depuis le téléphone (Tailscale) — absent/false = désactivé, choix explicite de Léo. */
  phoneAccessEnabled?: boolean
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
  /**
   * Étape 173 : NOM du fichier PNG d'une image dessinée par Jaris (dossier generated-images), jamais l'image
   * elle-même — le Chat la relit sur le disque pour la réafficher après un redémarrage.
   */
  image?: string
}

/**
 * Emplacement réel actuel des trois briques lourdes de Jaris (modèles Ollama, environnement Python, cache
 * de reconnaissance/synthèse vocale), lu en direct sur le disque (voir modelsLocation.ts) — jamais une
 * simple valeur de profil qui pourrait dériver de la réalité si l'utilisateur ou un autre outil touche à
 * ces dossiers en dehors de Jaris.
 */
/**
 * Étape 143 : où vit RÉELLEMENT chaque partie de Jaris (lu sur le disque), et le dossier choisi (`root`,
 * `null` = emplacements par défaut de Windows).
 */
export interface ModelsLocationStatus {
  root: string | null
  items: { label: string; path: string }[]
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
  /**
   * Étape 188 : que des zéros parfaits pendant tout le test — Windows donne un flux vide (micro coupé dans
   * Windows, ou accès au micro refusé aux applications de bureau), ce qu'un micro trop faible ne fait jamais.
   */
  silentStream: boolean
}

/** Réponse au lancement d'un test micro ou du mot « Jaris » : `reason` dit pourquoi il n'a pas pu démarrer. */
export interface VoiceTestStartResult {
  started: boolean
  reason: string | null
}

/**
 * Une phrase entendue pendant le test du mot « Jaris » (étape 180, voir wake_test_heard dans voice_server.py) :
 * ce que la transcription a écrit, si le nom y a été reconnu, et si le son était trop court pour être transcrit.
 */
export interface WakeTestHeardPayload {
  text: string
  matched: boolean
  tooShort: boolean
  /** Niveau sonore le plus fort de la phrase, 0..1 (même échelle que le test micro). */
  peak: number
}

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
  /** Étape 138 : meilleurs modèles non téléchargeables pour l'instant (voir Profile.blockedModels), remplacés par le suivant. */
  blockedModels?: { model: string; reason: string }[]
  /**
   * Étape 175 : le modèle d'image, installé par le même passage que les modèles Ollama. `error` = la machine
   * le fait tourner mais son installation a échoué (message déjà lisible par Léo).
   */
  image?: ImageModelPick & { error?: string }
  /** Étape 231 : le modèle de pilotage d'écran, même principe que `image` (absent du rôle si pas assez de puissance). */
  pilot?: PilotModelPick & { error?: string }
}

/**
 * Les modèles choisis pour CETTE machine (getMyModelPicks, hardwareScan.ts), rôle par rôle, avec leurs scores
 * — affichés à l'écran d'accueil (CapacityScan.tsx) et dans Options → Modèles. Étape 137 : remplace les
 * "paliers" de comparaison (Palier 1/2/3...) à la demande de Léo — un choix personnalisé, calculé sur la VRAM
 * et la RAM réellement détectées, exactement comme ce qui est téléchargé.
 */
export type ModelRole = 'flash' | 'medium' | 'large' | 'vision' | 'code'

export interface MyModelPicks {
  gpuName: string | null
  vramGb: number | null
  ramGb: number
  /** Étape 138 : le modèle RÉELLEMENT utilisé par Jaris pour chaque rôle (celui du profil), pas l'idéal. */
  flash: ModelOverviewEntry
  medium: ModelOverviewEntry
  large: ModelOverviewEntry
  vision: ModelOverviewEntry
  code: ModelOverviewEntry
  /**
   * Rôles pour lesquels un meilleur modèle existe mais n'est pas celui utilisé : soit pas encore installé
   * (il suffit de « Retester la configuration »), soit bloqué au téléchargement (`blockedReason`).
   */
  upgrades: Partial<Record<ModelRole, { model: string; blockedReason: string | null }>>
  /**
   * Étape 140, Léo : "je veut etre sur que les model visbile sont réel". Vérifié auprès d'Ollama lui-même
   * (`/api/tags`), jamais supposé : les rôles dont le modèle affiché n'est PAS réellement installé, et les
   * modèles installés que Jaris n'utilise pour aucun rôle. `null` si Ollama n'a pas pu répondre (on ne
   * prétend alors rien, dans un sens comme dans l'autre).
   */
  installCheck: { notInstalled: ModelRole[]; otherInstalled: string[] } | null
  /**
   * Étape 174 : le modèle d'image (un seul, FLUX.2 klein 4B), ou aucun si la machine n'a pas assez de puissance
   * (pickImageModel, shared/imageModel.ts). Ajouté par le canal IPC (main.ts) à partir du matériel détecté
   * ci-dessus : absent seulement dans les appels internes qui n'en ont pas besoin.
   */
  image?: ImageModelPick
  /** Le modèle vidéo et sa meilleure qualité possible ici (pickVideoModel, shared/videoModel.ts). */
  video?: VideoModelPick
  /** Étape 231 : le modèle de pilotage d'écran (pickPilotModel, shared/pilotModel.ts). */
  pilot?: PilotModelPick
}

/**
 * Un modèle candidat pour UN palier donné (voir ModelOverviewGroup), pour le tableau comparatif de l'onglet
 * Modèles du menu Options. `toolCalling` vient soit d'un vrai run local de `npm run benchmark:models`
 * (scripts/benchmark-models.mjs) sur cette machine, soit — pour un modèle déjà vérifié par ailleurs
 * (scripts/verified-tool-scores.md) — du score de fiabilité partagé, valable pour tout le monde puisqu'il ne
 * dépend pas du matériel. `null` si rien de tout ça n'existe pour ce modèle (jamais de chiffre inventé).
 *
 * Plus aucune vitesse LOCALE ici depuis l'étape 131 : les deux écrans qui affichent une vitesse montrent
 * désormais `artificialAnalysisSpeed` (voir plus bas), une mesure publiée identique pour tout le monde.
 */
export interface ModelOverviewEntry {
  model: string
  vramGb: number
  /** Paliers/rôles qui utilisent actuellement ce modèle dans le profil actif. Vide = modèle candidat non retenu. */
  usedIn?: string[]
  /** Repère affiché (Rapide/Moyen/Puissant), jamais un critère de choix — voir ModelCategory. */
  category?: ModelCategory
  /** Le modèle lit les images (seuls ceux-là peuvent tenir le rôle Vision). */
  readsImages?: boolean
  toolCalling: string | null
  /**
   * Étape 243, Léo (« il y a seulement les questions visibles le score et pas le score de demandes ») : réussite
   * aux demandes complètes (« 46/48 »), lue dans verified-tool-scores.md, seulement sur le total du test ACTUEL.
   * Compte dans le choix de Faible, Moyen et Élevé (étape 241), jamais de Vision ni de Code. `null` sans score.
   */
  demands?: string | null
  intelligence: number | null
  /**
   * Intelligence Index publié directement par Artificial Analysis — voir
   * ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX dans hardwareScan.ts pour la version et la date de vérification.
   * `null` si le modèle exact n'est pas évalué, jamais un chiffre inventé pour combler le vide.
   * À fiabilité égale, Jaris l'utilise pour départager deux modèles exacts qui possèdent tous les deux un
   * score publié ; MMLU-Pro reste le repli quand cette comparaison officielle n'est pas possible.
   */
  artificialAnalysisIndex: number | null
  /**
   * Vitesse de génération (tokens/s) publiée par Artificial Analysis pour ce modèle. Mesurée sur LEUR
   * matériel, identique pour tout le monde : sert à comparer les modèles entre eux, jamais à prédire la
   * vitesse sur la machine de qui regarde (dit explicitement à l'écran, voir MyModelPicks.tsx).
   * Voir ARTIFICIAL_ANALYSIS_SPEED dans hardwareScan.ts. `null` si Artificial Analysis n'a pas
   * encore publié de mesure de vitesse fiable pour ce modèle exact.
   */
  artificialAnalysisSpeed: number | null
}

/**
 * Étiquette affichée à côté d'un modèle dans « Tous les modèles » (étape 160) : ce n'est PLUS une catégorie
 * de choix — chaque rôle cherche dans tous les modèles —, seulement un repère pour l'utilisateur.
 */
export type ModelCategory = 'Rapide' | 'Moyen' | 'Puissant'

/** Résultat de getModelOverview : TOUS les modèles dans une seule liste (étape 160), plus la VRAM totale
 * détectée sur la machine. */
export interface ModelOverviewResult {
  vramGb: number | null
  entries: ModelOverviewEntry[]
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
  /** `null` : Ollama ne répond pas (étape 234 — avant, l'écran restait sur « Vérification… » pour toujours). */
  current: string | null
  /** `null` : dernière version impossible à vérifier (hors ligne, GitHub bloqué ou limite atteinte). */
  latest: string | null
  outdated: boolean
}

/**
 * Version de Jaris lui-même comparée à la dernière Release GitHub stable (étape 20, voir appUpdater.ts) —
 * même principe qu'OllamaVersionStatus ci-dessus, `null` tant que le check réseau n'a pas abouti.
 */
/** Lancement de Jaris au démarrage de Windows (Options → Général, étape 165). */
export interface LaunchAtStartupStatus {
  /** false hors d'une version installée sous Windows (développement) : l'interrupteur est alors grisé. */
  supported: boolean
  enabled: boolean
  /** Entrée présente mais désactivée dans les applications de démarrage de Windows : Jaris ne se lancera pas. */
  blockedByWindows: boolean
}

export interface AppVersionStatus {
  current: string
  latest: string
  outdated: boolean
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
   * Aperçu (data URL) d'une image jointe par l'utilisateur, étape 91 — ou, depuis l'étape 173, d'une image
   * DESSINÉE par Jaris (message assistant, relue sur le disque à partir de ConversationEntry.image). Pour une
   * image jointe par l'utilisateur, UNIQUEMENT pour l'affichage dans le
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

/** Résultat de « Enregistrer l'image » (étape 185) : `saved` false si Léo a annulé ou si l'écriture a échoué. */
export interface SaveImageResult {
  saved: boolean
  /** Message lisible par Léo quand l'écriture a échoué (jamais sur une simple annulation). */
  error?: string
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
 * Mode Image (étape 200, Léo : « enlève Montage, on le remplace par Image comme ChatGPT »). Le moteur de dessin
 * local existe depuis l'étape 173 (imageGenerator.ts) ; cet écran lui donne sa propre page.
 */
export interface ImageStudioStatus {
  /** Windows uniquement : le moteur publié (sd-cli) est un programme Windows. */
  supported: boolean
  /** La machine a-t-elle assez de mémoire pour dessiner (même décision qu'Options → Modèles) ? */
  capable: boolean
  /** Pourquoi elle ne peut pas, en clair, quand `capable` est faux. */
  reason: string | null
  /** Moteur et modèle de dessin présents sur le disque. */
  installed: boolean
  /** Ce qu'il reste à télécharger, en clair (« 5,1 Go »). */
  downloadLabel: string
}

/** Une image dessinée, telle que la liste l'affiche (seul le NOM du fichier voyage, jamais un chemin). */
export interface GeneratedImageSummary {
  fileName: string
  label: string
  timestamp: number
}

/** Mode Vidéo (étape 203) : mêmes informations que le mode Image, pour le modèle Wan 2.2. */
/** Une qualité du modèle vidéo telle que l'écran la montre (étape 205). */
export interface VideoQualityStatus {
  id: 'light' | 'q6' | 'q8' | 'original'
  label: string
  /** Téléchargée et prête. */
  installed: boolean
  /** Ce qu'il reste à télécharger pour elle (moteur compris s'il manque), ex. « 12,8 Go ». */
  downloadLabel: string
}

export interface VideoStudioStatus {
  /** Windows uniquement : le moteur publié (sd-cli) est un programme Windows. */
  supported: boolean
  /** Au moins une qualité tient sur cette machine. */
  capable: boolean
  /** Pourquoi aucune ne tient, en clair, quand `capable` est faux. */
  reason: string | null
  /** Les qualités que CETTE machine peut faire tourner, de la plus légère à la plus fidèle. */
  qualities: VideoQualityStatus[]
}

/** Une vidéo créée par le mode Vidéo (fichier .webm ; seul son NOM voyage entre l'écran et le main). */
export interface GeneratedVideoSummary {
  fileName: string
  label: string
  timestamp: number
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
  /** renderer -> main : ouvre le journal des demandes (étape 245), ou le montre dans son dossier pour l'envoyer. */
  openRequestJournal: 'jaris:open-request-journal',
  /** Étape 249, duel des pilotes d'écran : renderer -> main, capture du vrai écran (Jaris se cache 5 s). */
  pilotDuelCapture: 'jaris:pilot-duel-capture',
  /** renderer -> main : oublie les captures déjà prises. */
  pilotDuelReset: 'jaris:pilot-duel-reset',
  /** renderer -> main : lance le duel sur les captures prises. */
  pilotDuelRun: 'jaris:pilot-duel-run',
  /** main -> renderer : où en est le duel (une ligne lisible). */
  pilotDuelProgress: 'jaris:pilot-duel-progress',
  /** renderer -> main : ouvre le rapport du duel. */
  pilotDuelOpenReport: 'jaris:pilot-duel-open-report',
  /** renderer <-> main : liste tous les modèles candidats (tous paliers + vision) avec leurs métriques, pour l'onglet Modèles. */
  getModelOverview: 'jaris:get-model-overview',
  getOllamaVersionStatus: 'jaris:get-ollama-version-status',
  /** main -> renderer : nouveau statut de version d'Ollama (ex : fin de l'installeur officiel, étape 170). */
  ollamaVersionStatusChanged: 'jaris:ollama-version-status-changed',
  updateOllama: 'jaris:update-ollama',
  /** renderer <-> main : modèles de Jaris sans aucun score (getUnscoredModels, hardwareScan.ts). */
  getUnscoredModels: 'jaris:get-unscored-models',
  /** renderer -> main : teste ces modèles avec le script de test (étape 168), résout à la fin. */
  testUnscoredModels: 'jaris:test-unscored-models',
  /** renderer -> main : montre le fichier de résultats de ce test dans l'Explorateur. */
  showUnscoredResults: 'jaris:show-unscored-results',
  /** main -> renderer : une ligne de progression (configuration ou test des modèles), au fil de l'eau. */
  modelBenchmarkLine: 'jaris:model-benchmark-line',
  /** renderer -> main : modèles choisis pour CETTE machine, sans rien télécharger (voir getMyModelPicks,
   * hardwareScan.ts) — écran d'accueil et Options → Modèles. */
  getMyModelPicks: 'jaris:get-my-model-picks',
  /** renderer -> main : supprime un modèle installé que Jaris n'utilise pour AUCUN rôle (revérifié côté main). */
  deleteUnusedModel: 'jaris:delete-unused-model',
  /** renderer -> main : choix du modèle d'un mode (Auto ou un modèle installé), étape 141. */
  getModelChoice: 'jaris:get-model-choice',
  setModelChoice: 'jaris:set-model-choice',
  setThinkChoice: 'jaris:set-think-choice',
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
  /** renderer <-> main : enregistre une image dessinée par Jaris là où Léo le choisit (étape 185). */
  saveGeneratedImage: 'jaris:save-generated-image',
  /** Mode Image (étape 200) : état du moteur, installation, dessin, et images déjà dessinées. */
  getImageStudioStatus: 'jaris:get-image-studio-status',
  installImageStudio: 'jaris:install-image-studio',
  imageStudioLog: 'jaris:image-studio-log',
  generateStudioImage: 'jaris:generate-studio-image',
  cancelStudioImage: 'jaris:cancel-studio-image',
  listGeneratedImages: 'jaris:list-generated-images',
  readGeneratedImage: 'jaris:read-generated-image',
  deleteGeneratedImage: 'jaris:delete-generated-image',
  openGeneratedImages: 'jaris:open-generated-images',
  /** Mode Vidéo (étape 203) : même principe que le mode Image, avec Wan 2.2 TI2V 5B. */
  getVideoStudioStatus: 'jaris:get-video-studio-status',
  installVideoStudio: 'jaris:install-video-studio',
  videoStudioLog: 'jaris:video-studio-log',
  generateStudioVideo: 'jaris:generate-studio-video',
  cancelStudioVideo: 'jaris:cancel-studio-video',
  listGeneratedVideos: 'jaris:list-generated-videos',
  readGeneratedVideo: 'jaris:read-generated-video',
  deleteGeneratedVideo: 'jaris:delete-generated-video',
  saveGeneratedVideo: 'jaris:save-generated-video',
  openGeneratedVideos: 'jaris:open-generated-videos',
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
  /** renderer -> main : démarre / arrête le test du mot « Jaris » (étape 180). */
  testWakeWord: 'jaris:test-wake-word',
  stopTestWakeWord: 'jaris:stop-test-wake-word',
  /** main -> renderer : une phrase entendue pendant ce test. */
  wakeTestHeard: 'jaris:wake-test-heard',
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
   * main -> widget : quelle forme le widget flottant doit prendre, dérivée du dernier mode actif de la
   * fenêtre de réglages (voir `setActiveMode` juste au-dessus). Léo : "quand on se met dans chat, et on part
   * ... ça met une barre de texte en haut au centre comme le widget vocal, et on peut lui demander une
   * question sans aller directement sur l'application".
   *
   * La taille NATIVE de la fenêtre (main.ts) et le contenu DESSINÉ (App.tsx) doivent venir de la même source,
   * sinon les deux se contredisent — piège déjà vécu avec la taille du widget vocal, où le renderer dessinait
   * un orbe déplié dans une fenêtre native forcée à la taille repliée.
   */
  widgetMode: 'jaris:widget-mode',
  /** widget -> main : le widget vient d'être créé et demande sa forme (le `widgetMode` envoyé à l'affichage
   * peut arriver avant que ce renderer soit prêt à l'écouter — sans cette lecture au montage, un widget tout
   * juste créé resterait sur sa forme par défaut jusqu'au repli suivant). */
  getWidgetMode: 'jaris:get-widget-mode',
  /**
   * widget -> main : la hauteur dont le widget texte a besoin, en pixels (ou `null` pour revenir à sa simple
   * barre). L'équivalent, pour le widget texte, de ce que `pipeline.on('emotion')` fait tout seul pour le
   * widget vocal — rien ne passe par le main quand l'utilisateur tape dans la barre, il ne peut donc pas le
   * deviner.
   *
   * Une hauteur MESURÉE plutôt qu'une taille dépliée fixe : la fenêtre reste au-dessus de tout le reste et
   * capte les clics sur toute sa surface une fois dépliée, donc une hauteur fixe calculée pour la réponse la
   * plus longue laisserait, pour une réponse courte, des centaines de pixels invisibles qui avalent les clics
   * en haut de l'écran. Le widget vocal s'en accommode (il se replie tout seul quelques secondes plus tard) ;
   * celui-ci reste ouvert tant que la souris reste dessus, puis revient à son indicateur inactif.
   */
  setChatWidgetHeight: 'jaris:set-chat-widget-height',
  /** widget Chat -> main : protège le brouillon, puis la question/réponse, du repli automatique. */
  setChatWidgetKeepOpen: 'jaris:set-chat-widget-keep-open',
  /** widget Chat -> main : la souris a réellement atteint la barre visible ; arme le filet natif de sortie. */
  armChatWidgetPointer: 'jaris:arm-chat-widget-pointer',
  /** widget Chat -> main : la souris a quitté toute la barre/réponse, revenir au petit état inactif. */
  collapseChatWidget: 'jaris:collapse-chat-widget',
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
   * renderer <-> main : calcule le curseur de longueur de contexte (Options -> Modèles) pour la VRAM
   * ACTUELLEMENT libre et le modèle du palier Puissant — jamais mis en cache, recalculé à chaque ouverture
   * de l'onglet (voir computeContextLengthOptions, hardwareScan.ts).
   */
  getContextLengthOptions: 'jaris:get-context-length-options',
  /** renderer -> main : enregistre la longueur de contexte choisie dans le profil (Profile.contextLength). */
  setContextLength: 'jaris:set-context-length',
  /** renderer <-> main : état réel de l'entrée de démarrage de Windows (voir launchAtStartup.ts). */
  getLaunchAtStartup: 'jaris:get-launch-at-startup',
  /** renderer <-> main : active/désactive le lancement de Jaris au démarrage de Windows. */
  setLaunchAtStartup: 'jaris:set-launch-at-startup',
  /** Téléphone (étape 214) : état de l'accès, activation, code d'appairage, appareils connectés. */
  getPhoneAccess: 'jaris:get-phone-access',
  setPhoneAccessEnabled: 'jaris:set-phone-access-enabled',
  createPhonePairing: 'jaris:create-phone-pairing',
  removePhoneDevice: 'jaris:remove-phone-device',
  logoutPhoneAccess: 'jaris:logout-phone-access',
  openPhoneAccessLink: 'jaris:open-phone-access-link',
  /** main -> renderer : l'état de l'accès téléphone a changé (connexion Tailscale, adresse prête…). */
  phoneAccessChanged: 'jaris:phone-access-changed',
  /** main -> renderer : un message envoyé depuis le téléphone a rejoint la conversation active. */
  chatHistoryChanged: 'jaris:chat-history-changed',
  /** Une image ou une vidéo a été créée depuis le téléphone : les galeries du PC se rechargent. */
  studioGalleryChanged: 'jaris:studio-gallery-changed',
  /** Modèle ou réflexion changé depuis le téléphone : le sélecteur du PC se remet à jour. */
  modelChoiceChanged: 'jaris:model-choice-changed'
} as const

/** Un téléphone appairé (étape 214) — le jeton n'en fait jamais partie, il ne quitte pas le téléphone. */
export interface PhoneDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string
}

/**
 * Où en est l'accès depuis le téléphone (étape 214) :
 * - 'off' : désactivé (par défaut) ;
 * - 'starting' : le tunnel Tailscale démarre (`message` : l'étape en cours, ex. le certificat) ;
 * - 'login' : se connecter à Tailscale, une fois, dans le navigateur (`actionUrl`) ;
 * - 'enable_funnel' : autoriser l'adresse web publique, une fois (`actionUrl`) ;
 * - 'ready' : l'adresse `address` est joignable depuis le téléphone (`message` : dernière erreur de connexion
 *   sécurisée, s'il y en a une) ;
 * - 'error' : `message` dit pourquoi ;
 * - 'unsupported' : tunnel absent de cette installation.
 */
export interface PhoneAccessStatus {
  state: 'off' | 'starting' | 'login' | 'enable_funnel' | 'ready' | 'error' | 'unsupported'
  address?: string
  actionUrl?: string
  message?: string
  devices: PhoneDevice[]
}

/** Code d'appairage affiché sur le PC : à taper sur le téléphone, ou contenu dans le QR code (`link`). */
export interface PhonePairing {
  code: string
  link: string
  expiresAt: number
}

/** Étape 249 : après une capture du vrai écran pour le duel des pilotes. */
export interface PilotDuelCaptureInfo {
  captures: number
  /** Boutons retenus comme cibles sur toutes les captures. */
  targets: number
  /** Titre de la fenêtre de la dernière capture : Léo voit tout de suite si c'est bien celle qu'il voulait. */
  lastWindow?: string
}

/** Étape 249 : le score d'un pilote au duel (tirs justes au 1er regard, puis avec le zoom). */
export interface PilotDuelScore {
  label: string
  hits: number
  zoomHits: number
  total: number
  /** Temps moyen par cible, en secondes (1er regard + zoom). */
  secondsPerTarget: number
  error?: string
}

export interface PilotDuelOutcome {
  scores: PilotDuelScore[]
  reportPath: string
}
