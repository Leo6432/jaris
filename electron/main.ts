import { app, dialog, ipcMain, session, shell, BrowserWindow, globalShortcut, screen, Tray, Menu } from 'electron'
import { basename, extname, join } from 'path'
import { readFile } from 'fs/promises'
import {
  ensureOllamaRunning,
  ensureSearxngRunning,
  getOllamaVersionStatus,
  stopOllamaCompletely,
  stopOllamaIfStartedByJaris,
  updateOllama
} from './services/dependencyServices'
import { deleteModel } from './services/ollama'
import { getModelsLocationStatus, moveModelsLocation } from './services/modelsLocation'
import { moveDataLocation } from './services/dataLocation'
import { computeContextLengthOptions, getAllCandidateModelIds, getModelOverview, getMyModelPicks, isUnusedInstalledModel } from './services/hardwareScan'
import { config } from './config'
import { getRuntimeSetupStatus, runFirstRunSetup } from './services/firstRunSetup'
import { runModelAnalysis, runQuickSetup } from './services/benchmarkRunner'
import { chatSession } from './services/chatSession'
import { deleteGeneratedApp, generateApp, getGeneratedAppsDir, listGeneratedApps, loadGeneratedApp } from './services/codeGenerator'
import { createGeneratedAppPreview, registerPreviewHandler, registerPreviewScheme } from './services/generatedAppPreview'
import { previewVoice } from './services/tts'
import { ttsClient } from './services/ttsClient'
import { createTrayIcon } from './services/trayIcon'
import { VoicePipeline } from './services/voicePipeline'
import { listAudioInputDevices } from './services/voiceClient'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, recallNote } from './services/memoryStore'
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
import { getProfile, saveProfile } from './services/profileStore'
import { checkAppFreshness, checkForUpdate, getAppVersionStatus, getInstalledVersion, updateApp } from './services/appUpdater'
import {
  IPC_CHANNELS,
  IMAGE_TYPES_BY_EXTENSION,
  type AnalysisScope,
  type AppMode,
  type AudioInputDevice,
  type CapacityScanResult,
  type ChatMessage,
  type ConversationList,
  type GeneratedApp,
  type GeneratedAppSummary,
  type JarisEmotion,
  type MemoryGraph,
  type PickedImageFile,
  type Profile,
  type SoundCue,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload,
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
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null
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
  pipeline?.setListeningSuspended(activeMode !== 'voice')
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

function loadRenderer(win: BrowserWindow, mode: 'full' | 'widget'): void {
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
function createFullWindow(showWhenReady = true): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 480,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#05070c',
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
    if (!onboardingDone) return
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
    if (!onboardingDone || dialogOpen || quitting || optionsOpen) return
    win.hide()
    showWidgetWindow()
    applyListeningForActiveMode()
  })
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
function createWidgetWindow(): BrowserWindow {
  // Position définitive posée juste avant l'affichage par positionWidgetWindow() (recalculée à chaque
  // fois, pas figée ici) : la valeur de départ n'a pas d'importance tant que la fenêtre reste cachée.
  const win = new BrowserWindow({
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
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Pas d'auto-show Electron avant le rendu : le widget est créé caché, puis showWidgetWindow() l'affiche
  // dès `ready-to-show` dans son petit état inactif. Cela conserve sa présence permanente sans flash vide.
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
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
  stopChatPointerWatch()
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
  if (!fullWindow || fullWindow.isDestroyed()) fullWindow = createFullWindow()
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
function showWidgetWindow(forceExpanded = false): void {
  if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) return
  // Depuis le mode Code, Jaris disparaît complètement : "ça doit rien faire aucun widget" (Léo). Un widget
  // déjà affiché est caché plutôt que laissé tel quel — sinon, passer en Code puis quitter la fenêtre
  // laisserait à l'écran la forme du mode précédent, qui ne correspond plus à rien. Jaris reste joignable
  // par son icône dans la barre système ("Ouvrir Jaris").
  if (activeMode === 'code') {
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
  widgetWindow.show()
  // Le raccourci + part souvent pendant qu'une autre application a le focus. Afficher la barre Chat sans
  // lui donner le focus obligerait à recliquer dedans avant d'écrire, alors que + vient précisément de
  // demander cette saisie. Le widget vocal, lui, ne vole jamais le focus pendant une activation à la voix.
  if (displayedWidgetMode === 'chat') {
    widgetWindow.focus()
    startChatPointerWatch()
  } else {
    stopChatPointerWatch()
  }
}

/** La touche + ouvre la forme du mode actif : barre écrite en Chat, écoute visible en Agent vocal. */
function triggerVisibleWake(): void {
  if (activeMode === 'code') return
  if (activeMode === 'chat') {
    if (!fullWindow?.isVisible()) showWidgetWindow(true)
    return
  }
  // Une pression pendant les toutes premières secondes du démarrage ne doit pas laisser une barre vide
  // affichée indéfiniment si le pipeline n'existe pas encore : dans ce cas, on ignore simplement la touche.
  if (!pipeline) return
  if (!fullWindow?.isVisible()) showWidgetWindow(true)
  pipeline.triggerWake()
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

/** Envoie un évènement du pipeline vocal à toutes les fenêtres actuellement ouvertes (réglages et/ou widget). */
function broadcast(channel: string, payload?: unknown): void {
  if (channel === IPC_CHANNELS.log) console.log('[jaris]', payload)
  for (const win of [fullWindow, widgetWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function startVoicePipeline(): Promise<void> {
  const log = (message: string): void => broadcast(IPC_CHANNELS.log, message)
  void ensureOllamaRunning(log)
  void ensureSearxngRunning(log)

  pipeline = new VoicePipeline()
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
  pipeline.on('transcript', (text: string) => broadcast(IPC_CHANNELS.transcript, text))
  pipeline.on('reply', (payload: VoiceReplyPayload) => broadcast(IPC_CHANNELS.reply, payload))
  pipeline.on('log', (message: string) => broadcast(IPC_CHANNELS.log, message))
  pipeline.on('soundCue', (cue: SoundCue) => broadcast(IPC_CHANNELS.soundCue, cue))
  pipeline.on('micTestLevel', (level: number) => broadcast(IPC_CHANNELS.micTestLevel, { level }))
  pipeline.on('micTestDone', (detected: boolean) => broadcast(IPC_CHANNELS.micTestDone, { detected }))
  // Arrêt d'urgence déclenché par la sécurité thermique GPU (voicePipeline/resourceMonitor) : un vrai
  // app.quit() (pas juste cacher la fenêtre, voir `quitting` plus haut), pour protéger la machine.
  pipeline.on('shutdown', () => {
    console.log('[jaris] Arrêt automatique : GPU en surchauffe.')
    quitting = true
    app.quit()
  })

  try {
    const profile = await getProfile()
    await pipeline.start(profile?.audioInputDeviceIndex, profile?.activationWakeWordEnabled !== false)
    lastSetupStatus = { ready: true, missing: [] }
    broadcast(IPC_CHANNELS.setupStatus, lastSetupStatus)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcast(IPC_CHANNELS.log, `Échec du démarrage du pipeline vocal : ${message}`)
    lastSetupStatus = { ready: false, missing: [message] }
    broadcast(IPC_CHANNELS.setupStatus, lastSetupStatus)
  }
}

app.whenReady().then(async () => {
  // `app.quit()` (voir tout en haut du fichier) n'interrompt pas forcément la suite du script de façon
  // synchrone : `ready` peut malgré tout finir par se déclencher pour l'instance perdante avant que la
  // sortie demandée ne soit vraiment effective (constaté en usage réel : plusieurs fenêtres Jaris qui
  // s'ouvrent puis se referment aussitôt en rafale au lancement). Sans ce garde-fou, une instance qui a
  // déjà perdu la course au verrou continuerait quand même à créer sa fenêtre, démarrer Ollama, etc. avant
  // de se fermer — exactement le flash visible à corriger ici.
  if (!gotSingleInstanceLock) return
  registerPreviewHandler()

  // Autorise silencieusement l'accès micro pour les fenêtres de Jaris (enumerateDevices() ne révèle les
  // vrais noms de périphériques audio qu'après une permission media accordée, voir Options → Voix) : sans
  // ce handler, Chromium afficherait une popup de permission native, déroutante dans une appli de bureau
  // qui n'a jamais utilisé getUserMedia() jusqu'ici (le micro est capturé côté Python, pas par le renderer).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // Un seul check par lancement (comme checkOllamaFreshness) : la version installée ne change pas pendant
  // que Jaris tourne, pas la peine de refaire l'appel réseau à chaque ouverture d'un onglet Options.
  void checkAppFreshness()

  ipcMain.handle(IPC_CHANNELS.setupStatus, () => lastSetupStatus)
  ipcMain.on(IPC_CHANNELS.triggerWake, () => triggerVisibleWake())
  ipcMain.on(IPC_CHANNELS.audioEnded, () => pipeline?.notifyAudioEnded())
  ipcMain.handle(IPC_CHANNELS.getProfile, () => getProfile())
  ipcMain.handle(IPC_CHANNELS.saveProfile, (_event, profile: Profile) => saveProfile(profile))
  ipcMain.handle(IPC_CHANNELS.openMemoryFolder, async () => {
    await ensureMemoryDir()
    await shell.openPath(getMemoryDir())
  })
  ipcMain.handle(IPC_CHANNELS.getMemoryGraph, () => buildMemoryGraphWithUser())
  ipcMain.handle(IPC_CHANNELS.getMemoryNoteContent, (_event, title: string) => recallNote(title))
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
    await deleteConversation(id)
    return switchConversation()
  })
  ipcMain.handle(IPC_CHANNELS.clearConversationHistory, async () => {
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
    await saveProfile({ ...profile, audioInputDeviceIndex: deviceIndex })
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
  ipcMain.on(IPC_CHANNELS.testMicrophone, () => pipeline?.testMic())
  ipcMain.on(IPC_CHANNELS.stopTestMicrophone, () => pipeline?.stopTestMic())
  ipcMain.on(IPC_CHANNELS.setActiveMode, (_event, mode: AppMode) => {
    activeMode = mode
    applyListeningForActiveMode()
  })
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
  ipcMain.on(IPC_CHANNELS.setOptionsOpen, (_event, open: boolean) => {
    optionsOpen = open
  })
  ipcMain.handle(IPC_CHANNELS.getModelOverview, async () => getModelOverview(await getProfile()))
  // Étape suivante (Léo : "jaris voit les model et regarde la vram et propose une barre... personnalisé à
  // chacun pour que le dernier ne dépasse pas la vram") : le modèle de référence est celui du palier
  // PUISSANT (le plus gros modèle de conversation configuré, voir computeContextLengthOptions pour le
  // pourquoi), jamais un modèle choisi par le renderer — recalculé à chaque ouverture de l'onglet.
  ipcMain.handle(IPC_CHANNELS.getContextLengthOptions, async () => {
    const profile = await getProfile()
    const model = profile?.models?.large ?? config.ollama.model
    const currentContext = profile?.contextLength ?? config.ollama.numCtx
    return computeContextLengthOptions(model, currentContext)
  })
  ipcMain.handle(IPC_CHANNELS.setContextLength, async (_event, contextLength: number | undefined) => {
    const profile = await getProfile()
    if (!profile) return
    await saveProfile({ ...profile, contextLength })
  })
  ipcMain.handle(IPC_CHANNELS.getOllamaVersionStatus, () => getOllamaVersionStatus())
  // Même canal d'avancement que la mise à jour de Jaris, distingué par `target` (étape 112) : l'installeur
  // d'Ollama pèse 1,5 Go, soit plusieurs minutes pendant lesquelles le bouton restait muet ("ça bloque
  // depuis 5m", Léo).
  ipcMain.handle(IPC_CHANNELS.updateOllama, () =>
    updateOllama((progress) => broadcast(IPC_CHANNELS.updateProgress, { target: 'ollama', ...progress }))
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
  ipcMain.handle(IPC_CHANNELS.getModelsLocationStatus, () => getModelsLocationStatus())
  ipcMain.handle(IPC_CHANNELS.chooseModelsLocation, async () => {
    const dialogOptions = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      title: 'Choisir où stocker les modèles et fichiers lourds de Jaris'
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
    log('Arrêt temporaire des services…')
    pipeline?.stop()
    ttsClient.stop()
    await stopOllamaCompletely()

    const outcome = await moveModelsLocation(newDir, log)
    // Étape 121, Léo : "sa doit déplacer tout" — les conversations/profil/mémoire/applications générées
    // partent aussi, pas seulement les trois briques lourdes ci-dessus (voir dataLocation.ts pour le
    // pourquoi d'un mécanisme différent : pas de jonction sur userData, qui héberge aussi les fichiers
    // internes de Chromium ouverts en permanence).
    const dataOutcome = await moveDataLocation(newDir, log)

    if (dataOutcome.success) {
      // Les stores calculent leur chemin UNE fois au chargement du module : copier les fichiers ne suffit
      // pas, il faut relancer Jaris pour qu'il relise tout depuis le nouvel emplacement. Inutile de
      // redémarrer les services ici — l'instance suivante les relance elle-même à son démarrage normal.
      log('Redémarrage de Jaris pour utiliser le nouvel emplacement…')
      quitting = true
      app.relaunch()
      // Laisse la réponse IPC repartir vers l'interface avant de couper : sinon la promesse côté renderer
      // ne se résout jamais et le bouton reste figé sur "Déplacement en cours…" jusqu'à la relance.
      setTimeout(() => app.quit(), 500)
    } else {
      log('Redémarrage des services…')
      void ensureOllamaRunning(log)
      await startVoicePipeline()
    }

    return {
      success: outcome.success && dataOutcome.success,
      message: [outcome.message, dataOutcome.message].filter(Boolean).join(' ')
    }
  })
  ipcMain.handle(IPC_CHANNELS.getRuntimeSetupStatus, () => getRuntimeSetupStatus())
  // L'installation du premier lancement (Python, Ollama) dure plusieurs minutes : chaque étape est
  // diffusée au fil de l'eau plutôt qu'attendre la fin, pour que l'utilisateur voie que ça avance.
  ipcMain.handle(IPC_CHANNELS.runRuntimeSetup, async () => {
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
    return currentIds.filter((id) => !known.has(id))
  })
  ipcMain.handle(IPC_CHANNELS.acknowledgeNewModels, async (): Promise<void> => {
    const profile = await getProfile()
    if (!profile) return
    await saveProfile({ ...profile, knownModelCandidates: getAllCandidateModelIds() })
  })
  ipcMain.handle(IPC_CHANNELS.runModelAnalysis, async (event, scope?: AnalysisScope): Promise<CapacityScanResult> => {
    return runModelAnalysis((line) => event.sender.send(IPC_CHANNELS.modelBenchmarkLine, line), scope)
  })
  ipcMain.handle(IPC_CHANNELS.getMyModelPicks, async () => getMyModelPicks(await getProfile()))
  // Étape 140 : le nom vient du renderer, donc revérifié ICI avant toute suppression — un modèle utilisé par
  // un rôle du profil (ou inconnu d'Ollama) n'est jamais supprimé, quoi que demande l'interface.
  ipcMain.handle(IPC_CHANNELS.deleteUnusedModel, async (_event, model: string): Promise<void> => {
    if (typeof model !== 'string' || !(await isUnusedInstalledModel(model, await getProfile()))) {
      throw new Error("Ce modèle est utilisé par Jaris ou n'est pas installé : il n'a pas été supprimé.")
    }
    await deleteModel(model)
  })
  ipcMain.handle(IPC_CHANNELS.runQuickSetup, async (event): Promise<CapacityScanResult> => {
    return runQuickSetup((line) => event.sender.send(IPC_CHANNELS.modelBenchmarkLine, line))
  })

  // Mode Chat (étape 30) : même Jaris, mêmes outils, sans synthèse vocale. Un rappel programmé par écrit
  // est quand même annoncé à voix haute par le pipeline vocal, comme un rappel programmé à la voix.
  ipcMain.handle(IPC_CHANNELS.sendChatMessage, (event, prompt: string, imageBase64?: string): Promise<ChatMessage> => {
    return chatSession.send(
      prompt,
      (message) => void pipeline?.announceReminder(message),
      (message) => broadcast(IPC_CHANNELS.log, message),
      (cue: SoundCue) => broadcast(IPC_CHANNELS.soundCue, cue),
      (delta) => event.sender.send(IPC_CHANNELS.chatStreamToken, delta),
      imageBase64
    )
  })
  ipcMain.handle(IPC_CHANNELS.getChatHistory, (): Promise<ChatMessage[]> => chatSession.getVisibleMessages())

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
  ipcMain.handle(IPC_CHANNELS.pickImageFile, async (): Promise<PickedImageFile | null> => {
    const dialogOptions = {
      properties: ['openFile' as const],
      title: 'Choisir une image à envoyer à Jaris',
      filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES_BY_EXTENSION) }]
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
  ipcMain.handle(IPC_CHANNELS.openGeneratedApp, async (_event, path?: string) => {
    await shell.openPath(path || getGeneratedAppsDir())
  })
  ipcMain.handle(IPC_CHANNELS.getGeneratedApps, (): Promise<GeneratedAppSummary[]> => listGeneratedApps())
  ipcMain.handle(IPC_CHANNELS.deleteGeneratedApp, (_event, path: string) => deleteGeneratedApp(path))
  ipcMain.handle(IPC_CHANNELS.loadGeneratedApp, async (_event, path: string): Promise<GeneratedApp> => {
    const loaded = await loadGeneratedApp(path)
    return { ...loaded, previewUrl: createGeneratedAppPreview(loaded.html) }
  })

  ipcMain.on(IPC_CHANNELS.onboardingFinished, () => {
    // L'onboarding vient de se terminer dans la fenêtre de réglages : elle bascule en widget flottant.
    onboardingDone = true
    fullWindow?.hide()
    showWidgetWindow()
  })
  ipcMain.on(IPC_CHANNELS.openSettings, () => showFullWindow())

  // Gardé en variable de module : sans référence, Electron peut ramasser l'icône par le garbage collector
  // et la faire disparaître de la barre système.
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Jaris')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Jaris', click: () => showFullWindow() },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showFullWindow())

  /**
   * Raccourci global (pas seulement quand la fenêtre de Jaris a le focus) : déclenche l'écoute depuis
   * n'importe quelle appli, comme le mot d'activation (déjà global car basé sur le micro).
   * Diagnostic explicite à chaque étape (succès/échec d'enregistrement, puis déclenchement réel) : sinon
   * impossible de distinguer "le raccourci ne s'enregistre pas" de "il s'enregistre mais rien ne se passe
   * au moment d'appuyer" (ex: pipeline vocal pas encore prêt) juste en testant à l'aveugle. Une fois
   * enregistré avec succès, Electron/Windows donnent l'exclusivité totale sur cette touche à Jaris quelle
   * que soit l'appli active : il n'y a rien de plus à "prioriser" à ce niveau-là.
   *
   * globalShortcut.register() peut carrément lever une exception (pas juste renvoyer false) pour un
   * accelerator qu'il n'arrive pas à convertir en code touche natif — c'est le cas du caractère "+" tout
   * seul sur cette machine ("conversion failure from +"), ce qui plantait le démarrage entier de Jaris
   * (exception non rattrapée dans app.whenReady().then(...)). D'où le try/catch : un raccourci qui échoue
   * à s'enregistrer ne doit jamais empêcher Jaris de démarrer.
   */
  function registerWakeShortcut(key: string): void {
    try {
      const registered = globalShortcut.register(key, () => {
        console.log(`[jaris] Raccourci global ${key} déclenché (pipeline ${pipeline ? 'prêt' : 'PAS prêt'}).`)
        // Options → Activation (étape 81) : ce raccourci est un enregistrement GLOBAL côté main process,
        // totalement indépendant du handleKeyDown du renderer (App.tsx, qui ne voit jamais cette touche
        // quand Jaris n'a pas le focus) — sans ce même contrôle ici, décocher "touche +" dans Options
        // n'avait aucun effet dès que la fenêtre de Jaris n'était pas la fenêtre active (signalé par Léo :
        // "je desactive le plus je fait plus sa sactive").
        void getProfile().then((profile) => {
          if (profile?.activationKeyEnabled === false) return
          triggerVisibleWake()
        })
      })
      if (registered) {
        console.log(`[jaris] Raccourci global ${key} enregistré avec succès.`)
      } else {
        console.warn(
          `[jaris] Impossible de réserver le raccourci global ${key} (déjà pris par une autre appli, ou par une ancienne instance de Jaris encore ouverte en arrière-plan).`
        )
      }
    } catch (err) {
      console.warn(`[jaris] Raccourci global ${key} invalide sur ce clavier : ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Le caractère "+" seul n'est pas un accelerator valide pour globalShortcut sur cette machine (voir
  // ci-dessus) : "numadd", la touche + du pavé numérique, est un code touche distinct et stable (pas
  // d'ambiguïté d'agencement clavier) — visuellement c'est quand même la touche "+" cherchée à l'origine.
  registerWakeShortcut('numadd')

  // Après la première configuration, aucun panneau ne s'impose au démarrage : Jaris écoute en arrière-plan
  // et la barre apparaît seulement avec « Jaris » ou +. L'onboarding reste visible au premier lancement.
  const profile = await getProfile()
  onboardingDone = Boolean(profile?.capacityScanDone)
  fullWindow = createFullWindow(!onboardingDone)

  // Widget pré-créé et chargé en arrière-plan dès le démarrage (caché) : sans ça, la première fois qu'on
  // réduit la fenêtre, il fallait créer la fenêtre Electron ET charger toute la page React avant de
  // pouvoir l'afficher, ce qui se voyait clairement comme un délai. Là, il ne reste plus qu'à le
  // positionner et l'afficher (quasi instantané).
  if (onboardingDone) {
    widgetWindow = createWidgetWindow()
    // Une fois Jaris hors de sa fenêtre principale, son état inactif reste visible en haut au centre dès le
    // démarrage : petit orbe en Vocal, petit indicateur Chat dans ce mode. La création reste préchargée pour
    // éviter un flash blanc avant que React ait peint la bonne forme.
    widgetWindow.once('ready-to-show', () => showWidgetWindow())
  }

  void startVoicePipeline()
})

// Se déclenche une seule fois quel que soit le chemin de sortie (Quitter dans la barre système,
// window-all-closed...), avant que les fenêtres ne se ferment : le bon endroit pour arrêter proprement ce
// que Jaris a lui-même démarré, plutôt qu'un process qui continue de tourner indéfiniment en arrière-plan.
app.on('before-quit', () => {
  stopOllamaIfStartedByJaris()
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
