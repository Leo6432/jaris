import { app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell, BrowserWindow, globalShortcut, screen, Tray, Menu, Notification } from 'electron'
// Étape 143 : EN PREMIER — redirige le dossier interne de Chromium et les données vers le dossier de Jaris
// (installé sur D, ou déplacé) avant que quoi que ce soit ne calcule un chemin ou ne prenne le verrou d'instance.
import { PHONE_TUNNEL_DIR, cleanupStaleChromiumData, getMissingStorageRoot } from './services/storageRoot'
import { pickImageModel } from '../shared/imageModel'
import { PILOT_MODEL, PILOT_MODEL_LABEL, pickPilotModel } from '../shared/pilotModel'
import {
  deleteGeneratedImage,
  generateImage,
  generatedImagePath,
  generatedImagesDir,
  getImageStudioStatus,
  imageEngineRoot,
  installImageModel,
  isImageModelInstalled,
  listGeneratedImages,
  readGeneratedImageDataUrl
} from './services/imageGenerator'
import { toEnglishPrompt } from './services/promptTranslator'
import { imageLabelFromFileName } from '../shared/imageGallery'
import { isVideoQuality, normalizeVideoSeconds, pickVideoModel, VIDEO_DURATIONS } from '../shared/videoModel'
import {
  deleteGeneratedVideo,
  generateVideo,
  generatedVideoPath,
  generatedVideosDir,
  getVideoStudioStatus,
  removeObsoleteVideoFiles,
  installVideoModel,
  isVideoQualityInstalled,
  listGeneratedVideos,
  readGeneratedVideo
} from './services/videoGenerator'
import { removeLeftoverMontage, removeLeftoverSearxng, removeLeftoverTerminalBench, removeLeftoverVideoDuel } from './services/legacyCleanup'
import { spawn } from 'child_process'
import { basename, extname, join } from 'path'
import { copyFile, readFile, rm, writeFile } from 'fs/promises'
import { decodePngDataUrl, defaultImageFileName, withPngExtension } from './services/imageSave'
import {
  ensureOllamaRunning,
  getOllamaVersionStatus,
  getLocalOllamaVersion,
  refreshLocalOllamaVersion,
  isOllamaInstalled,
  onOllamaVersionStatus,
  restartOllama,
  stopOllamaCompletely,
  stopOllamaIfStartedByJaris,
  updateOllama,
  usesEmbeddedOllama
} from './services/dependencyServices'
import { engineModelsDir } from './services/ollamaEngine'
import { deleteModel, getModelThinking, listInstalledModels, preloadModel, setModelsViewRepair, waitForOllama } from './services/ollama'
import { StartupProgress } from './services/startupProgress'
import { applyModelChoice, buildModelChoiceInfo, MODEL_CHOICE_MODES, resolveChosenModel } from './services/modelChoice'
import { chosenThink, isAcceptedThink, thinkOptions, thinkingKind } from '../shared/effort'
import { getStorageStatus, programMoveCommandLine, reconcileStorage, relocateEverything } from './services/relocation'
import { alignOllamaModelsVariable, repairOllamaModelsView, windowsModelsViewDeps } from './services/ollamaModelsVariable'
import {
  computeContextLengthOptions,
  getAllCandidateModelIds,
  getModelOverview,
  getMyModelPicks,
  isUnusedInstalledModel,
  setOllamaVersionSource,
  setDuelStrengthSource,
  setDuelProbability,
  detectGpu
} from './services/hardwareScan'
import { buildDuelVotesExport, defaultDuelExportName, getDuelVotes, loadDuelVotes } from './services/duelStore'
import {
  abortDuel,
  askDuel,
  closeDuel,
  deleteDuelModels,
  duelAudio,
  duelHistory,
  duelHistoryApp,
  duelHistoryCode,
  duelSideCode,
  duelRankings,
  endDuel,
  getDuelView,
  planDuel,
  retryDuel,
  runDuelB,
  setDuelEnvironment,
  skipDuel,
  nextDuel,
  startDuel,
  stopDuelRun,
  voteDuel
} from './services/duelSession'
import { isDuelCategory, isDuelOutcome, rankDuels, switchProbability, type DuelCategory } from '../shared/duel'
import { setModelsDirSource, setVramSource } from './services/systemResources'
import { config } from './config'
import { getRuntimeSetupStatus, runFirstRunSetup } from './services/firstRunSetup'
import { restoreReminders } from './services/reminders'
import { getModelsToTest, runQuickSetup, stopModelTest, testUnscoredModels, unscoredResultsPath } from './services/benchmarkRunner'
import { chatSession } from './services/chatSession'
import { PhoneAccessManager } from './services/phoneAccessManager'
import { PHONE_RESTRICTIONS, phoneStatusFromLog } from './services/phoneAccess'
import { MAX_VOICE_BYTES, isExpectedWav } from './services/phoneServer'
import { cancelScheduledShutdown, scheduleShutdown } from './services/systemControl'
import { getDataRoot } from './services/dataLocation'
import { resourcesRoot } from './paths'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import {
  assertGeneratedAppDir,
  deleteGeneratedApp,
  generateApp,
  getGeneratedAppsDir,
  listGeneratedApps,
  loadGeneratedApp
} from './services/codeGenerator'
import { CodeConversationsStore } from './services/codeConversationsStore'
import { CODE_CONVERSATIONS_FILE } from '../shared/codeConversations'
import {
  cancelGithubLogin,
  commitGithubChanges,
  discardGithubChanges,
  finishGithubLogin,
  getGithubStatus,
  githubPreviewEntry,
  listGithubBranches,
  listGithubFiles,
  listGithubRepos,
  logoutGithub,
  openGithubRepo,
  readGithubFile,
  readGithubPreviewFile,
  runGithubAgent,
  setGithubDataMoving,
  startGithubLogin
} from './services/githubSession'
import { createFilesPreview, createGeneratedAppPreview, registerPreviewHandler, registerPreviewScheme } from './services/generatedAppPreview'
import { previewVoice, synthesizeSpeech } from './services/tts'
import { ttsClient } from './services/ttsClient'
import { createAppIcon, createTrayIcon } from './services/trayIcon'
import { languageState, loadLanguageSetting, saveLanguageSetting } from './services/language'
import { t } from '../shared/i18n'
import type { LanguageSetting } from '../shared/i18n/languages'
import { VoicePipeline } from './services/voicePipeline'
import { listAudioInputDevices } from './services/voiceClient'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, readNoteForDisplay } from './services/memoryStore'
import { cancelMemoryExtraction, clearPendingMemoryExchanges } from './services/memoryExtractor'
import {
  clearConversationHistory,
  createConversation,
  deleteConversation,
  ensureConversationHistoryFile,
  getAllConversationEntries,
  getConversationHistoryPath,
  listConversations,
  setActiveConversation
} from './services/conversationStore'
import { appendJournal, getJournalPath } from './services/requestJournal'
import { getProfile, patchProfile, saveProfile } from './services/profileStore'
import { setPilotWindowHooks } from './services/pilotWindows'
import {
  getLaunchAtStartup,
  LOGIN_REVEAL_GRACE_MS,
  setLaunchAtStartup,
  wasLaunchedAtLogin
} from './services/launchAtStartup'
import { checkAppFreshness, checkForUpdate, getAppVersionStatus, getInstalledVersion, updateApp } from './services/appUpdater'
import { isPermissionAllowed } from './services/permissions'
import { isSameDocument, isWebUrl } from './services/navigationGuard'
import { isSearchContents } from './services/webSearch'
import {
  IPC_CHANNELS,
  IMAGE_TYPES_BY_EXTENSION,
  type WindowChrome,
  type AppMode,
  type AudioInputDevice,
  type CapacityScanResult,
  type ChatMessage,
  type WebActivity,
  type PhoneAccessStatus,
  type PhonePairing,
  type ConversationList,
  type GeneratedApp,
  type GeneratedAppSummary,
  type RepoFileContent,
  type RepoPreview,
  type JarisEmotion,
  type MemoryGraph,
  type ModelChoiceInfo,
  type ModelChoiceMode,
  type PickedImageFile,
  type SaveImageResult,
  type DuelExportResult,
  type Profile,
  type SoundCue,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload,
  type WakeAvailabilityPayload,
  type WakeTestHeardPayload,
  type MicTestDonePayload,
  type GeneratedImageSummary,
  type GeneratedVideoSummary,
  type ImageStudioStatus,
  type VideoStudioStatus,
  type VoiceTestStartResult,
  type WidgetMode
} from '../shared/ipc'

/**
 * Sans ce verrou, cliquer plusieurs fois sur le raccourci (ou double-cliquer par erreur) lance autant de
 * Jaris en parallèle : plusieurs micros ouverts en même temps, plusieurs `ollama serve` qui se disputent le
 * même port, plusieurs sidecars Python... Demandé tout en haut, avant tout autre `app.on`/`app.whenReady`,
 * comme recommandé par Electron : la toute première instance obtient le verrou et continue normalement ;
 * toute tentative suivante le rate immédiatement, ne fait plus rien d'autre que quitter, et déclenche
 * l'évènement 'second-instance' CHEZ LA PREMIÈRE INSTANCE (voir plus bas showFullWindow) plutôt que
 * d'ouvrir sa propre fenêtre.
 */
registerPreviewScheme()
// Étape 177 (Léo : Windows + Maj + S sur la page Agent vocal → « après il y a aucun widget ») : Chromium
// calcule lui-même si une fenêtre est RECOUVERTE par une autre (l'écran figé de la capture, l'appli sur
// laquelle on vient de cliquer) et arrête alors de la dessiner. Pour une fenêtre TRANSPARENTE comme le petit
// Jaris, « plus dessinée » veut dire invisible — et elle ne se redessinait pas une fois découverte. Réduire
// ne recouvre rien, d'où le seul chemin qui marchait. Ce calcul est coupé : Jaris n'a que deux fenêtres.
// À poser avant `ready`, comme tout commutateur Chromium.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const gotSingleInstanceLock = app.requestSingleInstanceLock()
// Étape 312 : les choix de modèles écartent ce que la version d'Ollama installée ne sait pas charger (K2 Horizon).
setOllamaVersionSource(() => getLocalOllamaVersion())
// Étape 355 : la force que les votes des duels donnent aux modèles remplace leur note d'Artificial Analysis. Recalculée
// seulement quand les votes changent (le choix des modèles la demande à chaque calcul).
let duelStrengthCache: { votes: unknown; byCategory: Map<string, ReturnType<typeof rankDuels>> } | null = null
setDuelStrengthSource((category: DuelCategory) => {
  const votes = getDuelVotes()
  if (duelStrengthCache?.votes !== votes) duelStrengthCache = { votes, byCategory: new Map() }
  let standings = duelStrengthCache.byCategory.get(category)
  if (!standings) {
    standings = rankDuels(votes.filter((v) => v.category === category))
    duelStrengthCache.byCategory.set(category, standings)
  }
  return standings
})
// Étape 360 : un challenger ne remplace le modèle en service que s'il a plus de 95 % de chances d'être meilleur.
// Étape 361 : probabilité calculée avec l'a priori prudent de la décision (switchProbability), sur les votes de la
// catégorie, mise en cache par jeu de votes comme la force.
let switchCache: { votes: unknown; results: Map<string, number | null> } | null = null
setDuelProbability((category, challenger, incumbent) => {
  const votes = getDuelVotes()
  if (switchCache?.votes !== votes) switchCache = { votes, results: new Map() }
  const key = `${category}\u0000${challenger}\u0000${incumbent}`
  if (!switchCache.results.has(key)) {
    switchCache.results.set(key, switchProbability(votes.filter((v) => v.category === category), challenger, incumbent))
  }
  return switchCache.results.get(key) ?? null
})
// Étape 346 : le filet de téléchargement lit la même carte que le choix des modèles (registre pour AMD et Intel).
setVramSource(() => detectGpu().then((gpu) => gpu.vramGb))
// Étape 346 : la place libre se mesure sur le disque qui reçoit vraiment les modèles (celui de l'Ollama de Jaris).
setModelsDirSource(async () => (usesEmbeddedOllama() ? engineModelsDir() : null))
if (!gotSingleInstanceLock) {
  app.quit()
}

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null
/** Étape 346 : dernière relance automatique du programme d'écoute après un arrêt imprévu (voir 'crashed'). */
let lastVoiceRestartAt = 0
const VOICE_RESTART_MIN_INTERVAL_MS = 60_000
let fullWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** Passe à true via le menu de la barre système "Quitter" OU en fermant la croix de la fenêtre de réglages
 * (les deux quittent vraiment Jaris désormais) — seul minimize (juste en dessous) continue de replier en
 * widget sans jamais toucher à ce drapeau. */
let quitting = false
/** Tant que l'onboarding n'est pas fini, fermer la fenêtre de réglages doit quitter l'appli normalement (pas de widget à replier sur un profil pas encore configuré). */
let onboardingDone = false
/** Génération d'application en cours (mode Code), pour que le bouton "Arrêter" puisse l'interrompre
 * (étape 99) — `null` quand rien ne tourne. Avant, une génération partie ne pouvait plus être arrêtée
 * autrement qu'en fermant Jaris. */
let codeGenAbort: AbortController | null = null
/** Même rôle pour le mode Image (étape 200) : le dessin en cours, que « Arrêter » interrompt. */
let imageStudioAbort: AbortController | null = null
/** Et pour le mode Vidéo (étape 203). */
let videoStudioAbort: AbortController | null = null
/** Vrai pendant qu'un vrai dialogue natif Windows est ouvert sur fullWindow (ex: chooseModelsLocation) : le
 * dialogue prend le focus OS, ce qui déclenche 'blur' sur fullWindow comme un changement d'appli normal —
 * sans ce garde, le handler 'blur' plus bas cacherait fullWindow (et son dialogue enfant orphelin avec) alors
 * que Léo n'a fait que cliquer dans une fenêtre de sélection de dossier qui fait partie de Jaris. */
let dialogOpen = false
/** Vrai tant que la page Options (OptionsMenu.tsx) est ouverte dans fullWindow — elle vit dans la fenêtre
 * normale, pas une fenêtre à part, donc rien ne la distinguait jusqu'ici du reste de l'app pour 'blur'.
 * Léo : "quand on est dans les option, jaris ne doit pas partir en widget quand on part" — repli en widget
 * jugé perturbant en pleine configuration (Options a son propre bouton "Fermer", pas besoin du repli en
 * plus). Mis à jour par IPC_CHANNELS.setOptionsOpen, envoyé par OptionsMenu.tsx à chaque ouverture/fermeture. */
let optionsOpen = false
/** Horodatage jusqu'auquel 'blur' ne replie pas la fenêtre juste après son apparition au démarrage : 30 s après
 * un lancement par Windows à l'ouverture de session (LOGIN_REVEAL_GRACE_MS, launchAtStartup.ts), quelques secondes
 * après un lancement normal (STARTUP_REVEAL_GRACE_MS, étape 296). 0 = aucun délai en cours. */
let revealGraceUntil = 0

// Plus haut que large : le contenu (orbe + texte) reste ancré en haut de la fenêtre (voir .app--widget en
// CSS), donc collé au vrai bord haut de l'écran (étape 68, façon "notch"). Le reste de la hauteur, vide et
// transparent donc invisible tant qu'il n'y a rien à dire, sert de marge pour qu'une réponse longue pousse
// vers le bas sans être coupée.
const WIDGET_WIDTH = 320
const WIDGET_HEIGHT = 460
// Taille "repos" (étape 68) : juste assez pour le petit orbe réduit (voir WIDGET_ORB_COLLAPSED_SIZE côté
// renderer, App.tsx) sans texte autour — ni statut ni transcript/réponse, qui ne réapparaissent qu'une fois
// agrandi. Choisie petite ET large plutôt que carrée pour rester discrète, façon barre/notch plutôt que rond.
// Légèrement plus grande que la pilule visible elle-même (.widget-pill, index.css, ajustée à son propre
// contenu) : une pilule arrondie collée pile au bord réel de la fenêtre laisse un liseré rectangulaire
// résiduel sur Windows (antialiasing DWM d'une fenêtre transparente) — vu en usage réel par Léo. Hauteur
// remontée à 68 : l'orbe et sa pilule occupent 40px, puis 14px transparents de chaque côté laissent le halo
// de 12px se fondre entièrement au lieu d'être tranché par le bord de la fenêtre native.
const WIDGET_COLLAPSED_WIDTH = 104
const WIDGET_COLLAPSED_HEIGHT = 68

// Widget TEXTE (mode Chat) : même emplacement et même forme de pilule que le widget vocal, mais une barre
// où écrire à la place du cercle qui écoute. Forcément bien plus large que la pilule du cercle (84px) : une
// barre de saisie de 84px ne laisserait la place à aucun mot. Déplié (une question est partie), la fenêtre
// s'agrandit vers le bas pour la réponse, comme le widget vocal le fait pour la sienne.
const WIDGET_CHAT_WIDTH = 460
const WIDGET_CHAT_COLLAPSED_HEIGHT = 68
// Même valeur que le padding de `.app--widget-chat` : c'est la limite VISUELLE de la barre. La fenêtre
// native est volontairement plus grande pour laisser respirer son halo, mais entrer dans cette marge
// transparente ne doit pas compter comme rester sur le Chat.
const WIDGET_CHAT_HALO_MARGIN = 14
// Borne haute de la hauteur MESURÉE renvoyée par le widget (voir chatWidgetHeight) : au-delà, la réponse
// défile dans le widget plutôt que de manger la moitié de l'écran.
const WIDGET_CHAT_MAX_HEIGHT = 440

/**
 * Dernier statut connu du pipeline vocal, mis à jour uniquement par un vrai succès/échec de démarrage
 * (voir startVoicePipeline) — plus de pré-vérification de fichiers à faire depuis le retrait du mot
 * d'activation (openWakeWord) : la transcription/synthèse vocale se téléchargent déjà seules au besoin,
 * rien à vérifier avant de tenter de démarrer.
 */
let lastSetupStatus: VoiceSetupStatusPayload = { ready: true, missing: [] }

/**
 * Étape 294 — démarrage (Léo : « quand on ouvre Jaris, tout est pas ok, il y a les modèles qui se lancent… je veux
 * que ça se lance quand tout est ok »). Tant que `startupRevealed` est faux, ni le widget ni la grande fenêtre ne
 * s'affichent : l'écran de démarrage (`splashWindow`) montre ce qui se prépare — moteur, écoute, voix, modèle.
 * Au tout premier lancement (configuration), rien n'est retenu : les écrans d'installation ont leur propre suivi.
 */
const startup = new StartupProgress()
let startupRevealed = false
let splashWindow: BrowserWindow | null = null
/** Le suivi du moteur et du modèle n'est lancé qu'au premier démarrage du pipeline, pas à ses relances. */
let startupEngineTracked = false

/**
 * Dernière émotion connue du pipeline vocal, tenue à jour par `pipeline.on('emotion', ...)`. Sert
 * UNIQUEMENT à `showWidgetWindow` : le renderer choisit déplié/replié d'après l'émotion
 * (`widgetCollapsed = emotion === 'idle'`, App.tsx), donc la fenêtre native doit se baser sur la MÊME
 * information, sinon les deux se contredisent (voir showWidgetWindow).
 */
let lastEmotion: JarisEmotion = 'idle'

/**
 * Dernier mode choisi dans la fenêtre de réglages (Agent vocal / Chat / Code), tenu à jour par
 * `setActiveMode` — le même signal qui suspend déjà l'écoute vocale hors du mode voix.
 *
 * Il décide maintenant aussi de ce que Jaris devient quand on quitte sa fenêtre, à la demande de Léo :
 * depuis Chat, une barre de texte à la place du cercle qui écoute ; depuis Code, rien du tout. Retenu ici
 * plutôt que redemandé au renderer au moment du repli : la fenêtre est déjà en train de perdre le focus
 * quand on en a besoin, et un aller-retour IPC à cet instant arriverait trop tard pour choisir la taille
 * de la fenêtre AVANT de l'afficher.
 */
let activeMode: AppMode = 'voice'

/** Forme réellement affichée par la fenêtre widget ; le Chat alterne entre son état réduit et sa barre. */
let displayedWidgetMode: WidgetMode = 'voice'

/**
 * Hauteur demandée par le widget texte, mesurée sur son contenu réel (`null` = sa simple barre). Voir
 * `setChatWidgetHeight` : la fenêtre capte les clics sur toute sa surface une fois dépliée et reste ouverte
 * tant qu'on ne l'a pas fermée, donc sa hauteur suit ce qui est vraiment dessiné plutôt qu'une valeur fixe
 * taillée pour la réponse la plus longue.
 */
let chatWidgetHeight: number | null = null
/** Protège le brouillon puis la question/réponse : leur contenu ne doit jamais disparaître sur un clic dehors. */
let chatWidgetKeepOpen = false

/**
 * Filet natif pour la sortie de souris du Chat. Chromium peut perdre `mouseleave` quand le pointeur franchit
 * rapidement la limite d'une BrowserWindow transparente. Le minuteur ne tourne que pendant que la barre est
 * ouverte et ne peut la replier qu'après avoir vu la souris entrer dans sa surface visible : appuyer sur +
 * au clavier avec le pointeur ailleurs ne referme donc jamais la barre immédiatement.
 */
let chatPointerWatchTimer: ReturnType<typeof setInterval> | undefined
let chatPointerWasInside = false

function stopChatPointerWatch(): void {
  clearInterval(chatPointerWatchTimer)
  chatPointerWatchTimer = undefined
  chatPointerWasInside = false
}

function isPointInsideChatSurface(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number }
): boolean {
  return point.x >= bounds.x + WIDGET_CHAT_HALO_MARGIN &&
    point.x < bounds.x + bounds.width - WIDGET_CHAT_HALO_MARGIN &&
    point.y >= bounds.y + WIDGET_CHAT_HALO_MARGIN &&
    point.y < bounds.y + bounds.height - WIDGET_CHAT_HALO_MARGIN
}

function startChatPointerWatch(): void {
  stopChatPointerWatch()
  const poll = (): void => {
    if (
      currentWidgetMode() !== 'chat' || displayedWidgetMode !== 'chat' ||
      !widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()
    ) {
      stopChatPointerWatch()
      return
    }
    const inside = isPointInsideChatSurface(screen.getCursorScreenPoint(), widgetWindow.getBounds())
    if (inside) {
      chatPointerWasInside = true
    } else if (chatPointerWasInside) {
      collapseChatWidget()
    }
  }
  // Le premier relevé évite d'attendre 50 ms quand le pointeur est déjà sur la barre au moment du +.
  chatPointerWatchTimer = setInterval(poll, 50)
  poll()
}

/**
 * La forme du widget vient du mode actif, et d'une SEULE source : la taille native de la fenêtre (ici) et
 * le contenu dessiné (App.tsx) doivent en dériver ensemble. Les faire décider séparément est exactement ce
 * qui avait produit l'orbe rogné en fine bande (le renderer dessinait déplié, le main forçait replié).
 *
 * Le mode Code n'a pas de forme : c'est `showWidgetWindow` qui n'affiche alors aucune fenêtre.
 */
function currentWidgetMode(): WidgetMode {
  return activeMode === 'chat' ? 'chat' : 'voice'
}

/**
 * Le widget vocal est le seul à écouter. En repliant depuis Chat (barre de texte) ou Code (rien du tout),
 * l'écoute reste suspendue : un Jaris qui réagirait encore au mot d'activation alors qu'il n'affiche
 * qu'une barre de texte — ou rien — n'aurait aucun moyen de montrer qu'il a entendu.
 */
function applyListeningForActiveMode(): void {
  // Étape 183 : les Options aussi — le détecteur de voix n'écoute qu'en mode Agent vocal, Options fermées.
  pipeline?.setListeningSuspended(activeMode !== 'voice' || optionsOpen)
}

/** Ajoute un nœud central représentant l'utilisateur, relié à chaque note, pour donner une vraie structure au graphe (sinon les notes flottent sans lien tant que Jaris n'a pas écrit de [[...]] entre elles). */
async function buildMemoryGraphWithUser(): Promise<MemoryGraph> {
  const [graph, profile] = await Promise.all([getMemoryGraph(), getProfile()])
  if (!profile?.name) return graph

  const otherNodes = graph.nodes.filter((node) => node.id !== profile.name)
  return {
    nodes: [{ id: profile.name, isCenter: true }, ...otherNodes],
    links: [...otherNodes.map((node) => ({ source: profile.name, target: node.id })), ...graph.links]
  }
}

function loadRenderer(win: BrowserWindow, mode: 'full' | 'widget' | 'splash'): void {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=${mode}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode } })
  }
}

/**
 * Fenêtre normale de Jaris (onboarding, orbe, conversation, Options, cerveau de Jaris). Elle s'affiche au
 * tout premier lancement, puis reste préchargée mais cachée aux démarrages suivants : l'icône près de
 * l'horloge permet toujours de l'ouvrir. La réduire la cache ; fermer sa croix quitte VRAIMENT Jaris (voir
 * `quitting`) — Léo s'attend à ce que fermer l'appli la ferme pour de bon, pas qu'elle continue de tourner
 * sans qu'il s'en rende compte.
 */
/** Hauteur de la barre de titre dessinée par Jaris (design v2) : celle des applis Windows 11. */
const TITLE_BAR_HEIGHT = 40

/**
 * Étape 266 (Léo : « ça fait trop application Windows avec la couleur violet, fais une vraie application
 * stylée ChatGPT ») : plus d'effet Mica (le fond de bureau teintait la fenêtre) ni de couleur d'accent de
 * Windows (la sienne est violette) — des gris neutres, les mêmes sur toutes les machines. Seule la barre de
 * titre dessinée par Jaris reste, avec les vrais boutons de Windows par-dessus.
 */
function windowChrome(): WindowChrome {
  return { titleBar: process.platform === 'win32' }
}

/** Couleur des symboles réduire/agrandir/fermer : elle suit le thème clair ou sombre de Windows. */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1b1b1b',
    height: TITLE_BAR_HEIGHT
  }
}

/**
 * Transcrit un WAV 16 kHz mono avec le modèle déjà chargé pour le micro : message vocal du téléphone (étape 214)
 * et dictée du champ de saisie (étape 276). Le fichier temporaire est écrit par Jaris lui-même, puis effacé.
 */
async function transcribeWav(wav: Buffer): Promise<string> {
  if (!pipeline) throw new Error(t('main.noPipeline'))
  const path = join(tmpdir(), `jaris-dictee-${randomUUID()}.wav`)
  await writeFile(path, wav)
  try {
    return await pipeline.transcribeFile(path)
  } finally {
    await rm(path, { force: true })
  }
}

function createFullWindow(showWhenReady = true): BrowserWindow {
  const chrome = windowChrome()
  const win = new BrowserWindow({
    icon: createAppIcon(),
    width: 1000,
    height: 760,
    minWidth: 480,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Design v2 (style Windows 11) : barre de titre native cachée, mais les vrais boutons de Windows gardés
    // par-dessus (titleBarOverlay) — Jaris dessine le reste de la barre (logo, nom, zone de déplacement).
    ...(chrome.titleBar ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() } : {}),
    // Le fond de la barre latérale (index.css, --jv-side) : rien ne clignote d'une autre couleur au démarrage.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#f9f9f9',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false
    }
  })

  // Après l'onboarding, Jaris démarre désormais discrètement : la fenêtre complète reste chargée mais
  // cachée, prête à être ouverte depuis l'icône près de l'horloge. Au tout premier lancement elle doit en
  // revanche apparaître pour permettre la configuration. Le paramètre évite un `show()` tardif du
  // ready-to-show qui ferait réapparaître la fenêtre après l'avoir volontairement cachée au démarrage.
  if (showWhenReady) win.on('ready-to-show', () => win.show())
  // Fermer la croix quitte vraiment Jaris (widget compris, via app.quit() qui referme aussi les autres
  // fenêtres) — avant cette version, fermer la croix se repliait silencieusement en widget comme minimize,
  // ce qui laissait Jaris tourner en arrière-plan sans que Léo s'en rende compte en cliquant la croix.
  win.on('close', () => {
    if (quitting) return
    quitting = true
    app.quit()
  })
  // Pas de preventDefault possible sur 'minimize' (déjà fait quand l'évènement arrive) : on laisse
  // Windows réduire, puis on cache complètement la fenêtre (plus d'icône dans la barre des tâches) et
  // on montre le widget à la place.
  win.on('minimize', () => {
    // Étape 177 (Léo : « dans code et option il y a aucun widget, ça veut dire qu'ils doivent pas disparaître
    // dès que je fais moins… pour le rouvrir on doit aller à côté de l'horloge ») : sans widget à montrer,
    // Jaris se réduit comme n'importe quelle application — il reste dans la barre des tâches.
    if (!onboardingDone || !hasWidgetToShow()) return
    win.hide()
    showWidgetWindow()
    applyListeningForActiveMode()
  })
  // Léo a signalé qu'en changeant simplement d'application (ex: passer sur le navigateur) SANS cliquer sur
  // réduire, rien n'indiquait plus que Jaris tournait ("jaris est ouvert mais pas en haut") — contrairement à
  // l'intention d'origine de l'étape 19 ("visible même quand une autre appli a le focus"), jusqu'ici seul
  // 'minimize' déclenchait le repli en widget, jamais une simple perte de focus. 'blur' traite maintenant ce
  // cas exactement comme minimize (même repli) — sauf pendant un vrai dialogue natif de Jaris (`dialogOpen`,
  // ex: chooseModelsLocation), qui prend aussi le focus OS sans que Léo ait quitté Jaris pour autant.
  //
  // `quitting` fait partie du même garde, trouvé en creusant "je clique sur mis à jour et ça fait 100% puis
  // plus rien" : fermer une fenêtre lui fait perdre le focus AVANT de se fermer pour de bon, donc 'blur' se
  // déclenche aussi pendant la séquence de app.quit() (mise à jour de Jaris, croix, "Quitter" du menu). Sans
  // ce garde, ce 'blur' recréait le widget en PLEIN milieu de la fermeture — un widgetWindow tout juste
  // recréé (s'il venait d'être fermé par ce même app.quit()) redevient une fenêtre bien vivante, et
  // Electron ne quitte jamais tant qu'il reste une fenêtre ouverte : la mise à jour ne se lançait donc
  // jamais, sans la moindre erreur visible. `quitting` passe à `true` par tous les chemins de fermeture
  // volontaire AVANT le moindre appel à `app.quit()` (voir sa déclaration plus haut) : le consulter ici
  // suffit, pas besoin d'un drapeau dédié de plus.
  //
  // `optionsOpen` : Léo, juste après - "quand on est dans les option, jaris ne doit pas partir en widget
  // quand on part". La page Options (OptionsMenu.tsx) vit dans fullWindow, pas une fenêtre à part : sans ce
  // garde, cliquer sur une autre appli en pleine configuration (ex: vérifier un réglage ailleurs) repliait
  // Jaris en widget, perdant l'accès direct à la page Options (repliée avec le reste de la fenêtre derrière
  // le petit widget) — Options a déjà son propre bouton "Fermer" pour signaler qu'on a vraiment fini.
  win.on('blur', () => {
    if (!onboardingDone || dialogOpen || quitting || !hasWidgetToShow()) return
    // Étape 165 : juste après l'ouverture de session, l'Explorateur et les autres programmes de démarrage
    // prennent le focus — ce n'est pas Léo qui change d'appli, la fenêtre doit rester affichée. Étape 296 : même
    // chose juste après l'écran de démarrage, où Windows termine encore de passer le premier plan à cette fenêtre.
    if (Date.now() < revealGraceUntil) return
    win.hide()
    applyListeningForActiveMode()
    // Étape 176 (Léo : « si je clique sur une autre application il disparaît sans widget… il montre le
    // widget que quand je diminue la page avec le bouton ») : réduire marchait, perdre le focus non, alors
    // que les deux appelaient exactement le même code. Seule différence : ici, on est EN PLEIN changement de
    // fenêtre active de Windows (l'autre appli prend la main). Afficher le widget à cet instant précis
    // entrait en conflit avec cette bascule. On attend qu'elle soit finie, puis on vérifie qu'il est là.
    setTimeout(() => revealWidgetAfterLeaving(win), WIDGET_AFTER_BLUR_DELAY_MS)
  })

  loadRenderer(win, 'full')
  return win
}

/**
 * Widget flottant façon J.A.R.V.I.S. (étape 19) : sans bordure, transparent, toujours au-dessus des autres
 * fenêtres, en haut au centre de l'écran (étape 68) — visible même quand une autre appli (navigateur, jeu...)
 * a le focus, y compris en changeant simplement d'appli SANS minimiser (voir `win.on('blur', ...)` dans
 * createFullWindow). C'est bien la présence permanente attendue hors de l'application : petit orbe inactif
 * en Vocal, petit indicateur inactif en Chat, aucune forme en Code. Le + déplie l'écoute vocale ou la barre
 * de saisie Chat ; « Jaris » déplie aussi le widget vocal, qui revient ensuite à son petit état au repos.
 */
/** Taille de l'écran de démarrage : la carte (index.css, .startup) plus une marge transparente tout autour. */
const SPLASH_WIDTH = 380
const SPLASH_HEIGHT = 420
/** Durée laissée à la carte pour s'effacer (animation de sortie, index.css) avant que Jaris apparaisse. */
const SPLASH_EXIT_MS = 380
/** Filet : une fenêtre de Jaris qui ne finirait jamais de se charger ne doit pas bloquer l'affichage. */
const SPLASH_WINDOWS_LOAD_LIMIT_MS = 15_000
/** Étape 296 : après l'écran de démarrage, une perte de focus pendant ce délai ne replie pas Jaris en widget. */
const STARTUP_REVEAL_GRACE_MS = 5_000

/**
 * Étape 294 — l'écran de démarrage, façon ChatGPT : une petite carte au centre de l'écran (l'orbe de Jaris et ce qui
 * se prépare), affichée dès le lancement et fermée quand tout est prêt. Le fermer soi-même (Alt+F4, barre des tâches)
 * avant la fin quitte Jaris, comme on l'attend d'une application qu'on vient de lancer par erreur.
 */
function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    icon: createAppIcon(),
    title: 'Jaris',
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    center: true,
    frame: false,
    // Transparente, la carte arrondie dessinée avec une marge (même parade que le widget pour les coins de Windows).
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false
    }
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && !startupRevealed) win.show()
  })
  win.on('close', () => {
    if (startupRevealed || quitting) return
    quitting = true
    app.quit()
  })
  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null
  })
  loadRenderer(win, 'splash')
  return win
}

/** Une fenêtre prête à être montrée (son premier rendu fait), ou le filet de temps dépassé. */
function windowLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    const limit = setTimeout(resolve, SPLASH_WINDOWS_LOAD_LIMIT_MS)
    win.once('ready-to-show', () => {
      clearTimeout(limit)
      resolve()
    })
  })
}

/**
 * Étape 294 — tout est prêt : la carte de démarrage joue sa sortie (elle vient de recevoir `ready`), puis la fenêtre
 * de Jaris s'ouvre à sa place — en grand si Jaris a été lancé par Windows à l'ouverture de session (étape 165).
 *
 * Étape 296 (Léo, après la 0.34.2 : « j'ouvre, ça se met toujours directement en widget ») : la fenêtre s'ouvrait
 * bien, puis se repliait aussitôt. L'écran de démarrage était détruit AVANT d'afficher la fenêtre : pendant cet
 * instant, Windows donne le premier plan à une autre application, la fenêtre de Jaris arrive sans focus ou le
 * perd aussitôt, et son 'blur' la replie en widget comme si Léo avait changé d'appli. Seul le lancement à
 * l'ouverture de session avait une protection (délai de grâce + premier plan forcé). Désormais, pour TOUT
 * lancement : la fenêtre est affichée et mise au premier plan PENDANT que l'écran de démarrage a encore le focus
 * (le passage se fait d'une fenêtre de Jaris à l'autre), avec le même délai de grâce, et l'écran de démarrage
 * n'est fermé qu'ensuite.
 */
function revealAfterStartup(revealAtLogin: boolean): void {
  if (startupRevealed) return
  setTimeout(() => {
    startupRevealed = true
    const splash = splashWindow
    splashWindow = null
    const win = fullWindow
    if (!quitting && win && !win.isDestroyed()) {
      // Le délai de grâce part de l'affichage, pas du lancement : à l'ouverture de session, les autres programmes
      // prennent encore le focus à ce moment-là.
      revealGraceUntil = Date.now() + (revealAtLogin ? LOGIN_REVEAL_GRACE_MS : STARTUP_REVEAL_GRACE_MS)
      if (revealAtLogin) win.maximize()
      // Brièvement au premier plan forcé : Windows peut refuser le focus à une fenêtre qui s'ouvre sans clic, et
      // elle resterait derrière les autres.
      win.setAlwaysOnTop(true)
      showFullWindow()
      win.moveTop()
      win.setAlwaysOnTop(false)
    } else if (!quitting) {
      showFullWindow()
    }
    // Seulement maintenant : le premier plan est déjà passé à la fenêtre de Jaris.
    if (splash && !splash.isDestroyed()) splash.destroy()
    warnIfStorageDiskMissing()
  }, SPLASH_EXIT_MS)
}

/**
 * Étape 346 : données rangées sur un disque externe débranché — Jaris démarre sur l'emplacement par défaut (rien n'est
 * recréé vide sur le disque), et le dit au lieu de laisser croire que conversations et modèles ont disparu.
 */
function warnIfStorageDiskMissing(): void {
  const missing = getMissingStorageRoot()
  if (!missing) return
  const drive = /^([A-Za-z]:)/.exec(missing)?.[1] ?? missing
  const message = t('storage.diskMissing', { drive })
  broadcast(IPC_CHANNELS.log, message)
  if (Notification.isSupported()) new Notification({ title: 'Jaris', body: message }).show()
}

function createWidgetWindow(): BrowserWindow {
  // Position définitive posée juste avant l'affichage par positionWidgetWindow() (recalculée à chaque
  // fois, pas figée ici) : la valeur de départ n'a pas d'importance tant que la fenêtre reste cachée.
  const win = new BrowserWindow({
    icon: createAppIcon(),
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    // Sur Windows, une fenêtre transparente sans backgroundColor explicite affiche parfois un carré
    // opaque avant le premier vrai rendu (ou si le compositing DWM ne suit pas) : le forcer en
    // "entièrement transparent" (8 chiffres hexa, alpha = 00) évite ce carré résiduel.
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    // Étape 275 (Léo : « il ne doit pas bouger ») : une encoche fixe en haut au centre, jamais déplaçable —
    // pas de zone de déplacement dans la page (index.css) ET refusé par Windows lui-même.
    movable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      // Étape 177 : caché la plupart du temps, le widget ne doit pas être mis en veille par Chromium — sinon il
      // réapparaît sans image (donc invisible, puisque transparent) jusqu'à son prochain rafraîchissement.
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Pas d'auto-show Electron avant le rendu : le widget est créé caché, puis showWidgetWindow() l'affiche
  // dès `ready-to-show` dans son petit état inactif. Cela conserve sa présence permanente sans flash vide.
  // Un clic dans une autre application fait perdre le focus avant que Chromium ne garantisse un mouseleave.
  // C'est le chemin immédiat demandé par Léo pour une barre VIDE ; collapseChatWidget protège le brouillon.
  win.on('blur', () => collapseChatWidget())

  loadRenderer(win, 'widget')
  return win
}

/**
 * Recalcule la position en haut au centre de l'écran actuel (étape 68) : pas fixée une fois pour toutes à la
 * création, au cas où l'écran/la zone de travail a changé depuis (résolution, second écran...). Collé au
 * bord haut (y = workArea.y, sans marge) façon "notch" — seule la largeur/hauteur change entre `expanded`
 * (orbe + statut + conversation, ou barre Chat) et l'état "repos" permanent (petit orbe ou petit indicateur
 * Chat). `showWidgetWindow` démarre à la taille correspondant au mode et `pipeline.on('emotion', ...)` plus
 * bas rappelle celle-ci à chaque changement pour déplier/replier en direct.
 * Un simple `setBounds` (pas d'animation native) : Electron n'anime pas les changements de bounds sur
 * Windows, contrairement à macOS — le CSS interne (.app--widget-collapsed, index.css) compense en faisant
 * un fondu/zoom sur le CONTENU. Le repli natif est différé jusqu’à la fin de cette transition.
 */
let widgetCollapseTimer: ReturnType<typeof setTimeout> | undefined

function positionWidgetWindow(win: BrowserWindow, expanded: boolean, animate = false): void {
  clearTimeout(widgetCollapseTimer)
  widgetCollapseTimer = undefined
  if (!expanded && animate) {
    // Laisser le renderer terminer son fondu/zoom avant de couper la fenêtre.
    widgetCollapseTimer = setTimeout(() => {
      widgetCollapseTimer = undefined
      if (!win.isDestroyed() && win.isVisible()) positionWidgetWindow(win, false)
    }, 340)
    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  // Garder le même x et la même largeur évite que Windows déplace l’ancienne
  // image avant que Chromium ait recalculé son centrage (saut de 118 px).
  const shaped = process.platform === 'win32' || process.platform === 'linux'
  // Le widget texte (mode Chat) a ses propres dimensions : sa barre de saisie ne tiendrait pas dans la
  // pilule de 84px du widget vocal. Les deux formes gardent la même mécanique (pleine largeur de fenêtre en
  // permanence, `setShape` qui restreint la zone qui capte les clics au repos).
  const chat = currentWidgetMode() === 'chat'
  const fullWidth = chat ? WIDGET_CHAT_WIDTH : WIDGET_WIDTH
  const restWidth = WIDGET_COLLAPSED_WIDTH
  const restHeight = WIDGET_COLLAPSED_HEIGHT
  const chatHeight = Math.min(chatWidgetHeight ?? WIDGET_CHAT_COLLAPSED_HEIGHT, WIDGET_CHAT_MAX_HEIGHT)
  const width = shaped || expanded ? fullWidth : restWidth
  const height = expanded ? (chat ? Math.max(chatHeight, restHeight) : WIDGET_HEIGHT) : restHeight
  win.setBounds({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y,
    width,
    height
  })
  if (shaped) {
    // La région native laisse réellement passer les clics hors de la pilule.
    win.setShape(expanded ? [] : [{
      x: Math.round((fullWidth - restWidth) / 2),
      y: 0, width: restWidth, height: restHeight
    }])
  }
}

/** Les deux fenêtres ne sont jamais visibles en même temps (sinon double lecture audio des réponses). */
function showFullWindow(): void {
  // Étape 294 : pendant le démarrage, l'écran d'accueil reste devant ; la grande fenêtre s'ouvre quand tout est prêt.
  if (!startupRevealed) {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show()
      splashWindow.focus()
    }
    return
  }
  stopChatPointerWatch()
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
  if (!fullWindow || fullWindow.isDestroyed()) fullWindow = createFullWindow()
  // Réduit dans la barre des tâches (mode Code, Options) : show() seul ne le rouvrirait pas.
  if (fullWindow.isMinimized()) fullWindow.restore()
  fullWindow.show()
  fullWindow.focus()
}

/**
 * Taille native alignée sur l'ÉMOTION en cours, pas forcée à "replié".
 *
 * Cette fonction supposait jusqu'ici que Jaris se replie toujours depuis un moment calme (fin
 * d'onboarding, fenêtre de réglages réduite) et "jamais en pleine écoute/réponse" — hypothèse FAUSSE,
 * signalée par Léo en usage réel : il parle à Jaris puis réduit la fenêtre pendant qu'il écoute encore.
 * Le renderer, lui, se base uniquement sur l'émotion (`widgetCollapsed = emotion === 'idle'`, App.tsx) et
 * dessinait donc le widget DÉPLIÉ (orbe de 160px + statut + conversation) dans une fenêtre native forcée à
 * la taille REPLIÉE (48px de haut, en plus restreinte par `setShape` à 84x48) : l'orbe se faisait rogner en
 * une fine bande horizontale flottant par-dessus les autres applis ("ça fait sa avec google chatgpt claude
 * partout").
 */
/**
 * Étape 177 : Jaris ne disparaît de la barre des tâches (réduire, perte de focus) QUE s'il laisse un widget à
 * sa place. En mode Code (aucun widget, à dessein) et pendant les Options (Léo : « quand on est dans les
 * options, Jaris ne doit pas partir »), il reste une fenêtre normale : sinon, seule l'icône près de l'horloge
 * permettait de le retrouver.
 */
function hasWidgetToShow(): boolean {
  return !modeWithoutWidget() && !optionsOpen
}

/** Code, Image et Vidéo (étapes 200 et 203) n'ont pas de widget : ce sont des écrans de travail. */
function modeWithoutWidget(): boolean {
  // Étape 355 : le Duel non plus — on y compare des modèles, Jaris n'y répond pas lui-même.
  return activeMode === 'code' || activeMode === 'image' || activeMode === 'video' || activeMode === 'duel'
}

/** Délai avant d'afficher le widget après une perte de focus : juste le temps que Windows finisse la bascule. */
const WIDGET_AFTER_BLUR_DELAY_MS = 80

/**
 * Étape 176 : affiche le widget une fois la bascule de Windows terminée, puis VÉRIFIE qu'il est bien là et le
 * réaffiche une fois sinon — un widget qui manque laisse Jaris invisible, seulement joignable près de l'horloge.
 */
function revealWidgetAfterLeaving(win: BrowserWindow): void {
  if (quitting || win.isDestroyed() || win.isVisible()) return
  showWidgetWindow()
  setTimeout(() => {
    if (quitting || modeWithoutWidget() || win.isDestroyed() || win.isVisible()) return
    if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) return
    showWidgetWindow()
  }, 400)
}

/**
 * Étape 178 (Léo : après Windows + Maj + S, « dès que je finis la capture il est plus là… il revient jamais »,
 * alors que réduire, changer d'appli, la barre des tâches marchent désormais). L'outil de capture de Windows fait
 * disparaître le widget par un chemin que Jaris ne voit pas (aucun évènement, invérifiable sans Windows). Plutôt
 * qu'une 3e hypothèse sur la cause, Jaris CONSTATE l'état réel chaque seconde : grande fenêtre cachée et un
 * widget attendu → le widget doit être visible et au premier plan, sinon il est remis. Même principe que le
 * contrôle SearXNG (étape 103) : vérifier ce qui est vrai à l'écran plutôt que supposer qu'un évènement a suffi.
 */
const WIDGET_WATCHDOG_MS = 1000

function watchWidgetPresence(): void {
  setInterval(() => {
    if (!onboardingDone || quitting || !startupRevealed || !hasWidgetToShow()) return
    if (!fullWindow || fullWindow.isDestroyed() || fullWindow.isVisible()) return
    if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) {
      showWidgetWindow()
      return
    }
    // « Visible » pour Windows ne veut pas dire affiché : réaffiché sans voler le focus, remis au premier
    // plan et redessiné — trois opérations sans effet quand tout va déjà bien.
    widgetWindow.showInactive()
    widgetWindow.setAlwaysOnTop(true, 'floating')
    widgetWindow.webContents.invalidate()
  }, WIDGET_WATCHDOG_MS)
}

/** Le widget affiché est-il déplié ? Barre Chat ouverte, ou widget vocal en activité. */
function widgetExpandedNow(): boolean {
  if (displayedWidgetMode === 'chat') return true
  if (displayedWidgetMode === 'chat-idle') return false
  return lastEmotion !== 'idle'
}

/**
 * Étape 346 : la place du widget (haut, au centre) n'était calculée qu'à son affichage. Un second écran branché ou
 * retiré, ou une échelle changée (100 % → 150 %), le laissait décalé, voire hors de l'écran, jusqu'au prochain
 * changement d'état. Il est recentré dès que Windows annonce un changement d'écran.
 */
function recenterWidget(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return
  positionWidgetWindow(widgetWindow, widgetExpandedNow())
}

function showWidgetWindow(forceExpanded = false): void {
  // Étape 294 : rien ne s'affiche avant la fin du démarrage (voir `startupRevealed`).
  if (!startupRevealed) return
  if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) return
  // Depuis le mode Code, Jaris disparaît complètement : "ça doit rien faire aucun widget" (Léo). Un widget
  // déjà affiché est caché plutôt que laissé tel quel — sinon, passer en Code puis quitter la fenêtre
  // laisserait à l'écran la forme du mode précédent, qui ne correspond plus à rien. Jaris reste joignable
  // par son icône dans la barre système ("Ouvrir Jaris").
  if (modeWithoutWidget()) {
    stopChatPointerWatch()
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
    return
  }
  if (!widgetWindow || widgetWindow.isDestroyed()) widgetWindow = createWidgetWindow()
  // Envoyé AVANT show() : le renderer doit dessiner la bonne forme dès la première frame peinte, sinon le
  // widget apparaît sous son ancienne forme puis change sous les yeux de l'utilisateur (même famille de
  // défaut que la transition rejouée depuis un état périmé, corrigée par `widgetInstant` côté App.tsx).
  displayedWidgetMode = currentWidgetMode() === 'chat' && !forceExpanded ? 'chat-idle' : currentWidgetMode()
  widgetWindow.webContents.send(IPC_CHANNELS.widgetMode, displayedWidgetMode)
  const voice = currentWidgetMode() === 'voice'
  const expanded = voice ? forceExpanded || lastEmotion !== 'idle' : forceExpanded
  positionWidgetWindow(widgetWindow, expanded)
  // Le raccourci + part souvent pendant qu'une autre application a le focus. Afficher la barre Chat sans
  // lui donner le focus obligerait à recliquer dedans avant d'écrire, alors que + vient précisément de
  // demander cette saisie. Le widget vocal, lui, ne vole jamais le focus pendant une activation à la voix.
  if (displayedWidgetMode === 'chat') {
    widgetWindow.show()
    widgetWindow.focus()
    startChatPointerWatch()
  } else {
    // Étape 176 : showInactive, pas show() — show() tentait de reprendre le focus à l'application sur
    // laquelle Léo vient de cliquer, au moment même où Windows la lui donne.
    widgetWindow.showInactive()
    stopChatPointerWatch()
  }
  // Réaffirmé à chaque affichage : Windows peut perdre le « toujours au-dessus » d'une fenêtre cachée puis
  // réaffichée, et le widget passerait alors derrière l'application ouverte.
  widgetWindow.setAlwaysOnTop(true, 'floating')
  // Étape 177 : une image neuve tout de suite, pour ne jamais réafficher une fenêtre transparente vide.
  widgetWindow.webContents.invalidate()
  // Étape 256 : un widget créé ou réaffiché pendant un pilotage reste hors de la vue et des clics du pilote.
  if (pilotTasks > 0 || pilotBorrowing) applyPilotWidgetGuard()
}

/**
 * Ouvre la barre de saisie du widget Chat, clavier prêt à écrire : touche « + » seulement. Un clic sur le petit
 * indicateur ramène toute l'application (étape 338 ; il ouvrait la barre depuis l'étape 325, et Léo ne pouvait plus revenir).
 * `showWidgetWindow(true)` dérive la forme native, la région cliquable et le contenu dessiné du même état, et relance
 * le relevé du pointeur DÉSARMÉ : il ne repliera la barre qu'après y avoir vu entrer la souris puis en sortir — un
 * clic arrive avec la souris déjà dans la fenêtre, la barre ne se replie donc pas aussitôt.
 */
function openChatWidgetBar(): void {
  // Un indicateur resté à l'écran d'un mode précédent (clic juste avant un changement de mode) ne doit jamais
  // ouvrir la barre du Chat hors du mode Chat, ni par-dessus la grande fenêtre (les deux ne s'affichent jamais ensemble).
  if (!startupRevealed || activeMode !== 'chat') return
  if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) return
  showWidgetWindow(true)
}

/** Pourquoi l'écoute ne peut pas démarrer maintenant, `null` si elle le peut (étape 325). */
function listeningUnavailable(): string | null {
  return pipeline ? pipeline.listeningUnavailable() : t('main.voiceNotReady')
}

/** Jaris réduit : une même raison n'est pas redonnée en notification à chaque pression de « + ». */
const WAKE_NOTICE_REPEAT_MS = 30_000
let lastWakeNotice = { reason: '', at: 0 }

/**
 * Étape 325 : « Parler à Jaris », l'orbe et « + » ne faisaient RIEN quand l'écoute n'était pas prête — et « + »
 * dépliait même le widget vocal pour rien (une grande zone invisible qui capte les clics en haut de l'écran, le
 * pipeline ne passant jamais à l'écoute). La raison va à l'écran vocal, près du bouton ; si la grande fenêtre est
 * cachée (Jaris réduit), une notification de Windows la dit, le widget restant replié.
 */
function reportWakeUnavailable(reason: string): void {
  broadcast(IPC_CHANNELS.wakeAvailability, { reason, attempt: true } satisfies WakeAvailabilityPayload)
  if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible() && !fullWindow.isMinimized()) return
  const now = Date.now()
  if (reason === lastWakeNotice.reason && now - lastWakeNotice.at < WAKE_NOTICE_REPEAT_MS) return
  lastWakeNotice = { reason, at: now }
  if (Notification.isSupported()) new Notification({ title: t('voice.wakeUnavailable.title'), body: reason }).show()
}

/** La touche + ouvre la forme du mode actif : barre écrite en Chat, écoute visible en Agent vocal. */
function triggerVisibleWake(): void {
  if (!startupRevealed || modeWithoutWidget()) return
  if (activeMode === 'chat') {
    openChatWidgetBar()
    return
  }
  // Vérifié AVANT de déplier le widget : pipeline pas encore créé (premières secondes), programme d'écoute qui
  // charge encore (premier lancement : téléchargement de la transcription), en échec ou arrêté — il ne répondrait
  // pas à « trigger », et le widget resterait déplié pour rien.
  const reason = listeningUnavailable()
  if (reason !== null || !pipeline) {
    reportWakeUnavailable(reason ?? t('main.voiceNotReady'))
    return
  }
  if (!fullWindow?.isVisible()) showWidgetWindow(true)
  pipeline.triggerWake()
  lastWakeNotice = { reason: '', at: 0 }
  broadcast(IPC_CHANNELS.wakeAvailability, { reason: null, attempt: true } satisfies WakeAvailabilityPayload)
}

/** Dès que la souris quitte la barre Chat, elle rend sa place au petit indicateur inactif permanent. */
function collapseChatWidget(): void {
  if (
    currentWidgetMode() !== 'chat' || displayedWidgetMode !== 'chat' ||
    !widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible() || chatWidgetKeepOpen
  ) return
  stopChatPointerWatch()
  displayedWidgetMode = 'chat-idle'
  chatWidgetHeight = null
  widgetWindow.webContents.send(IPC_CHANNELS.widgetMode, displayedWidgetMode)
  positionWidgetWindow(widgetWindow, false, true)
}

/**
 * Étape 256 — les gestes de pilotWindows.ts : écarter Jaris pendant qu'il pilote l'écran. La grande fenêtre se
 * replie exactement comme quand on clique ailleurs (en widget, ou réduite s'il n'y a pas de widget à montrer) ; elle
 * ne revient pas d'elle-même à la fin, sinon elle recouvrirait le résultat que Léo vient de demander. Le widget
 * reste affiché, mais invisible aux captures (même protection que l'animation de scan, scanOverlay.ts) et
 * transparent aux clics : le pilote ne doit ni le voir ni cliquer dessus.
 */
let pilotTasks = 0
/** Étape 263 : un geste emprunté à Léo pendant un pilotage en arrière-plan (le widget ne doit pas intercepter le clic). */
let pilotBorrowing = false

function applyPilotWidgetGuard(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const guarded = pilotTasks > 0 || pilotBorrowing
  widgetWindow.setContentProtection(guarded)
  widgetWindow.setIgnoreMouseEvents(guarded)
}

function setPilotBorrowGuard(on: boolean): void {
  pilotBorrowing = on
  applyPilotWidgetGuard()
}

async function setJarisAsideForPilot(): Promise<void> {
  pilotTasks++
  const shown = !!fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible() && !fullWindow.isMinimized()
  if (shown && fullWindow) {
    if (onboardingDone && hasWidgetToShow()) {
      fullWindow.hide()
      showWidgetWindow()
      applyListeningForActiveMode()
    } else {
      fullWindow.minimize()
    }
  }
  applyPilotWidgetGuard()
  // Le temps que Windows retire vraiment la fenêtre de l'écran avant la première capture.
  if (shown) await new Promise((resolve) => setTimeout(resolve, 400))
}

function bringJarisBackAfterPilot(): void {
  pilotTasks = Math.max(0, pilotTasks - 1)
  applyPilotWidgetGuard()
}

/** Menu de l'icône de la barre système, reconstruit quand la langue change (un menu natif ne se retraduit pas seul). */
function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.open'), click: () => showFullWindow() },
      { type: 'separator' },
      {
        label: t('tray.quit'),
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

/** Envoie un évènement du pipeline vocal à toutes les fenêtres actuellement ouvertes (réglages et/ou widget). */
function broadcast(channel: string, payload?: unknown): void {
  if (channel === IPC_CHANNELS.log) console.log('[jaris]', payload)
  for (const win of [fullWindow, widgetWindow, splashWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Accès depuis le téléphone (étape 214, Léo : « on va faire parler depuis son téléphone », partout et
 * confidentiel, sans appli à installer à côté). Créé à la première utilisation seulement : tant que Léo ne
 * l'active pas, rien n'écoute et aucun tunnel ne tourne.
 */
let phoneAccess: PhoneAccessManager | null = null
/** Pages Tailscale déjà ouvertes automatiquement dans le navigateur (une seule fois chacune). */
const openedPhoneLinks = new Set<string>()
/** Vrai juste après un clic sur « Activer » : seulement là, les pages Tailscale s'ouvrent toutes seules. */
let phoneLinksAutoOpen = false

/**
 * Choix du modèle et de la réflexion d'un mode (Chat, Code, Vocal). Partagé par l'écran du PC et par le
 * téléphone (étape 216) : les deux montrent et enregistrent exactement le même réglage.
 */
async function readModelChoice(mode: ModelChoiceMode): Promise<ModelChoiceInfo> {
  if (!MODEL_CHOICE_MODES.includes(mode)) throw new Error(`Mode inconnu : ${String(mode)}`)
  const installed = await listInstalledModels().catch(() => null)
  const profile = await getProfile()
  const info = buildModelChoiceInfo(profile, mode, installed)
  // Étape 192 : d'abord le modèle, puis SES vrais choix de réflexion. En Chat/Vocal Auto le modèle change
  // selon la question : rien à proposer d'exact, l'écran demande de choisir un modèle d'abord.
  const model = thinkingModelFor(profile, mode, installed, info.autoModel)
  if (!model) return { ...info, thinking: null }
  const meta = await getModelThinking(model)
  return {
    ...info,
    thinking: {
      model,
      kind: thinkingKind(meta),
      options: thinkOptions(meta),
      selected: chosenThink(profile?.thinkChoices?.[mode], model, meta) ?? null
    }
  }
}

async function saveThinkChoice(mode: ModelChoiceMode, think: unknown): Promise<void> {
  if (!MODEL_CHOICE_MODES.includes(mode)) throw new Error(`Mode inconnu : ${String(mode)}`)
  const profile = await getProfile()
  if (!profile) throw new Error('Profil introuvable.')
  const thinkChoices = { ...profile.thinkChoices }
  if (think === null) {
    delete thinkChoices[mode]
  } else {
    // La valeur vient de l'écran : revérifiée ICI contre ce que le modèle annonce vraiment.
    const installed = await listInstalledModels()
    const model = thinkingModelFor(profile, mode, installed, buildModelChoiceInfo(profile, mode, installed).autoModel)
    if (!model) throw new Error(t('main.chooseModelFirst'))
    if (!isAcceptedThink(think, await getModelThinking(model))) throw new Error(t('main.thinkRejected', { model }))
    thinkChoices[mode] = { model, think }
  }
  await saveProfile({ ...profile, thinkChoices })
}

async function saveModelChoice(mode: ModelChoiceMode, model: string | null): Promise<void> {
  const profile = await getProfile()
  if (!profile) throw new Error('Profil introuvable.')
  const installed = model === null ? [] : await listInstalledModels()
  // Étape 192 : la réflexion était choisie pour l'ancien modèle ; elle repart en Auto avec le nouveau.
  const thinkChoices = { ...profile.thinkChoices }
  delete thinkChoices[mode]
  await saveProfile(applyModelChoice({ ...profile, thinkChoices }, mode, model, installed))
}

function tunnelBinaryPath(): string {
  const name = process.platform === 'win32' ? 'jaris-tunnel.exe' : 'jaris-tunnel'
  return app.isPackaged ? join(process.resourcesPath, 'bin', name) : join(__dirname, '../../tunnel/dist', name)
}

function getPhoneAccess(): PhoneAccessManager {
  if (phoneAccess) return phoneAccess
  // Dossier « tailscale » laissé à moitié créé par la v0.22.0 (journaux seulement : la connexion n'avait jamais
  // abouti). Rien d'autre que Jaris n'écrit sous ce nom dans son propre dossier.
  void rm(join(app.getPath('userData'), 'tailscale'), { recursive: true, force: true }).catch(() => {})
  const manager = new PhoneAccessManager({
    tunnelBinary: tunnelBinaryPath(),
    // L'identité Tailscale de ce PC vit avec les autres données (getDataRoot) et suit donc un « Déplacer ». Elle
    // était rangée dans le dossier de Chromium, qui change de place à chaque déplacement et dont l'ancien exemplaire
    // est effacé : la perdre obligeait à se reconnecter à Tailscale. Une identité encore à l'ancien endroit est
    // rapatriée au démarrage (storageRoot.ts). Nom du dossier : voir PHONE_TUNNEL_DIR (jamais « tailscale »).
    tunnelStateDir: join(getDataRoot(), PHONE_TUNNEL_DIR),
    devicesFile: join(getDataRoot(), 'phone-devices.json'),
    pageDir: join(resourcesRoot(), 'phone'),
    actions: {
      history: () => chatSession.getVisibleMessages(),
      transcribe: (wav) => transcribeWav(wav),
      // Même conversation que le Chat (et que la voix) : ce qui est dit depuis le téléphone se retrouve sur le
      // PC, et inversement. Seuls les outils sans risque existent pour ce tour (PHONE_RESTRICTIONS).
      sendMessage: async (text, onStatus, mode) => {
        const message = await chatSession.send(
          text,
          fireReminder,
          (line) => {
            broadcast(IPC_CHANNELS.log, line)
            const status = phoneStatusFromLog(line)
            if (status) onStatus(status)
          },
          undefined,
          undefined,
          undefined,
          PHONE_RESTRICTIONS,
          mode
        )
        broadcast(IPC_CHANNELS.chatHistoryChanged)
        return { reply: message.content, ...(message.image ? { image: message.image } : {}) }
      },
      // Onglet Vocal : la même voix que sur le PC (Options → Voix), synthétisée ici puis jouée sur le téléphone.
      speak: (text) => synthesizeSpeech(text),
      // Le téléphone ne télécharge rien : seules les choses DÉJÀ installées sur le PC lui sont proposées.
      studio: async () => {
        const [image, video] = await Promise.all([getImageStudioStatus(), getVideoStudioStatus()])
        const imageReason = !image.supported
          ? t('phone.studio.imageWindowsOnly')
          : !image.capable
            ? image.reason
            : !image.installed
              ? t('phone.studio.imageMissing')
              : null
        const qualities = video.qualities.filter((q) => q.installed).map(({ id, label }) => ({ id, label }))
        const videoReason = !video.supported
          ? t('phone.studio.videoWindowsOnly')
          : !video.capable
            ? video.reason
            : !qualities.length
              ? t('phone.studio.videoMissing')
              : null
        return {
          image: { ready: imageReason === null, reason: imageReason },
          video: { ready: videoReason === null, reason: videoReason, qualities, durations: [...VIDEO_DURATIONS] }
        }
      },
      generateImage: async (prompt, onStatus, signal) => {
        // Nouvelle demande : la mémoire automatique ne doit pas occuper Ollama (ni la carte graphique) devant le dessin.
        cancelMemoryExtraction()
        const image = await generateImage(prompt, onStatus, signal, toEnglishPrompt)
        broadcast(IPC_CHANNELS.studioGalleryChanged)
        return { fileName: image.fileName }
      },
      generateVideo: async (prompt, seconds, quality, onStatus, signal) => {
        cancelMemoryExtraction()
        const video = await generateVideo(
          prompt,
          onStatus,
          signal,
          undefined,
          normalizeVideoSeconds(seconds),
          isVideoQuality(quality) ? quality : 'q6',
          toEnglishPrompt
        )
        broadcast(IPC_CHANNELS.studioGalleryChanged)
        return { fileName: video.fileName }
      },
      listImages: () => listGeneratedImages(),
      listVideos: () => listGeneratedVideos(),
      // generatedImagePath/generatedVideoPath revérifient le nom : jamais un chemin venu du téléphone.
      readImage: (fileName) => readFile(generatedImagePath(fileName)),
      readImageThumbnail: async (fileName) => {
        const image = nativeImage.createFromPath(generatedImagePath(fileName))
        if (image.isEmpty()) throw new Error('Image illisible.')
        return image.resize({ width: 360, quality: 'good' }).toJPEG(78)
      },
      readVideo: (fileName) => readGeneratedVideo(fileName),
      // Même réglage que le sélecteur du PC : changé d'un côté, il l'est aussi de l'autre.
      getModelChoice: (mode) => readModelChoice(mode),
      setModelChoice: async (mode, model) => {
        await saveModelChoice(mode, model)
        broadcast(IPC_CHANNELS.modelChoiceChanged)
      },
      setThinkChoice: async (mode, think) => {
        await saveThinkChoice(mode, think)
        broadcast(IPC_CHANNELS.modelChoiceChanged)
      },
      // Étape 218 : extinction demandée par le bouton du téléphone (jamais par la conversation), annulable.
      shutdown: async (seconds) => {
        await scheduleShutdown(seconds)
        broadcast(IPC_CHANNELS.log, t('phone.shutdownRequested', { seconds }))
      },
      cancelShutdown: async () => {
        await cancelScheduledShutdown()
        broadcast(IPC_CHANNELS.log, t('phone.shutdownCancelled'))
      }
    }
  })
  manager.on('change', (status: PhoneAccessStatus) => {
    broadcast(IPC_CHANNELS.phoneAccessChanged, status)
    if (status.state === 'ready' || status.state === 'error' || status.state === 'off') phoneLinksAutoOpen = false
    if (phoneLinksAutoOpen && status.actionUrl && !openedPhoneLinks.has(status.actionUrl)) {
      openedPhoneLinks.add(status.actionUrl)
      void shell.openExternal(status.actionUrl)
    }
  })
  phoneAccess = manager
  return manager
}

/**
 * Un rappel qui sonne (étape 234, bêta). Jusqu'ici il n'était QUE dit à voix haute : voix pas installée, son
 * coupé ou personne devant les haut-parleurs, et il disparaissait sans laisser de trace. Il s'affiche donc
 * aussi en notification Windows, puis il est annoncé à la voix si elle marche.
 */
function fireReminder(message: string): void {
  if (Notification.isSupported()) new Notification({ title: t('reminder.title'), body: message }).show()
  broadcast(IPC_CHANNELS.log, t('reminder.spoken', { message }))
  void pipeline?.announceReminder(message)
}

/** Après le démarrage d'Ollama par Jaris (déjà jusqu'à 20 s d'attente), le temps de confirmer qu'il répond. */
const STARTUP_ENGINE_CONFIRM_MS = 10_000

/**
 * Étape 294 — charge le modèle de conversation pendant l'écran de démarrage : celui choisi à la main pour la voix, sinon
 * le palier rapide (celui des phrases courtes, et de la correction de ce qui est entendu). Même fenêtre de contexte que
 * les vraies demandes, sinon Ollama le rechargerait à la première question (`needsReload`, server/sched.go).
 */
async function warmUpConversationModel(): Promise<boolean> {
  const profile = await getProfile()
  // Étape 355 : les modèles de la voix quand les duels « Vocal » en ont choisi d'autres que ceux du Chat.
  const model = profile?.modelChoices?.voice || (profile?.voiceModels ?? profile?.models)?.flash
  if (!model) return false
  return preloadModel(model, profile?.contextLength ?? config.ollama.numCtx)
}

async function startVoicePipeline(): Promise<void> {
  const log = (message: string): void => broadcast(IPC_CHANNELS.log, message)
  // Étape 143 : range dans le dossier de Jaris ce qui n'y est pas encore, avant de démarrer Ollama et la voix
  // (leurs fichiers seraient sinon ouverts, donc impossibles à déplacer).
  await reconcileStorage(log, stopOllamaCompletely)
  // Étape 254 : une variable OLLAMA_MODELS qui désigne un autre dossier rend tous les modèles invisibles.
  // Étape 289 : de même qu'un chemin qui passe par une jonction (Ollama 0.40+ ne relit plus rien à travers).
  // Étape 336 : seulement pour l'Ollama de Windows. Celui de Jaris reçoit directement le vrai chemin des modèles,
  // il n'y a rien à corriger dans les réglages de Windows (ni d'Ollama de Windows à arrêter pour ça).
  if (!(await isOllamaInstalled())) await alignOllamaModelsVariable(log, stopOllamaCompletely)
  // Puis le RÉSULTAT est vérifié : l'appli Ollama peut avoir lancé le serveur avec son propre réglage d'emplacement.
  const repairModelsView = (): Promise<boolean> =>
    repairOllamaModelsView(log, {
      ...windowsModelsViewDeps,
      modelsDir: () => (usesEmbeddedOllama() ? engineModelsDir() : windowsModelsViewDeps.modelsDir()),
      serverModelCount: () => listInstalledModels().then((models) => models.length, () => null),
      restartOllama: () => restartOllama(log)
    })
  setModelsViewRepair(repairModelsView)
  const ollamaStarted = ensureOllamaRunning(log).then(repairModelsView)
  // Étape 294 : au premier démarrage seulement, l'écran d'accueil attend le moteur, puis le modèle de conversation
  // préchargé (sa première réponse n'attend plus son chargement).
  if (!startupEngineTracked) {
    startupEngineTracked = true
    const engineUp = ollamaStarted.then(
      () => waitForOllama(STARTUP_ENGINE_CONFIRM_MS),
      () => false
    )
    startup.track('engine', engineUp)
    startup.track('brain', engineUp.then((up) => up && warmUpConversationModel()))
  }

  // Étape 328 : deux redémarrages rapprochés (micro changé deux fois de suite) créaient chacun leur moteur vocal,
  // et le premier n'était jamais arrêté — deux moteurs, deux micros ouverts. Celui qu'on remplace s'arrête ici.
  pipeline?.stop()
  const current = new VoicePipeline()
  pipeline = current
  // Étape 328 : un moteur relancé depuis Options (micro, mot d'activation) écoutait de nouveau alors qu'on n'est
  // pas en mode vocal. L'état de pause est posé avant son démarrage : il le transmet au moteur dès son lancement.
  applyListeningForActiveMode()
  pipeline.on('emotion', (emotion: JarisEmotion) => {
    // Retenu même quand le widget est caché : si Léo réduit la fenêtre de réglages pendant que Jaris écoute,
    // showWidgetWindow doit pouvoir l'afficher directement à la bonne taille (voir lastEmotion).
    lastEmotion = emotion
    // Étape 68 : le widget se déplie pendant l'écoute/réflexion/réponse et se replie dès le retour au repos
    // ('idle') — seulement s'il est vraiment affiché (jamais en plein onboarding/fenêtre de réglages ouverte,
    // où widgetWindow existe déjà en mémoire mais reste caché).
    // Jamais quand le widget affiche sa barre de texte (mode Chat) : il n'écoute pas, donc une émotion du
    // pipeline vocal n'a aucune raison d'y changer quoi que ce soit — et le déplier "pour une réponse
    // vocale" par-dessus une barre de saisie rejouerait exactement la contradiction taille/contenu déjà
    // corrigée une fois ici.
    if (
      currentWidgetMode() === 'voice' && onboardingDone && !fullWindow?.isVisible() &&
      (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) && emotion !== 'idle'
    ) {
      // Couvre aussi le mot d'activation « Jaris » : il doit ouvrir la barre de la même façon que +.
      showWidgetWindow(true)
    } else if (
      currentWidgetMode() === 'voice' &&
      widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()
    ) {
      // Comme avant : l'activité déplie le widget vocal, puis idle le ramène à son petit état permanent.
      positionWidgetWindow(widgetWindow, emotion !== 'idle', true)
    }
    broadcast(IPC_CHANNELS.emotion, emotion)
  })
  pipeline.on('reminder', fireReminder)
  pipeline.on('transcript', (text: string) => broadcast(IPC_CHANNELS.transcript, text))
  pipeline.on('activity', (text: string | null) => broadcast(IPC_CHANNELS.voiceActivity, text))
  pipeline.on('reply', (payload: VoiceReplyPayload) => broadcast(IPC_CHANNELS.reply, payload))
  // Étape 346 : ce qui est dit à voix haute apparaît aussi dans le Chat, sans attendre un changement de fenêtre.
  pipeline.on('exchange', ({ transcript, reply }: { transcript: string; reply: string }) => {
    void chatSession.addSpokenExchange(transcript, reply).then(() => broadcast(IPC_CHANNELS.chatHistoryChanged))
  })
  pipeline.on('log', (message: string) => broadcast(IPC_CHANNELS.log, message))
  pipeline.on('soundCue', (cue: SoundCue) => broadcast(IPC_CHANNELS.soundCue, cue))
  // Étape 173 : une image dessinée à la voix s'ouvre dans la visionneuse de Windows (pas de Chat à l'écran).
  pipeline.on('image', (path: string) => void shell.openPath(path))
  pipeline.on('micTestLevel', (level: number) => broadcast(IPC_CHANNELS.micTestLevel, { level }))
  pipeline.on('micTestDone', (done: MicTestDonePayload) => broadcast(IPC_CHANNELS.micTestDone, done))
  pipeline.on('wakeTestHeard', (heard: WakeTestHeardPayload) => broadcast(IPC_CHANNELS.wakeTestHeard, heard))
  // Étape 325 : la raison affichée près de « Parler à Jaris » suit l'état réel de l'écoute, et s'efface quand elle est prête.
  pipeline.on('listeningStatus', (reason: string | null) =>
    broadcast(IPC_CHANNELS.wakeAvailability, { reason, attempt: false } satisfies WakeAvailabilityPayload)
  )
  // Étape 346 : le programme d'écoute s'est arrêté tout seul après avoir marché — relancé, au plus une fois par minute
  // (un plantage qui se répète ne doit pas relancer en boucle ; la raison reste alors affichée près de « Parler »).
  pipeline.on('crashed', () => {
    if (pipeline !== current || quitting || Date.now() - lastVoiceRestartAt < VOICE_RESTART_MIN_INTERVAL_MS) return
    lastVoiceRestartAt = Date.now()
    broadcast(IPC_CHANNELS.log, t('voice.restarting'))
    current.stop()
    void startVoicePipeline()
  })
  // Arrêt d'urgence déclenché par la sécurité thermique GPU (voicePipeline/resourceMonitor) : un vrai
  // app.quit() (pas juste cacher la fenêtre, voir `quitting` plus haut), pour protéger la machine.
  pipeline.on('shutdown', () => {
    console.log('[jaris] Arrêt automatique : GPU en surchauffe.')
    quitting = true
    app.quit()
  })

  try {
    const profile = await getProfile()
    await current.start(profile?.audioInputDeviceIndex, profile?.activationWakeWordEnabled !== false, profile?.audioInputDeviceName)
    // Remplacé pendant son démarrage : c'est le suivant qui dira si l'écoute est prête.
    if (pipeline !== current) return
    lastSetupStatus = { ready: true, missing: [] }
    broadcast(IPC_CHANNELS.setupStatus, lastSetupStatus)
  } catch (err) {
    if (pipeline !== current) return
    const message = err instanceof Error ? err.message : String(err)
    broadcast(IPC_CHANNELS.log, t('voice.pipelineFailed', { message }))
    lastSetupStatus = { ready: false, missing: [message] }
    broadcast(IPC_CHANNELS.setupStatus, lastSetupStatus)
  }
}

/**
 * Raccourci global (pas seulement quand la fenêtre de Jaris a le focus) : déclenche l'écoute depuis
 * n'importe quelle appli, comme le mot d'activation (déjà global car basé sur le micro).
 * Diagnostic explicite à chaque étape (succès/échec d'enregistrement, puis déclenchement réel) : sinon
 * impossible de distinguer "le raccourci ne s'enregistre pas" de "il s'enregistre mais rien ne se passe
 * au moment d'appuyer" (ex: pipeline vocal pas encore prêt) juste en testant à l'aveugle.
 *
 * globalShortcut.register() peut carrément lever une exception (pas juste renvoyer false) pour un
 * accelerator qu'il n'arrive pas à convertir en code touche natif — c'est le cas du caractère "+" tout
 * seul sur cette machine ("conversion failure from +"), ce qui plantait le démarrage entier de Jaris
 * (exception non rattrapée dans app.whenReady().then(...)). D'où le try/catch : un raccourci qui échoue
 * à s'enregistrer ne doit jamais empêcher Jaris de démarrer. "numadd", la touche + du pavé numérique, est un
 * code touche distinct et stable (pas d'ambiguïté d'agencement clavier).
 *
 * Étape 328 : une fois réservée, la touche est retirée à TOUTES les autres applications — même « touche + »
 * décochée dans Options, on ne pouvait plus taper + au pavé numérique dans Excel ou la Calculatrice, ni dans le
 * Chat de Jaris (la touche n'arrivait jamais au champ de saisie). Elle n'est donc réservée que si elle est
 * activée, et rendue tant qu'une fenêtre de Jaris a le focus : là, c'est l'écran qui gère + (App.tsx), et
 * il laisse écrire + dans un champ de saisie.
 */
const WAKE_SHORTCUT = 'numadd'
/**
 * Étape 346 : un portable n'a souvent PAS de pavé numérique — la petite barre du Chat (et l'écoute) ne pouvait alors
 * s'ouvrir que par la voix. Ctrl+Alt+J (J comme Jaris) existe sur tous les claviers et ne sert à rien sous Windows ;
 * mêmes règles que « + » : réglage d'Options, et rendue tant qu'une fenêtre de Jaris a le focus.
 */
const WAKE_SHORTCUTS = [WAKE_SHORTCUT, 'Control+Alt+J']
let wakeShortcutWanted = false
const registeredWakeShortcuts = new Set<string>()

function onWakeShortcut(accelerator: string): void {
  console.log(`[jaris] Raccourci global ${accelerator} déclenché (pipeline ${pipeline ? 'prêt' : 'PAS prêt'}).`)
  // Relu à chaque pression : un réglage changé ailleurs ne doit jamais laisser la touche active.
  void getProfile()
    .catch(() => null)
    .then((profile) => {
      if (profile?.activationKeyEnabled === false) return
      triggerVisibleWake()
    })
}

function syncWakeShortcut(): void {
  const wanted = wakeShortcutWanted && BrowserWindow.getFocusedWindow() === null
  for (const accelerator of WAKE_SHORTCUTS) {
    if (wanted === registeredWakeShortcuts.has(accelerator)) continue
    if (!wanted) {
      globalShortcut.unregister(accelerator)
      registeredWakeShortcuts.delete(accelerator)
      continue
    }
    try {
      if (globalShortcut.register(accelerator, () => onWakeShortcut(accelerator))) registeredWakeShortcuts.add(accelerator)
      else {
        console.warn(
          `[jaris] Impossible de réserver le raccourci global ${accelerator} (déjà pris par une autre appli, ou par une ancienne instance de Jaris encore ouverte en arrière-plan).`
        )
      }
    } catch (err) {
      console.warn(`[jaris] Raccourci global ${accelerator} invalide sur ce clavier : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Options → Voix, « touche + » : relu au démarrage et à chaque enregistrement du profil. */
function setWakeShortcutWanted(wanted: boolean): void {
  wakeShortcutWanted = wanted
  syncWakeShortcut()
}

// Un peu après l'évènement : pendant la perte de focus, Windows peut encore dire la fenêtre active, et passer d'une
// fenêtre de Jaris à l'autre envoie une perte puis un gain de focus. On relit l'état une fois qu'il est stable.
const syncWakeShortcutSoon = (): void => void setTimeout(syncWakeShortcut, 100)
app.on('browser-window-focus', syncWakeShortcutSoon)
app.on('browser-window-blur', syncWakeShortcutSoon)

// Étape 328 : chaque fenêtre de Jaris garde sa propre page. Un fichier glissé dessus par erreur remplaçait toute
// l'interface ; un lien ouvert depuis une page partait au système quel que soit son protocole (file:, programme…).
// Ici pour TOUTES les fenêtres (principale, widget, démarrage), y compris celles créées plus tard.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Étape 337 : les pages de recherche cachées (webSearch.ts) suivent leurs propres règles, restreintes au moteur.
    if (isSearchContents(contents.id)) return
    if (isSameDocument(url, contents.getURL())) return
    event.preventDefault()
    if (isWebUrl(url)) void shell.openExternal(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    // Une page de recherche cachée n'ouvre jamais rien dans le navigateur de Windows (fenêtre surgissante, publicité).
    if (!isSearchContents(contents.id) && isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(async () => {
  // `app.quit()` (voir tout en haut du fichier) n'interrompt pas forcément la suite du script de façon
  // synchrone : `ready` peut malgré tout finir par se déclencher pour l'instance perdante avant que la
  // sortie demandée ne soit vraiment effective (constaté en usage réel : plusieurs fenêtres Jaris qui
  // s'ouvrent puis se referment aussitôt en rafale au lancement). Sans ce garde-fou, une instance qui a
  // déjà perdu la course au verrou continuerait quand même à créer sa fenêtre, démarrer Ollama, etc. avant
  // de se fermer — exactement le flash visible à corriger ici.
  if (!gotSingleInstanceLock) return
  // La langue AVANT toute fenêtre, tout menu et tout message : chaque écran naît directement dans la bonne langue.
  await loadLanguageSetting()
  ipcMain.on(IPC_CHANNELS.languageState, (event) => {
    event.returnValue = languageState()
  })
  ipcMain.handle(IPC_CHANNELS.setLanguage, async (_event, next: LanguageSetting) => {
    const state = await saveLanguageSetting(next)
    broadcast(IPC_CHANNELS.languageChanged, state)
    refreshTrayMenu()
    return state
  })
  setPilotWindowHooks({ begin: setJarisAsideForPilot, end: bringJarisBackAfterPilot, guard: setPilotBorrowGuard })
  void cleanupStaleChromiumData()
  // Étape 200 : le Montage a été retiré ; son paquet Remotion (environ 600 Mo) ne sert plus à rien.
  void removeLeftoverMontage()
  // Étape 206 : les fichiers du Wan 2.2 de base, remplacé par FastWan, ne servent plus (jusqu'à ~15 Go).
  void removeObsoleteVideoFiles().catch(() => {})
  // Étape 258 : le duel vidéo est retiré ; son Python et Kandinsky (~31 Go) ne servent plus, ses vidéos restent.
  void removeLeftoverVideoDuel(join(imageEngineRoot(), 'video-duel'))
  // Étape 337 : la recherche web passe par DuckDuckGo ; le conteneur SearXNG et son image ne servent plus.
  void removeLeftoverSearxng(getDataRoot())
  // Étape 353 : le test Terminal-Bench est retiré ; Harbor, ses tâches et les images Docker de ses tâches ne servent
  // plus. Ses résultats restent.
  void removeLeftoverTerminalBench(getDataRoot()).catch(() => {})
  registerPreviewHandler()

  // Accorde sans demander le micro (noms des périphériques, Options → Voix) et le plein écran (lecteur vidéo) ;
  // refuse tout le reste. Détail et raisons : services/permissions.ts.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionAllowed(permission))
  })

  // Un seul check par lancement (comme checkOllamaFreshness) : la version installée ne change pas pendant
  // que Jaris tourne, pas la peine de refaire l'appel réseau à chaque ouverture d'un onglet Options.
  void checkAppFreshness()

  ipcMain.handle(IPC_CHANNELS.setupStatus, () => lastSetupStatus)
  ipcMain.handle(IPC_CHANNELS.getStartupState, () => startup.state())
  startup.on('change', (state) => broadcast(IPC_CHANNELS.startupState, state))
  ipcMain.on(IPC_CHANNELS.triggerWake, () => triggerVisibleWake())
  ipcMain.on(IPC_CHANNELS.audioEnded, () => pipeline?.notifyAudioEnded())
  ipcMain.handle(IPC_CHANNELS.getProfile, () => getProfile())
  ipcMain.handle(IPC_CHANNELS.saveProfile, async (_event, profile: Profile) => {
    await saveProfile(profile)
    setWakeShortcutWanted(profile.activationKeyEnabled !== false)
  })
  ipcMain.handle(IPC_CHANNELS.patchProfile, async (_event, change: Partial<Profile>): Promise<Profile | null> => {
    const updated = await patchProfile(change)
    if (updated) setWakeShortcutWanted(updated.activationKeyEnabled !== false)
    return updated
  })
  ipcMain.handle(IPC_CHANNELS.openMemoryFolder, async () => {
    await ensureMemoryDir()
    await shell.openPath(getMemoryDir())
  })
  ipcMain.handle(IPC_CHANNELS.getMemoryGraph, () => buildMemoryGraphWithUser())
  ipcMain.handle(IPC_CHANNELS.getMemoryNoteContent, (_event, title: string) => readNoteForDisplay(title))
  // Limite large plutôt que sans limite : le fichier lui-même est déjà borné (MAX_HISTORY_ENTRIES dans
  // conversationStore.ts), une vraie limite ici n'aurait de sens que si l'onglet Historique devait un jour
  // paginer.
  // Onglet Historique : TOUTES les conversations mélangées (étape 96) — c'est le journal de tout ce qui a
  // été dit, voix comprise, pas la vue du fil en cours (celui-là s'affiche dans le Chat).
  ipcMain.handle(IPC_CHANNELS.getConversationHistory, () => getAllConversationEntries(300))

  // Conversations du Chat (étape 96). Chaque changement de fil remet à zéro le fil affiché ET le contexte
  // court terme envoyé au modèle, côté chat comme côté voix : les deux écrivent dans la conversation
  // ACTIVE, donc les deux doivent oublier celle qu'on vient de quitter.
  const switchConversation = async (): Promise<ConversationList> => {
    chatSession.reset()
    pipeline?.clearHistory()
    return listConversations()
  }
  ipcMain.handle(IPC_CHANNELS.listConversations, () => listConversations())
  ipcMain.handle(IPC_CHANNELS.createConversation, async () => {
    await createConversation()
    return switchConversation()
  })
  ipcMain.handle(IPC_CHANNELS.selectConversation, async (_event, id: string) => {
    await setActiveConversation(id)
    return switchConversation()
  })
  ipcMain.handle(IPC_CHANNELS.deleteConversation, async (_event, id: string) => {
    // Un échange de cette conversation encore en attente de la mémoire automatique ne doit pas être retenu après —
    // mais ceux des AUTRES conversations restent (étape 328).
    clearPendingMemoryExchanges(id)
    await deleteConversation(id)
    return switchConversation()
  })
  ipcMain.handle(IPC_CHANNELS.clearConversationHistory, async () => {
    // Rien de ce qui vient d'être effacé ne doit finir dans la mémoire automatique (échanges encore en attente).
    clearPendingMemoryExchanges()
    await clearConversationHistory()
    pipeline?.clearHistory()
    // Le mode Chat (étape 30) alimente le même historique et le même contexte court terme : le laisser
    // intact ici laisserait Jaris se souvenir par écrit de ce qui vient d'être effacé.
    chatSession.clear()
  })
  ipcMain.handle(IPC_CHANNELS.openConversationHistoryFile, async () => {
    await ensureConversationHistoryFile()
    shell.showItemInFolder(getConversationHistoryPath())
  })
  ipcMain.handle(IPC_CHANNELS.openRequestJournal, async (_event, reveal: boolean) => {
    // Le fichier n'existe qu'après une première demande : on le crée vide pour que le bouton ouvre toujours quelque chose.
    await appendJournal([])
    if (reveal) shell.showItemInFolder(getJournalPath())
    else await shell.openPath(getJournalPath())
  })
  ipcMain.handle(IPC_CHANNELS.previewVoice, async (_event, voice: string) => {
    const audio = await previewVoice(voice)
    return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
  })
  ipcMain.handle(IPC_CHANNELS.listAudioInputDevices, (): Promise<AudioInputDevice[]> => listAudioInputDevices())
  // Change le micro utilisé : sauvegardé dans le profil puis le pipeline vocal est redémarré avec le nouvel
  // index (le sidecar Python ouvre son micro une seule fois au démarrage, voir voice_server.py — pas moyen
  // de changer de micro sans relancer tout le pipeline, y compris le rechargement des modèles).
  ipcMain.handle(IPC_CHANNELS.setAudioInputDevice, async (_event, deviceIndex: number | null): Promise<void> => {
    const profile = await getProfile()
    if (!profile) return
    // Étape 346 : le nom est gardé avec le numéro — c'est lui qui retrouve le micro quand la liste change.
    const devices = deviceIndex === null ? [] : await listAudioInputDevices().catch(() => [] as AudioInputDevice[])
    const deviceName = devices.find((device) => device.index === deviceIndex)?.name ?? null
    await saveProfile({ ...profile, audioInputDeviceIndex: deviceIndex, audioInputDeviceName: deviceName })
    pipeline?.stop()
    await startVoicePipeline()
  })
  // Options → Activation (étape 81) : redémarre le pipeline vocal comme setAudioInputDevice ci-dessus, pour
  // la même raison (le sidecar Python décide de charger ou non le détecteur ONNX une seule fois, à son
  // démarrage). Les deux autres bascules d'Activation (touche "+", clic sur l'orbe) sont de simples champs
  // du profil enregistrés via saveProfile, relus à la volée côté renderer (App.tsx) sans passer par ici.
  ipcMain.handle(IPC_CHANNELS.setWakewordEnabled, async (_event, enabled: boolean): Promise<void> => {
    const profile = await getProfile()
    if (!profile) return
    await saveProfile({ ...profile, activationWakeWordEnabled: enabled })
    pipeline?.stop()
    await startVoicePipeline()
  })
  // Étape 188 : un test envoyé à une écoute qui charge encore (ou arrêtée) ne recevait jamais de réponse et
  // l'écran restait muet, comme si le micro n'entendait rien. La raison revient maintenant à l'écran.
  const voiceTestStart = (reason: string | null): VoiceTestStartResult => ({ started: reason === null, reason })
  ipcMain.handle(IPC_CHANNELS.testMicrophone, (): VoiceTestStartResult =>
    voiceTestStart(pipeline ? pipeline.testMic() : t('main.voiceNotReady'))
  )
  ipcMain.on(IPC_CHANNELS.stopTestMicrophone, () => pipeline?.stopTestMic())
  ipcMain.handle(IPC_CHANNELS.testWakeWord, (): VoiceTestStartResult =>
    voiceTestStart(pipeline ? pipeline.testWakeWord() : t('main.voiceNotReady'))
  )
  ipcMain.on(IPC_CHANNELS.stopTestWakeWord, () => pipeline?.stopTestWakeWord())
  ipcMain.on(IPC_CHANNELS.setActiveMode, (_event, mode: AppMode) => {
    activeMode = mode
    applyListeningForActiveMode()
  })

  // Étape 355 — le Duel. Ce qui vient de l'écran est revérifié ici (catégorie, issue du vote, taille de session).
  setDuelEnvironment({
    onReminderFire: fireReminder,
    emit: (view) => broadcast(IPC_CHANNELS.duelChanged, view)
  })
  void loadDuelVotes()
  const duelCategory = (value: unknown): DuelCategory => {
    if (!isDuelCategory(value)) throw new Error(t('duel.error.badRequest'))
    return value
  }
  ipcMain.handle(IPC_CHANNELS.duelPlan, (_event, category: unknown) => planDuel(duelCategory(category)))
  ipcMain.handle(IPC_CHANNELS.duelStart, (_event, category: unknown, pick: unknown) => {
    // Un nombre (modèles au hasard) ou, étape 363, la liste des modèles choisis à la main — revérifiée par startDuel.
    if (Array.isArray(pick)) {
      if (pick.length > 200 || !pick.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 200)) {
        throw new Error(t('duel.error.badRequest'))
      }
      return startDuel(duelCategory(category), pick as string[])
    }
    if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 2 || pick > 6) throw new Error(t('duel.error.badRequest'))
    return startDuel(duelCategory(category), pick)
  })
  ipcMain.handle(IPC_CHANNELS.duelAsk, (_event, prompt: unknown) => {
    if (typeof prompt !== 'string' || prompt.length > 20_000) throw new Error(t('duel.error.badRequest'))
    // Comme toute nouvelle demande (étape 324) : la mémoire automatique ne doit pas occuper Ollama pendant le tour d'un
    // modèle — elle le ralentirait, et seulement lui, au détriment de la comparaison.
    cancelMemoryExtraction()
    return askDuel(prompt)
  })
  ipcMain.handle(IPC_CHANNELS.duelRunB, () => {
    cancelMemoryExtraction()
    return runDuelB()
  })
  ipcMain.handle(IPC_CHANNELS.duelStop, () => stopDuelRun())
  ipcMain.handle(IPC_CHANNELS.duelVote, (_event, outcome: unknown) => {
    if (!isDuelOutcome(outcome)) throw new Error(t('duel.error.badRequest'))
    return voteDuel(outcome)
  })
  ipcMain.handle(IPC_CHANNELS.duelEnd, () => endDuel())
  ipcMain.handle(IPC_CHANNELS.duelClose, () => closeDuel())
  ipcMain.handle(IPC_CHANNELS.duelState, () => getDuelView())
  ipcMain.handle(IPC_CHANNELS.duelAudio, (_event, side: unknown) => (side === 'a' || side === 'b' ? duelAudio(side) : null))
  ipcMain.handle(IPC_CHANNELS.duelDeleteModels, (_event, models: unknown) => {
    if (!Array.isArray(models) || !models.every((m) => typeof m === 'string')) throw new Error(t('duel.error.badRequest'))
    return deleteDuelModels(models)
  })
  ipcMain.handle(IPC_CHANNELS.duelRankings, () => duelRankings())
  ipcMain.handle(IPC_CHANNELS.duelHistory, () => duelHistory())
  // Étape 362 : « Télécharger les votes ». Même garde dialogOpen que les autres « Enregistrer sous » (étape 93).
  ipcMain.handle(IPC_CHANNELS.duelExportVotes, async (): Promise<DuelExportResult> => {
    const now = new Date()
    const dialogOptions = {
      title: t('main.dialog.saveVotes'),
      defaultPath: join(app.getPath('documents'), defaultDuelExportName(now)),
      filters: [{ name: t('main.dialog.votesFilter'), extensions: ['json'] }]
    }
    dialogOpen = true
    let target: string | undefined
    try {
      const result = fullWindow ? await dialog.showSaveDialog(fullWindow, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      target = result.canceled ? undefined : result.filePath
    } finally {
      dialogOpen = false
    }
    if (!target) return { saved: false }
    try {
      const { json, count } = await buildDuelVotesExport(app.getVersion(), now)
      await writeFile(/\.json$/i.test(target) ? target : `${target}.json`, json, 'utf8')
      return { saved: true, count }
    } catch (err) {
      return { saved: false, error: t('main.saveVotesFailed', { error: err instanceof Error ? err.message : String(err) }) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.duelHistoryApp, (_event, voteId: unknown, side: unknown) => {
    if (typeof voteId !== 'string' || (side !== 'a' && side !== 'b')) throw new Error(t('duel.error.badRequest'))
    return duelHistoryApp(voteId, side)
  })
  ipcMain.handle(IPC_CHANNELS.duelHistoryCode, (_event, voteId: unknown, side: unknown) => {
    if (typeof voteId !== 'string' || (side !== 'a' && side !== 'b')) throw new Error(t('duel.error.badRequest'))
    return duelHistoryCode(voteId, side)
  })
  ipcMain.handle(IPC_CHANNELS.duelSideCode, (_event, side: unknown) => {
    if (side !== 'a' && side !== 'b') throw new Error(t('duel.error.badRequest'))
    return duelSideCode(side)
  })
  ipcMain.handle(IPC_CHANNELS.duelRetry, () => {
    cancelMemoryExtraction()
    return retryDuel()
  })
  ipcMain.handle(IPC_CHANNELS.duelSkip, () => skipDuel())
  ipcMain.handle(IPC_CHANNELS.duelNext, () => nextDuel())
  ipcMain.handle(IPC_CHANNELS.getWidgetMode, (): WidgetMode => displayedWidgetMode)
  ipcMain.on(IPC_CHANNELS.setChatWidgetHeight, (_event, height: number | null) => {
    chatWidgetHeight = height
    if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return
    if (displayedWidgetMode !== 'chat') return
    // Pas d'animation différée ici (contrairement au repli du widget vocal, qui attend son fondu) : la
    // barre revient d'un coup, et un repli différé laisserait la grande zone de capture des clics active
    // plusieurs centaines de millisecondes de plus par-dessus ce que l'utilisateur essaie justement de
    // cliquer en fermant le widget.
    positionWidgetWindow(widgetWindow, true)
  })
  ipcMain.on(IPC_CHANNELS.setChatWidgetKeepOpen, (_event, keepOpen: boolean) => {
    chatWidgetKeepOpen = keepOpen
  })
  ipcMain.on(IPC_CHANNELS.armChatWidgetPointer, () => {
    if (displayedWidgetMode === 'chat') chatPointerWasInside = true
  })
  ipcMain.on(IPC_CHANNELS.collapseChatWidget, () => collapseChatWidget())
  ipcMain.handle(IPC_CHANNELS.getLaunchAtStartup, () => getLaunchAtStartup(app, process.platform))
  ipcMain.handle(IPC_CHANNELS.setLaunchAtStartup, (_event, enabled: boolean) =>
    setLaunchAtStartup(app, process.platform, enabled)
  )
  ipcMain.on(IPC_CHANNELS.setOptionsOpen, (_event, open: boolean) => {
    optionsOpen = open
    applyListeningForActiveMode()
  })
  ipcMain.handle(IPC_CHANNELS.getWindowChrome, () => windowChrome())
  // Thème clair/sombre changé dans Windows pendant que Jaris tourne : la page suit toute seule
  // (prefers-color-scheme), mais les symboles des boutons de la barre de titre viennent d'ici.
  nativeTheme.on('updated', () => {
    if (!fullWindow || fullWindow.isDestroyed() || process.platform !== 'win32') return
    fullWindow.setTitleBarOverlay(titleBarOverlay())
  })
  ipcMain.handle(IPC_CHANNELS.getModelOverview, async () => getModelOverview(await getProfile()))
  // Étape suivante (Léo : "jaris voit les model et regarde la vram et propose une barre... personnalisé à
  // chacun pour que le dernier ne dépasse pas la vram") : le modèle de référence est celui du palier
  // PUISSANT (le plus gros modèle de conversation configuré, voir computeContextLengthOptions pour le
  // pourquoi), jamais un modèle choisi par le renderer — recalculé à chaque ouverture de l'onglet.
  ipcMain.handle(IPC_CHANNELS.getContextLengthOptions, async () => {
    const profile = await getProfile()
    // Étape 346 : les trois modèles de conversation — la référence est le plus gros qui tourne sur la carte.
    const models = profile?.models
      ? [profile.models.flash, profile.models.medium, profile.models.large, ...Object.values(profile.voiceModels ?? {})]
      : [config.ollama.model]
    const currentContext = profile?.contextLength ?? config.ollama.numCtx
    return computeContextLengthOptions(models, currentContext)
  })
  ipcMain.handle(IPC_CHANNELS.setContextLength, async (_event, contextLength: number | undefined) => {
    const profile = await getProfile()
    if (!profile) return
    await saveProfile({ ...profile, contextLength })
  })
  ipcMain.handle(IPC_CHANNELS.getOllamaVersionStatus, () => getOllamaVersionStatus())
  // Même canal d'avancement que la mise à jour de Jaris, distingué par `target` (étape 112) : le paquet
  // d'Ollama pèse 1,6 Go, soit plusieurs minutes pendant lesquelles le bouton ne doit pas rester muet.
  // Étape 170 : tout nouveau statut d'Ollama rafraîchit la page Options.
  onOllamaVersionStatus((status) => broadcast(IPC_CHANNELS.ollamaVersionStatusChanged, status))
  // Étape 336 : installe l'Ollama de Jaris (ou le met à jour) et bascule dessus sans redémarrer Jaris.
  ipcMain.handle(IPC_CHANNELS.updateOllama, () =>
    updateOllama(
      (progress) => broadcast(IPC_CHANNELS.updateProgress, { target: 'ollama', ...progress }),
      (message) => broadcast(IPC_CHANNELS.log, message)
    )
  )
  ipcMain.handle(IPC_CHANNELS.getAppVersionStatus, () => getAppVersionStatus())
  // `quitting = true` seulement juste avant que updateApp() n'appelle réellement app.quit() (jamais avant, y
  // compris en cas d'échec du téléchargement) : sinon fermer la fenêtre principale plus tard dans la session
  // quitterait Jaris pour de bon au lieu de se replier en widget comme d'habitude.
  ipcMain.handle(IPC_CHANNELS.updateApp, () =>
    updateApp(
      () => {
        quitting = true
      },
      // Avancement du téléchargement (étape 98) : l'installeur pèse ~98 Mo, soit plusieurs minutes sur une
      // connexion modeste — sans ce retour, la fenêtre restait figée sur "Mise à jour en cours…".
      (progress) => broadcast(IPC_CHANNELS.updateProgress, { target: 'jaris', ...progress })
    )
  )
  ipcMain.handle(IPC_CHANNELS.getAppVersion, () => getInstalledVersion())
  ipcMain.handle(IPC_CHANNELS.checkForUpdate, () => checkForUpdate())
  ipcMain.handle(IPC_CHANNELS.getModelsLocationStatus, () => getStorageStatus())
  ipcMain.handle(IPC_CHANNELS.chooseModelsLocation, async () => {
    const dialogOptions = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      title: t('main.dialog.chooseFolder')
    }
    // try/finally : un échec du dialogue laissait sinon `dialogOpen` bloqué à true pour toute la session,
    // et la fenêtre de réglages ne se serait plus JAMAIS repliée en widget en changeant d'application.
    dialogOpen = true
    let result
    try {
      result = fullWindow ? await dialog.showOpenDialog(fullWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    } finally {
      dialogOpen = false
    }
    if (result.canceled || !result.filePaths[0]) return { success: false, message: '' }
    const newDir = result.filePaths[0]

    const log = (message: string): void => broadcast(IPC_CHANNELS.modelsLocationProgress, message)
    // Ollama et les sidecars Python doivent tous les deux libérer leurs fichiers avant de déplacer quoi
    // que ce soit, sinon la copie échoue ou laisse des données à moitié écrites.
    log(t('main.move.stopping'))
    pipeline?.stop()
    ttsClient.stop()
    await stopOllamaCompletely()
    // Même raison pour ce qui écrit dans les données pendant la copie : l'accès téléphone (identité Tailscale,
    // téléphones appairés, messages reçus) et un test de modèles en cours (il reprendra au prochain clic). Attendus
    // jusqu'à leur sortie : sous Windows, un fichier encore ouvert ne s'efface pas de l'ancien dossier.
    await stopModelTest()
    // Étape 355 : un duel en cours s'arrête aussi (les modèles écrivent sur le PC, et un téléchargement remplit le disque).
    abortDuel()
    await phoneAccess?.disable().catch(() => {})

    // Pendant la copie (souvent des dizaines de minutes), le mode Code reste utilisable. Tout ce qu'il écrirait dans
    // l'ancien dossier des données serait perdu — déjà copié ou sur le point de l'être, ce dossier est effacé à la fin :
    // - le jeton GitHub n'est ni renouvelé ni effacé (un jeton de renouvellement ne sert qu'une fois chez GitHub :
    //   renouvelé ici, le nouveau dossier garderait un jeton de renouvellement déjà consommé, donc déconnecté) ;
    // - les conversations du mode Code restent en mémoire, puis partent dans le NOUVEAU dossier à la fin.
    const codeStore = codeConversations()
    setGithubDataMoving(true)
    codeStore.holdWrites()

    // Étape 143, Léo : « ça doit tout déplacer, jamais une partie » — programme, conversations, Ollama,
    // Python, voix : tout ou rien (relocation.ts).
    try {
      const outcome = await relocateEverything(newDir, { onProgress: log })
      // Le jeton GitHub reste en pause jusqu'à la fermeture, qui suit : rien ne doit plus écrire dans l'ancien dossier.
      try {
        codeStore.releaseWrites(join(outcome.dataDir, CODE_CONVERSATIONS_FILE))
      } catch (err) {
        // Gardé en mémoire : réécrit à la fermeture (flush), dans le nouveau dossier.
        console.error('[code] Conversations du mode Code non écrites dans le nouveau dossier :', err)
      }
      quitting = true
      if (outcome.programInstaller) {
        // Le programme lui-même ne peut pas se déplacer pendant qu'il tourne : son installeur le réinstalle
        // dans le nouveau dossier une fois Jaris fermé (et efface l'ancien), puis le relance.
        const installer = outcome.programInstaller
        const commandLine = programMoveCommandLine(outcome.programTarget ?? newDir)
        app.once('will-quit', () => {
          spawn(installer, [commandLine], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
            .on('error', () => {})
            .unref()
        })
        log(t('main.move.reinstalling'))
      } else {
        log(t('main.move.restarting'))
        // Les stores calculent leur chemin UNE fois au chargement du module : il faut relancer Jaris.
        app.relaunch()
      }
      // Laisse la réponse IPC repartir vers l'interface avant de couper : sinon la promesse côté renderer
      // ne se résout jamais et le bouton reste figé sur "Déplacement en cours…" jusqu'à la relance.
      setTimeout(() => app.quit(), 800)
      const notes = outcome.leftovers.length ? [t('main.move.leftovers', { files: outcome.leftovers.join(', ') })] : []
      return { success: true, message: [t('main.move.done', { dir: newDir }), ...notes].join(' ') }
    } catch (err) {
      // Déplacement annulé, l'ancien dossier est intact : tout y repart.
      setGithubDataMoving(false)
      try {
        codeStore.releaseWrites()
      } catch (releaseErr) {
        console.error('[code] Conversations du mode Code non écrites après l’annulation du déplacement :', releaseErr)
      }
      log(t('main.move.restartingServices'))
      void ensureOllamaRunning(log)
      await startVoicePipeline()
      if ((await getProfile())?.phoneAccessEnabled) void getPhoneAccess().enable().catch(() => {})
      return { success: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.getRuntimeSetupStatus, () => getRuntimeSetupStatus())
  // L'installation du premier lancement (Python, Ollama) dure plusieurs minutes : chaque étape est
  // diffusée au fil de l'eau plutôt qu'attendre la fin, pour que l'utilisateur voie que ça avance.
  ipcMain.handle(IPC_CHANNELS.runRuntimeSetup, async () => {
    // Étape 143 : jonctions posées AVANT d'installer Ollama/Python, pour qu'ils s'installent directement dans
    // le dossier de Jaris (installé sur D) au lieu d'arriver sur C.
    await reconcileStorage((message) => {
      broadcast(IPC_CHANNELS.log, message)
      broadcast(IPC_CHANNELS.runtimeSetupProgress, { step: 'ollama', message })
    }, stopOllamaCompletely)
    const status = await runFirstRunSetup((progress) => broadcast(IPC_CHANNELS.runtimeSetupProgress, progress))
    // Le pipeline vocal a déjà tenté de démarrer au lancement de Jaris (voir plus bas), forcément en
    // échec sur une machine où Python n'était pas encore installé. Sans ce redémarrage, la voix resterait
    // morte jusqu'à ce que l'utilisateur pense à quitter et relancer Jaris — alors qu'il vient
    // précisément de regarder Python s'installer.
    if (status.pythonReady) {
      pipeline?.stop()
      await startVoicePipeline()
    }
    return status
  })
  // renderer -> main : modèles candidats apparus depuis le dernier scan (étape 29), pour le popup dans App.tsx.
  // Un profil créé avant cette fonctionnalité (knownModelCandidates jamais défini) est silencieusement
  // initialisé sur l'état actuel plutôt que de signaler tous les candidats existants comme "nouveaux".
  ipcMain.handle(IPC_CHANNELS.getNewModels, async (): Promise<string[]> => {
    const profile = await getProfile()
    if (!profile?.capacityScanDone) return []
    const currentIds = getAllCandidateModelIds()
    if (!profile.knownModelCandidates) {
      await saveProfile({ ...profile, knownModelCandidates: currentIds })
      return []
    }
    const known = new Set(profile.knownModelCandidates)
    const fresh = currentIds.filter((id) => !known.has(id))
    // Étape 251 : MAI-UI remplace UI-TARS. Un PC qui avait UI-TARS l'apprend ici, jusqu'à ce que « Retester la
    // configuration » installe MAI-UI (et supprime UI-TARS) ; d'ici là, le modèle de vision vise lui-même.
    if (profile.pilotModel && profile.pilotModel !== PILOT_MODEL) fresh.push(`${PILOT_MODEL_LABEL} (${t('role.pilot')})`)
    return fresh
  })
  ipcMain.handle(IPC_CHANNELS.acknowledgeNewModels, async (): Promise<void> => {
    const profile = await getProfile()
    if (!profile) return
    await saveProfile({ ...profile, knownModelCandidates: getAllCandidateModelIds() })
  })
  ipcMain.handle(IPC_CHANNELS.getMyModelPicks, async () => {
    const picks = await getMyModelPicks(await getProfile())
    // Étape 174 : le modèle d'image se décide sur le MÊME matériel détecté que les autres rôles.
    const image = pickImageModel(picks.vramGb, picks.ramGb)
    // 04/10/2026, Léo : « ajoute vidéo et le modèle vidéo » — même matériel détecté, meilleure qualité possible ici.
    const video = pickVideoModel(picks.vramGb, picks.ramGb)
    // Étape 231 : le modèle de pilotage d'écran, vérifié auprès d'Ollama (absent = installed inconnu).
    const pilot = pickPilotModel(picks.vramGb)
    let pilotInstalled: boolean | undefined
    if (pilot.model) {
      const name = pilot.model
      pilotInstalled = await listInstalledModels().then((m) => m.includes(name) || m.includes(`${name}:latest`), () => undefined)
    }
    return {
      ...picks,
      pilot: pilot.model ? { ...pilot, installed: pilotInstalled } : pilot,
      image: image.model ? { ...image, installed: await isImageModelInstalled() } : image,
      video: video.quality ? { ...video, installed: await isVideoQualityInstalled(video.quality) } : video
    }
  })
  // Étape 168, remis à l'étape 221 (Léo : « rajoute le bouton analyse pour tester Ling-3.0-tiny ») : test des seuls
  // modèles sans score (voir testUnscoredModels, benchmarkRunner.ts).
  ipcMain.handle(IPC_CHANNELS.getUnscoredModels, () => getModelsToTest())
  ipcMain.handle(IPC_CHANNELS.testUnscoredModels, (event) =>
    testUnscoredModels((line) => event.sender.send(IPC_CHANNELS.modelBenchmarkLine, line))
  )
  ipcMain.handle(IPC_CHANNELS.showUnscoredResults, () => shell.showItemInFolder(unscoredResultsPath()))
  // Étape 140 : le nom vient du renderer, donc revérifié ICI avant toute suppression — un modèle utilisé par
  // un rôle du profil (ou inconnu d'Ollama) n'est jamais supprimé, quoi que demande l'interface.
  ipcMain.handle(IPC_CHANNELS.deleteUnusedModel, async (_event, model: string): Promise<void> => {
    if (typeof model !== 'string' || !(await isUnusedInstalledModel(model, await getProfile()))) {
      throw new Error(t('main.modelInUse'))
    }
    await deleteModel(model)
  })
  // Choix d'un rôle par mode (Chat, Code, Vocal). applyModelChoice vérifie que son modèle actuel est
  // réellement installé dans Ollama avant d'enregistrer ce rôle.
  ipcMain.handle(IPC_CHANNELS.getModelChoice, (_event, mode: ModelChoiceMode): Promise<ModelChoiceInfo> => readModelChoice(mode))
  ipcMain.handle(IPC_CHANNELS.setThinkChoice, (_event, mode: ModelChoiceMode, think: unknown): Promise<void> => saveThinkChoice(mode, think))
  ipcMain.handle(IPC_CHANNELS.setModelChoice, (_event, mode: ModelChoiceMode, model: string | null): Promise<void> => saveModelChoice(mode, model))
  ipcMain.handle(IPC_CHANNELS.runQuickSetup, async (event): Promise<CapacityScanResult> => {
    const onLine = (line: string): void => event.sender.send(IPC_CHANNELS.modelBenchmarkLine, line)
    // Ollama peut s'être arrêté depuis le démarrage de Jaris (ou ne pas avoir encore fini de démarrer) : relancé
    // ici plutôt que de télécharger vers un serveur absent (« fetch failed », Léo sur un autre PC).
    await ensureOllamaRunning(onLine)
    // Étape 346 : la version d'Ollama compte dans le choix (étape 312) — relue AVANT de choisir, jamais devinée.
    await refreshLocalOllamaVersion()
    return runQuickSetup(
      onLine,
      // Barre de progression de l'écran de configuration (octets reçus / taille du modèle).
      (progress) => event.sender.send(IPC_CHANNELS.modelPullProgress, progress)
    )
  })

  // Mode Chat (étape 30) : même Jaris, mêmes outils, sans synthèse vocale. Un rappel programmé par écrit
  // est quand même annoncé à voix haute par le pipeline vocal, comme un rappel programmé à la voix.
  ipcMain.handle(IPC_CHANNELS.sendChatMessage, (event, prompt: string, imageBase64?: string): Promise<ChatMessage> => {
    return chatSession.send(
      prompt,
      fireReminder,
      (message) => broadcast(IPC_CHANNELS.log, message),
      (cue: SoundCue) => broadcast(IPC_CHANNELS.soundCue, cue),
      (delta) => event.sender.send(IPC_CHANNELS.chatStreamToken, delta),
      imageBase64,
      undefined,
      'chat',
      (activity: WebActivity) => event.sender.send(IPC_CHANNELS.chatWebActivity, activity)
    )
  })
  ipcMain.on(IPC_CHANNELS.cancelChat, () => chatSession.cancel())
  // Étape 276 : micro du champ de saisie = dictée. Mêmes garde-fous que le téléphone : un WAV 16 kHz mono, 5 Mo
  // au plus — ce qui arrive du renderer n'est jamais écrit tel quel s'il n'a pas cette forme.
  ipcMain.handle(IPC_CHANNELS.transcribeDictation, async (_event, bytes: Uint8Array): Promise<string> => {
    const wav = Buffer.from(bytes)
    if (wav.length > MAX_VOICE_BYTES) throw new Error(t('main.dictationTooLong'))
    if (!isExpectedWav(wav)) throw new Error(t('main.dictationUnreadable'))
    return (await transcribeWav(wav)).trim()
  })
  ipcMain.handle(IPC_CHANNELS.getChatHistory, (): Promise<ChatMessage[]> => chatSession.getVisibleMessages())
  // Étape 346 : une question posée depuis le petit widget (ou le téléphone) part dans la même conversation, mais le
  // Chat n'en savait rien — ni « réfléchit », ni réponse avant le prochain changement de fenêtre. Chaque début et fin
  // de réponse est donc annoncé à toutes les fenêtres, et le fil relu.
  chatSession.onBusyChange((busy) => {
    broadcast(IPC_CHANNELS.chatBusy, busy)
    broadcast(IPC_CHANNELS.chatHistoryChanged)
  })
  ipcMain.handle(IPC_CHANNELS.getChatBusy, (): boolean => chatSession.busy)

  // Téléphone (étape 214) : Options → Téléphone.
  ipcMain.handle(IPC_CHANNELS.getPhoneAccess, (): Promise<PhoneAccessStatus> => getPhoneAccess().status())
  ipcMain.handle(IPC_CHANNELS.setPhoneAccessEnabled, async (_event, enabled: boolean): Promise<PhoneAccessStatus> => {
    const profile = await getProfile()
    if (profile) await saveProfile({ ...profile, phoneAccessEnabled: enabled })
    const manager = getPhoneAccess()
    if (enabled) {
      phoneLinksAutoOpen = true
      await manager.enable()
    } else {
      await manager.disable()
    }
    return manager.status()
  })
  ipcMain.handle(IPC_CHANNELS.createPhonePairing, (): PhonePairing => getPhoneAccess().createPairing())
  ipcMain.handle(IPC_CHANNELS.removePhoneDevice, async (_event, id: string): Promise<PhoneAccessStatus> => {
    await getPhoneAccess().removeDevice(id)
    return getPhoneAccess().status()
  })
  ipcMain.handle(IPC_CHANNELS.logoutPhoneAccess, async (): Promise<PhoneAccessStatus> => {
    const profile = await getProfile()
    if (profile) await saveProfile({ ...profile, phoneAccessEnabled: false })
    await getPhoneAccess().logout()
    return getPhoneAccess().status()
  })
  // L'adresse vient de l'état du tunnel (déjà vérifiée : une page de tailscale.com), jamais du renderer.
  ipcMain.handle(IPC_CHANNELS.openPhoneAccessLink, async (): Promise<void> => {
    const status = await getPhoneAccess().status()
    if (status.actionUrl) await shell.openExternal(status.actionUrl)
  })

  /**
   * Sélecteur d'image du Chat et du mode Code (étape 93).
   *
   * Le bouton "joindre une image" ouvrait jusqu'ici un `<input type="file">` caché côté renderer. Le
   * dialogue natif que Chromium ouvre alors prend le focus OS, donc `fullWindow` reçoit 'blur' — et le
   * handler 'blur' (createFullWindow) repliait Jaris en widget en plein milieu du choix du fichier :
   * "quand je clique sur image ça met jaris en widget et m'ouvre bien mes fichier" (Léo, usage réel).
   * Le garde qui existe déjà pour ce cas exact (`dialogOpen`, posé autour de chooseModelsLocation) ne
   * pouvait pas s'appliquer : un dialogue ouvert par le renderer n'est jamais vu par le main process.
   *
   * D'où ce passage par `dialog.showOpenDialog` ici : le drapeau est posé et retiré autour du seul appel
   * qui ouvre vraiment le dialogue, dans le process qui le contrôle — aucun état "replié plus jamais"
   * possible, contrairement à un renderer qui préviendrait de l'ouverture puis de la fermeture (un
   * dialogue annulé sans évènement, une fenêtre rechargée, et le drapeau resterait bloqué à true).
   *
   * Le fichier n'est ici QUE lu : la réduction reste côté renderer (src/lib/imageAttachment.ts), par le
   * même chemin que le collage et le glisser-déposer.
   */
  // Étape 185 : « Enregistrer sous » d'une image dessinée. Même garde dialogOpen que pickImageFile juste en
  // dessous : sans lui, la fenêtre de Windows faisait perdre le focus à Jaris, qui se repliait en widget.
  ipcMain.handle(IPC_CHANNELS.saveGeneratedImage, async (_event, dataUrl: string): Promise<SaveImageResult> => {
    const bytes = decodePngDataUrl(String(dataUrl))
    if (!bytes) return { saved: false, error: t('main.notPng') }
    const dialogOptions = {
      title: t('main.dialog.saveImage'),
      defaultPath: join(app.getPath('pictures'), defaultImageFileName(new Date())),
      filters: [{ name: t('main.dialog.pngFilter'), extensions: ['png'] }]
    }
    dialogOpen = true
    let target: string | undefined
    try {
      const result = fullWindow ? await dialog.showSaveDialog(fullWindow, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      target = result.canceled ? undefined : result.filePath
    } finally {
      dialogOpen = false
    }
    if (!target) return { saved: false }
    try {
      await writeFile(withPngExtension(target), bytes)
      return { saved: true }
    } catch (err) {
      return { saved: false, error: t('main.saveImageFailed', { error: err instanceof Error ? err.message : String(err) }) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.pickImageFile, async (): Promise<PickedImageFile | null> => {
    const dialogOptions = {
      properties: ['openFile' as const],
      title: t('main.dialog.pickImage'),
      filters: [{ name: t('app.mode.image.panel'), extensions: Object.keys(IMAGE_TYPES_BY_EXTENSION) }]
    }
    dialogOpen = true
    let chosen: string | undefined
    try {
      const result = fullWindow
        ? await dialog.showOpenDialog(fullWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      chosen = result.canceled ? undefined : result.filePaths[0]
    } finally {
      dialogOpen = false
    }
    if (!chosen) return null

    const extension = extname(chosen).slice(1).toLowerCase()
    return {
      name: basename(chosen),
      // Vide si l'extension est inconnue (le filtre du dialogue n'empêche pas de taper *.* puis de choisir
      // n'importe quoi) : le renderer refuse alors avec le même message que pour un collage non supporté.
      type: IMAGE_TYPES_BY_EXTENSION[extension] ?? '',
      base64: (await readFile(chosen)).toString('base64')
    }
  })

  // Mode Code (étape 30) : génération d'une application autonome, avec avancement au fil de l'eau (la
  // génération + relecture peut prendre plusieurs minutes sur un modèle local).
  ipcMain.handle(
    IPC_CHANNELS.generateApp,
    async (event, description: string, currentHtml?: string, imageBase64?: string): Promise<GeneratedApp> => {
      // Une seule génération à la fois (le bouton est désactivé pendant) : ce contrôleur est donc celui de
      // la génération en cours, et c'est lui que le bouton "Arrêter" déclenche (étape 99). Remis à null à
      // la fin pour qu'un clic tardif n'annule pas la génération SUIVANTE.
      codeGenAbort?.abort()
      // Nouvelle demande : la mémoire automatique de l'échange précédent ne doit pas occuper Ollama devant elle.
      cancelMemoryExtraction()
      const controller = new AbortController()
      codeGenAbort = controller
      try {
        const generated = await generateApp(
          description,
          (message) => event.sender.send(IPC_CHANNELS.codeGenStatus, message),
          currentHtml,
          imageBase64,
          {
            onProgress: (progress) => event.sender.send(IPC_CHANNELS.codeGenProgress, progress),
            onActivity: (activity) => event.sender.send(IPC_CHANNELS.codeGenActivity, activity),
            onLive: (live) => event.sender.send(IPC_CHANNELS.codeGenLive, live),
            signal: controller.signal
          }
        )
        return { ...generated, previewUrl: createGeneratedAppPreview(generated.html) }
      } finally {
        if (codeGenAbort === controller) codeGenAbort = null
      }
    }
  )
  ipcMain.on(IPC_CHANNELS.cancelCodeGen, () => codeGenAbort?.abort())

  // Étape 277 : GitHub dans le mode Code. Le jeton reste ici (githubSession.ts) ; l'écran ne reçoit que des
  // descriptions. Le travail de l'agent partage le contrôleur d'arrêt et l'avancement d'une génération : un seul
  // travail à la fois dans le mode Code, arrêté par le même bouton.
  ipcMain.handle(IPC_CHANNELS.githubStatus, () => getGithubStatus())
  ipcMain.handle(IPC_CHANNELS.githubStartLogin, async () => {
    const code = await startGithubLogin()
    // « Le plus facile » (Léo) : le code est déjà copié et la page GitHub déjà ouverte — il n'y a qu'à coller.
    clipboard.writeText(code.userCode)
    void shell.openExternal(code.verificationUri)
    return code
  })
  ipcMain.handle(IPC_CHANNELS.githubFinishLogin, () => finishGithubLogin())
  ipcMain.on(IPC_CHANNELS.githubCancelLogin, () => cancelGithubLogin())
  ipcMain.handle(IPC_CHANNELS.githubLogout, () => logoutGithub())
  ipcMain.handle(IPC_CHANNELS.githubListRepos, () => listGithubRepos())
  ipcMain.handle(IPC_CHANNELS.githubListBranches, (_event, fullName: string) => listGithubBranches(fullName))
  ipcMain.handle(IPC_CHANNELS.githubOpenRepo, (_event, fullName: string, branch?: string) => openGithubRepo(fullName, branch))
  ipcMain.handle(IPC_CHANNELS.githubRunAgent, async (event, fullName: string, request: string, imageBase64?: string) => {
    codeGenAbort?.abort()
    cancelMemoryExtraction()
    const controller = new AbortController()
    codeGenAbort = controller
    try {
      return await runGithubAgent(fullName, request, {
        imageBase64,
        onStatus: (message) => event.sender.send(IPC_CHANNELS.codeGenStatus, message),
        onActivity: (activity) => event.sender.send(IPC_CHANNELS.codeGenActivity, activity),
        onNarration: (narration) => event.sender.send(IPC_CHANNELS.codeGenNarration, narration),
        onLive: (live) => event.sender.send(IPC_CHANNELS.codeGenLive, live),
        onProgress: (progress) => event.sender.send(IPC_CHANNELS.codeGenProgress, progress),
        signal: controller.signal
      })
    } finally {
      if (codeGenAbort === controller) codeGenAbort = null
    }
  })
  ipcMain.handle(IPC_CHANNELS.githubDiscardChanges, (_event, fullName: string, path?: string) => discardGithubChanges(fullName, path))
  // Étape 287 : le site du dépôt, jouable dans l'aperçu, avec les changements préparés par Jaris (pas encore enregistrés).
  ipcMain.handle(IPC_CHANNELS.githubPreview, (_event, fullName: string): RepoPreview => {
    const entry = githubPreviewEntry(fullName)
    return { entry, url: entry ? createFilesPreview(entry, (path) => readGithubPreviewFile(fullName, path)) : null }
  })
  // Étape 327 : la vue « Code » d'un dépôt — la liste de ses fichiers, puis le texte de celui qu'on ouvre.
  ipcMain.handle(IPC_CHANNELS.githubListFiles, (_event, fullName: string): string[] => listGithubFiles(fullName))
  ipcMain.handle(IPC_CHANNELS.githubReadFile, (_event, fullName: string, path: string): Promise<RepoFileContent> =>
    readGithubFile(fullName, path)
  )
  ipcMain.handle(IPC_CHANNELS.githubCommit, (_event, fullName: string, message: string) => commitGithubChanges(fullName, message))

  // Mode Image (étape 200, remplace le Montage) : le moteur de dessin de l'étape 173 a sa propre page. Seuls des
  // NOMS de fichiers PNG voyagent entre l'écran et ici, revérifiés à chaque fois (generatedImagePath).
  ipcMain.handle(IPC_CHANNELS.getImageStudioStatus, (): Promise<ImageStudioStatus> => getImageStudioStatus())
  ipcMain.handle(IPC_CHANNELS.installImageStudio, (event) =>
    installImageModel((message) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.imageStudioLog, message)
    })
  )
  ipcMain.handle(IPC_CHANNELS.generateStudioImage, async (event, prompt: string): Promise<GeneratedImageSummary> => {
    imageStudioAbort?.abort()
    // Nouvelle demande : la mémoire automatique ne doit pas occuper Ollama (ni la carte graphique) devant le dessin.
    cancelMemoryExtraction()
    const controller = new AbortController()
    imageStudioAbort = controller
    try {
      const image = await generateImage(
        String(prompt),
        (message) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.imageStudioLog, message)
        },
        controller.signal,
        // Étape 292 : « un chat » tapé ici était dessiné comme « a chat » (une conversation).
        toEnglishPrompt
      )
      return { fileName: image.fileName, label: imageLabelFromFileName(image.fileName), timestamp: Date.now() }
    } finally {
      if (imageStudioAbort === controller) imageStudioAbort = null
    }
  })
  ipcMain.on(IPC_CHANNELS.cancelStudioImage, () => imageStudioAbort?.abort())
  ipcMain.handle(IPC_CHANNELS.listGeneratedImages, (): Promise<GeneratedImageSummary[]> => listGeneratedImages())
  ipcMain.handle(IPC_CHANNELS.readGeneratedImage, (_event, fileName: string): Promise<string | null> => readGeneratedImageDataUrl(String(fileName)))
  ipcMain.handle(IPC_CHANNELS.deleteGeneratedImage, (_event, fileName: string) => deleteGeneratedImage(String(fileName)))
  ipcMain.handle(IPC_CHANNELS.openGeneratedImages, async (_event, fileName?: string) => {
    if (fileName) shell.showItemInFolder(generatedImagePath(String(fileName)))
    else await shell.openPath(generatedImagesDir())
  })
  // Mode Vidéo (étape 203) : Wan 2.2 TI2V 5B avec le même moteur que les images. Seuls des NOMS de fichiers
  // .webm voyagent entre l'écran et ici, revérifiés à chaque fois (generatedVideoPath).
  ipcMain.handle(IPC_CHANNELS.getVideoStudioStatus, (): Promise<VideoStudioStatus> => getVideoStudioStatus())
  // Étape 205 : la qualité vient de l'écran — ramenée à Q6 si elle n'en est pas une, puis revérifiée pour la
  // machine par installVideoModel/generateVideo (jamais crue sur parole).
  ipcMain.handle(IPC_CHANNELS.installVideoStudio, (event, quality?: unknown) =>
    installVideoModel(isVideoQuality(quality) ? quality : 'q6', (message) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.videoStudioLog, message)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.generateStudioVideo,
    async (
      event,
      prompt: string,
      image?: { base64: string; mimeType?: string } | null,
      seconds?: number,
      quality?: unknown
    ): Promise<GeneratedVideoSummary> => {
      videoStudioAbort?.abort()
      cancelMemoryExtraction()
      const controller = new AbortController()
      videoStudioAbort = controller
      const initImage =
        image && typeof image.base64 === 'string'
          ? { bytes: Buffer.from(image.base64, 'base64'), extension: image.mimeType === 'image/png' ? ('png' as const) : ('jpg' as const) }
          : undefined
      try {
        const video = await generateVideo(
          String(prompt),
          (message) => {
            if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.videoStudioLog, message)
          },
          controller.signal,
          initImage,
          normalizeVideoSeconds(seconds),
          isVideoQuality(quality) ? quality : 'q6',
          toEnglishPrompt
        )
        return { fileName: video.fileName, label: imageLabelFromFileName(video.fileName), timestamp: Date.now() }
      } finally {
        if (videoStudioAbort === controller) videoStudioAbort = null
      }
    }
  )
  ipcMain.on(IPC_CHANNELS.cancelStudioVideo, () => videoStudioAbort?.abort())
  ipcMain.handle(IPC_CHANNELS.listGeneratedVideos, (): Promise<GeneratedVideoSummary[]> => listGeneratedVideos())
  ipcMain.handle(IPC_CHANNELS.readGeneratedVideo, (_event, fileName: string): Promise<Buffer> => readGeneratedVideo(String(fileName)))
  ipcMain.handle(IPC_CHANNELS.deleteGeneratedVideo, (_event, fileName: string) => deleteGeneratedVideo(String(fileName)))
  ipcMain.handle(IPC_CHANNELS.openGeneratedVideos, async (_event, fileName?: string) => {
    if (fileName) shell.showItemInFolder(generatedVideoPath(String(fileName)))
    else await shell.openPath(generatedVideosDir())
  })
  // Même garde dialogOpen que « Enregistrer l'image » : sinon la fenêtre de Windows replie Jaris en widget.
  ipcMain.handle(IPC_CHANNELS.saveGeneratedVideo, async (_event, fileName: string): Promise<SaveImageResult> => {
    const source = generatedVideoPath(String(fileName))
    const dialogOptions = {
      title: t('main.dialog.saveVideo'),
      defaultPath: join(app.getPath('videos'), String(fileName).replace(/^[\d-]+T[\d-]+-/, '')),
      filters: [{ name: t('main.dialog.webmFilter'), extensions: ['webm'] }]
    }
    dialogOpen = true
    let target: string | undefined
    try {
      const result = fullWindow ? await dialog.showSaveDialog(fullWindow, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      target = result.canceled ? undefined : result.filePath
    } finally {
      dialogOpen = false
    }
    if (!target) return { saved: false }
    try {
      await copyFile(source, /\.webm$/i.test(target) ? target : `${target}.webm`)
      return { saved: true }
    } catch (err) {
      return { saved: false, error: t('main.saveVideoFailed', { error: err instanceof Error ? err.message : String(err) }) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.openGeneratedApp, async (_event, path?: string) => {
    // Étape 328 : jamais un chemin quelconque — shell.openPath lancerait un programme s'il en désignait un.
    await shell.openPath(path ? assertGeneratedAppDir(path) : getGeneratedAppsDir())
  })
  ipcMain.handle(IPC_CHANNELS.getGeneratedApps, (): Promise<GeneratedAppSummary[]> => listGeneratedApps())
  ipcMain.handle(IPC_CHANNELS.deleteGeneratedApp, (_event, path: string) => deleteGeneratedApp(path))
  ipcMain.handle(IPC_CHANNELS.loadGeneratedApp, async (_event, path: string): Promise<GeneratedApp> => {
    const loaded = await loadGeneratedApp(path)
    return { ...loaded, previewUrl: createGeneratedAppPreview(loaded.html) }
  })
  // La liste et les conversations du mode Code, dans un fichier du dossier de données (codeConversationsStore.ts) :
  // le localStorage où elles vivaient partait avec le dossier de Chromium à chaque « Déplacer ». Créé au premier
  // usage ; lu de façon synchrone (l'écran les affiche dès son premier rendu), écrit à chaque changement.
  let codeConversationsStore: CodeConversationsStore | null = null
  const codeConversations = (): CodeConversationsStore =>
    (codeConversationsStore ??= new CodeConversationsStore(join(getDataRoot(), CODE_CONVERSATIONS_FILE)))
  ipcMain.on(IPC_CHANNELS.loadCodeConversations, (event) => {
    try {
      event.returnValue = codeConversations().load()
    } catch (err) {
      console.error('[code] Lecture des conversations du mode Code impossible :', err)
      event.returnValue = null
    }
  })
  ipcMain.handle(IPC_CHANNELS.saveCodeConversation, (_event, key: unknown, turns: unknown) =>
    codeConversations().setConversation(key, turns)
  )
  ipcMain.handle(IPC_CHANNELS.saveCodeRepos, (_event, repos: unknown) => codeConversations().setRepos(repos))
  ipcMain.handle(IPC_CHANNELS.importCodeConversations, (_event, data: unknown) => codeConversations().importLegacy(data))
  // Une écriture refusée un instant par Windows (antivirus, indexeur) est retentée à la fermeture, une fois les
  // fenêtres fermées (plus rien ne peut arriver de l'écran) : sinon le tout dernier changement de la session, resté
  // en mémoire, ne serait jamais arrivé dans le fichier.
  app.on('will-quit', () => {
    try {
      codeConversationsStore?.flush()
    } catch (err) {
      console.error('[code] Conversations du mode Code non enregistrées à la fermeture :', err)
    }
  })

  ipcMain.on(IPC_CHANNELS.onboardingFinished, () => {
    // Fin de la configuration (« Continuer » de « Configuration terminée ») : la fenêtre RESTE ouverte, au
    // premier plan, sur l'écran d'accueil — même règle qu'au démarrage normal (étape 295). Avant, elle se cachait
    // et seul le petit widget restait en haut de l'écran : un nouvel utilisateur croyait que Jaris s'était
    // fermé, au moment précis où il voulait commencer. Le widget est seulement préparé, caché (au tout premier
    // lancement il n'existe pas encore : il n'est créé au démarrage que si la configuration était déjà faite),
    // pour prendre le relais dès qu'on réduit Jaris ou qu'on passe sur une autre application. Il doit exister
    // même caché : c'est lui qui porte le lecteur audio des réponses parlées (App.tsx), y compris quand on parle
    // depuis la grande fenêtre.
    onboardingDone = true
    // PAS de délai de grâce ici, contrairement à la sortie de l'écran de démarrage (étape 296) : aucune fenêtre ne
    // passe le premier plan à une autre. Celle-ci a déjà le focus (on vient d'y cliquer « Continuer »), elle change
    // seulement d'écran, et le widget naît caché (sans prendre le focus). Un délai ne ferait qu'ignorer un vrai
    // changement d'application dans les secondes qui suivent : Jaris resterait derrière, sans widget.
    if (!widgetWindow || widgetWindow.isDestroyed()) widgetWindow = createWidgetWindow()
    showFullWindow()
  })
  ipcMain.on(IPC_CHANNELS.openSettings, () => showFullWindow())

  // Gardé en variable de module : sans référence, Electron peut ramasser l'icône par le garbage collector
  // et la faire disparaître de la barre système.
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Jaris')
  refreshTrayMenu()
  tray.on('click', () => showFullWindow())


  // Après la première configuration, l'écran de démarrage puis la fenêtre de Jaris (étapes 294-295) ; le widget
  // prend le relais quand on la réduit ou qu'on passe sur une autre application. L'onboarding au premier lancement.
  // Étape 325 : la lecture du profil peut maintenant échouer (fichier tenu par un antivirus, voir atomicFile.ts) au
  // lieu d'être prise pour « aucun profil ». Sans garde, l'exception arrêtait le démarrage avant toute fenêtre : Jaris
  // restait invisible, icône comprise. On réessaie quelques secondes ; si ça dure, Jaris le dit et se ferme proprement
  // — jamais l'écran de premier lancement, dont le premier enregistrement écraserait le vrai profil.
  const profile = await readProfileAtStartup()
  if (profile === undefined) return
  setWakeShortcutWanted(profile?.activationKeyEnabled !== false)
  onboardingDone = Boolean(profile?.capacityScanDone)
  // Étape 165 : lancé par Windows à l'ouverture de session (Options → Général), Jaris s'affiche en grand au
  // lieu de démarrer discrètement — « dès que le PC démarre on voit la fenêtre Jaris et pas le fond d'écran ».
  const revealAtLogin = onboardingDone && wasLaunchedAtLogin(process.argv)
  // Étape 294 : l'écran de démarrage d'abord, pour qu'il apparaisse au plus vite ; Jaris se prépare derrière.
  if (onboardingDone) splashWindow = createSplashWindow()
  else startupRevealed = true
  fullWindow = createFullWindow(!onboardingDone)

  // Widget pré-créé et chargé en arrière-plan dès le démarrage (caché) : sans ça, la première fois qu'on
  // réduit la fenêtre, il fallait créer la fenêtre Electron ET charger toute la page React avant de
  // pouvoir l'afficher, ce qui se voyait clairement comme un délai. Là, il ne reste plus qu'à le
  // positionner et l'afficher (quasi instantané).
  if (onboardingDone) {
    widgetWindow = createWidgetWindow()
    // Une fois Jaris hors de sa fenêtre principale, son état inactif reste visible en haut au centre dès le
    // démarrage : petit orbe en Vocal, petit indicateur Chat dans ce mode. Étape 294 : seulement quand tout est
    // prêt ET que ses fenêtres ont fini leur premier rendu (pas de flash blanc ni de forme provisoire).
    const windowsLoaded = Promise.all([windowLoaded(fullWindow), windowLoaded(widgetWindow)])
    startup.whenReady(() => void windowsLoaded.then(() => revealAfterStartup(revealAtLogin)))
    // La voix (synthèse) se charge pendant l'attente, plus à la toute première réponse.
    startup.track('voice', ttsClient.start().then(() => true))
  }

  watchWidgetPresence()
  screen.on('display-metrics-changed', recenterWidget)
  screen.on('display-added', recenterWidget)
  screen.on('display-removed', recenterWidget)
  // Les rappels en attente sont réarmés UNE fois, ici — plus à chaque redémarrage du moteur vocal (changement de
  // micro, mot d'activation...), qui les faisait sonner en double (étape 234).
  void restoreReminders(fireReminder)
  // Étape 294 : l'écoute compte comme prête quand le moteur vocal a vraiment démarré (ou a échoué : l'écran de
  // démarrage ne doit jamais rester bloqué, et le message habituel dira ce qui manque).
  startup.track('listening', startVoicePipeline().then(() => lastSetupStatus.ready))
  // Étape 214 : accès téléphone relancé au démarrage s'il était activé (sans ouvrir le navigateur tout seul).
  void getProfile()
    .then((profile) => {
      if (profile?.phoneAccessEnabled) void getPhoneAccess().enable().catch((err) => broadcast(IPC_CHANNELS.log, t('phone.log', { message: String(err) })))
    })
    .catch(() => {})
})

/**
 * Profil lu au démarrage (étape 325) : réessayé ~10 s quand il est verrouillé. `undefined` = toujours illisible :
 * l'erreur a été montrée et Jaris se ferme (rien n'est écrit).
 */
async function readProfileAtStartup(): Promise<Profile | null | undefined> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await getProfile()
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  dialog.showErrorBox('Jaris', lastError instanceof Error ? lastError.message : String(lastError))
  quitting = true
  app.quit()
  return undefined
}

// Se déclenche une seule fois quel que soit le chemin de sortie (Quitter dans la barre système,
// window-all-closed...), avant que les fenêtres ne se ferment : le bon endroit pour arrêter proprement ce
// que Jaris a lui-même démarré, plutôt qu'un process qui continue de tourner indéfiniment en arrière-plan.
app.on('before-quit', () => {
  // Étape 230 : un test de modèles (des heures) ne doit jamais continuer après Jaris : il reprendra au relancement.
  stopModelTest()
  // Étape 355 : un duel en cours s'arrête avec Jaris ; aucun vote n'est donné à la place de Léo.
  abortDuel()
  stopOllamaIfStartedByJaris()
  // Étape 153 : app.quit() (mise à jour, croix, « Quitter ») ne déclenche PAS 'window-all-closed' — seul
  // endroit où les deux programmes Python (écoute, voix) étaient arrêtés. Ils survivaient donc à Jaris, micro
  // ouvert, jusqu'au redémarrage de Windows.
  pipeline?.stop()
  ttsClient.stop()
  void phoneAccess?.disable()
})

// Déclenché sur la toute première instance (celle qui a le verrou, voir requestSingleInstanceLock tout en
// haut du fichier) quand une deuxième tentative de lancement vient de se faire recaler : au lieu de laisser
// l'utilisateur croire que rien ne s'est passé, on ramène la fenêtre existante au premier plan — exactement
// ce que ferait un simple clic sur l'icône de la barre système.
app.on('second-instance', () => {
  showFullWindow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  pipeline?.stop()
  ttsClient.stop()
  app.quit()
})

/**
 * Étape 192 : le modèle dont on peut régler la réflexion pour un mode — celui choisi à la main, ou l'unique
 * modèle d'Auto en Code. `null` en Chat/Vocal Auto (le modèle change selon la question).
 */
function thinkingModelFor(profile: Profile | null, mode: ModelChoiceMode, installed: string[] | null, autoModel: string | null): string | null {
  return (installed && resolveChosenModel(profile, mode, installed)) || autoModel
}
