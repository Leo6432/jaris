import { app, ipcMain, session, shell, BrowserWindow, globalShortcut, screen, Tray, Menu } from 'electron'
import { join } from 'path'
import {
  ensureOllamaRunning,
  ensureSearxngRunning,
  getOllamaVersionStatus,
  stopOllamaIfStartedByJaris,
  updateOllama
} from './services/dependencyServices'
import { getAllCandidateModelIds, getModelOverview, previewHardwareTiers } from './services/hardwareScan'
import { getConfirmableTools } from './services/toolSecurity'
import { importRealChromeProfile } from './services/browserControl'
import { getRuntimeSetupStatus, runFirstRunSetup } from './services/firstRunSetup'
import { runModelAnalysis, runQuickSetup } from './services/benchmarkRunner'
import { chatSession } from './services/chatSession'
import { generateApp, getGeneratedAppsDir } from './services/codeGenerator'
import { previewVoice } from './services/tts'
import { ttsClient } from './services/ttsClient'
import { createTrayIcon } from './services/trayIcon'
import { VoicePipeline } from './services/voicePipeline'
import { listAudioInputDevices } from './services/voiceClient'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, recallNote } from './services/memoryStore'
import {
  clearConversationHistory,
  ensureConversationHistoryFile,
  getConversationHistory,
  getConversationHistoryPath
} from './services/conversationStore'
import { getProfile, markGmailOnboardingDone, saveProfile } from './services/profileStore'
import { connectGmail, disconnectGmail, getGmailStatus } from './services/googleAuth'
import { clearSmtpConfig, getSmtpStatus, saveSmtpConfig } from './services/smtpStore'
import {
  IPC_CHANNELS,
  type AnalysisScope,
  type AudioInputDevice,
  type CapacityScanResult,
  type ChatMessage,
  type GeneratedApp,
  type JarisEmotion,
  type MemoryGraph,
  type Profile,
  type SmtpConfig,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload
} from '../shared/ipc'

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null
let fullWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** Passe à true seulement via le menu de la barre système "Quitter" : sinon fermer la fenêtre de réglages la cache juste, Jaris continue à tourner (widget + écoute du double clap). */
let quitting = false
/** Tant que l'onboarding n'est pas fini, fermer la fenêtre de réglages doit quitter l'appli normalement (pas de widget à replier sur un profil pas encore configuré). */
let onboardingDone = false

// Plus haut que large : le contenu (orbe + texte) reste ancré en bas de la fenêtre (voir .app--widget en
// CSS), donc collé au vrai coin bas-droit de l'écran au repos. Le reste de la hauteur, vide et transparent
// donc invisible tant qu'il n'y a rien à dire, sert de marge pour qu'une réponse longue pousse vers le
// haut sans être coupée.
const WIDGET_WIDTH = 320
const WIDGET_HEIGHT = 520
const WIDGET_MARGIN = 24

/**
 * Dernier statut connu du pipeline vocal, mis à jour uniquement par un vrai succès/échec de démarrage
 * (voir startVoicePipeline) — plus de pré-vérification de fichiers à faire depuis le retrait du mot
 * d'activation (openWakeWord) : la transcription/synthèse vocale se téléchargent déjà seules au besoin,
 * rien à vérifier avant de tenter de démarrer.
 */
let lastSetupStatus: VoiceSetupStatusPayload = { ready: true, missing: [] }

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
 * Fenêtre normale de Jaris (onboarding, orbe, conversation, Options, cerveau de Jaris) : c'est celle-là
 * qui s'ouvre au lancement, comme avant l'étape 19. La réduire ou fermer sa croix ne quitte pas Jaris :
 * ça la cache et fait apparaître le widget flottant à la place (voir `quitting`/`onboardingDone`).
 */
function createFullWindow(): BrowserWindow {
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

  win.on('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (quitting || !onboardingDone) return
    event.preventDefault()
    win.hide()
    showWidgetWindow()
  })
  // Pas de preventDefault possible sur 'minimize' (déjà fait quand l'évènement arrive) : on laisse
  // Windows réduire, puis on cache complètement la fenêtre (plus d'icône dans la barre des tâches) et
  // on montre le widget à la place.
  win.on('minimize', () => {
    if (!onboardingDone) return
    win.hide()
    showWidgetWindow()
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
 * fenêtres, en bas à droite de l'écran — visible même quand une autre appli (navigateur, jeu...) a le
 * focus. C'est la vue "toujours là" une fois l'onboarding terminé ; cliquer dessus ouvre la fenêtre de
 * réglages pour le reste (Options, cerveau de Jaris).
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
  // Pas d'auto-show ici (contrairement à la fenêtre normale) : le widget est créé caché dès le démarrage
  // (voir plus bas) pour être déjà chargé le jour où on réduit la fenêtre, et ne s'affiche que sur demande
  // via showWidgetWindow() — sinon il clignoterait à l'écran dès qu'il finit de charger, au lancement.
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'widget')
  return win
}

/** Recalcule la position en bas à droite de l'écran actuel : pas fixé une fois pour toutes à la création, au cas où l'écran/la zone de travail a changé depuis (résolution, second écran...). */
function positionWidgetWindow(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay()
  win.setBounds({
    x: workArea.x + workArea.width - WIDGET_WIDTH - WIDGET_MARGIN,
    y: workArea.y + workArea.height - WIDGET_HEIGHT - WIDGET_MARGIN,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT
  })
}

/** Les deux fenêtres ne sont jamais visibles en même temps (sinon double lecture audio des réponses). */
function showFullWindow(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
  if (!fullWindow || fullWindow.isDestroyed()) fullWindow = createFullWindow()
  fullWindow.show()
  fullWindow.focus()
}

function showWidgetWindow(): void {
  if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) return
  if (!widgetWindow || widgetWindow.isDestroyed()) widgetWindow = createWidgetWindow()
  positionWidgetWindow(widgetWindow)
  widgetWindow.show()
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
  pipeline.on('emotion', (emotion: JarisEmotion) => broadcast(IPC_CHANNELS.emotion, emotion))
  pipeline.on('transcript', (text: string) => broadcast(IPC_CHANNELS.transcript, text))
  pipeline.on('reply', (payload: VoiceReplyPayload) => broadcast(IPC_CHANNELS.reply, payload))
  pipeline.on('log', (message: string) => broadcast(IPC_CHANNELS.log, message))
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
    await pipeline.start(profile?.audioInputDeviceIndex)
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
  // Autorise silencieusement l'accès micro pour les fenêtres de Jaris (enumerateDevices() ne révèle les
  // vrais noms de périphériques audio qu'après une permission media accordée, voir Options → Voix) : sans
  // ce handler, Chromium afficherait une popup de permission native, déroutante dans une appli de bureau
  // qui n'a jamais utilisé getUserMedia() jusqu'ici (le micro est capturé côté Python, pas par le renderer).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.handle(IPC_CHANNELS.setupStatus, () => lastSetupStatus)
  ipcMain.on(IPC_CHANNELS.triggerWake, () => pipeline?.triggerWake())
  ipcMain.on(IPC_CHANNELS.audioEnded, () => pipeline?.notifyAudioEnded())
  ipcMain.handle(IPC_CHANNELS.getProfile, () => getProfile())
  ipcMain.handle(IPC_CHANNELS.saveProfile, (_event, profile: Profile) => saveProfile(profile))
  ipcMain.handle(IPC_CHANNELS.markGmailOnboardingDone, () => markGmailOnboardingDone())
  ipcMain.handle(IPC_CHANNELS.openMemoryFolder, async () => {
    await ensureMemoryDir()
    await shell.openPath(getMemoryDir())
  })
  ipcMain.handle(IPC_CHANNELS.getMemoryGraph, () => buildMemoryGraphWithUser())
  ipcMain.handle(IPC_CHANNELS.getMemoryNoteContent, (_event, title: string) => recallNote(title))
  // Limite large plutôt que sans limite : le fichier lui-même est déjà borné (MAX_HISTORY_ENTRIES dans
  // conversationStore.ts), une vraie limite ici n'aurait de sens que si l'onglet Historique devait un jour
  // paginer.
  ipcMain.handle(IPC_CHANNELS.getConversationHistory, () => getConversationHistory(300))
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
  ipcMain.handle(IPC_CHANNELS.getGmailStatus, () => getGmailStatus())
  ipcMain.handle(IPC_CHANNELS.connectGmail, () => connectGmail())
  ipcMain.handle(IPC_CHANNELS.disconnectGmail, () => disconnectGmail())
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
  ipcMain.on(IPC_CHANNELS.testMicrophone, () => pipeline?.testMic())
  ipcMain.on(IPC_CHANNELS.stopTestMicrophone, () => pipeline?.stopTestMic())
  ipcMain.handle(IPC_CHANNELS.getModelOverview, () => getModelOverview())
  ipcMain.handle(IPC_CHANNELS.getConfirmableTools, () => getConfirmableTools())
  ipcMain.handle(IPC_CHANNELS.getOllamaVersionStatus, () => getOllamaVersionStatus())
  ipcMain.handle(IPC_CHANNELS.updateOllama, () => updateOllama())
  ipcMain.handle(IPC_CHANNELS.importChromeProfile, () => importRealChromeProfile())
  ipcMain.handle(IPC_CHANNELS.getSmtpStatus, () => getSmtpStatus())
  ipcMain.handle(IPC_CHANNELS.saveSmtpConfig, (_event, smtpConfig: SmtpConfig) => saveSmtpConfig(smtpConfig))
  ipcMain.handle(IPC_CHANNELS.disconnectSmtp, () => clearSmtpConfig())
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
  ipcMain.handle(IPC_CHANNELS.previewHardwareTiers, () => previewHardwareTiers())
  ipcMain.handle(IPC_CHANNELS.runQuickSetup, async (event): Promise<CapacityScanResult> => {
    return runQuickSetup((line) => event.sender.send(IPC_CHANNELS.modelBenchmarkLine, line))
  })

  // Mode Chat (étape 30) : même Jaris, mêmes outils, sans synthèse vocale. Un rappel programmé par écrit
  // est quand même annoncé à voix haute par le pipeline vocal, comme un rappel programmé à la voix.
  ipcMain.handle(IPC_CHANNELS.sendChatMessage, (_event, prompt: string): Promise<ChatMessage> => {
    return chatSession.send(
      prompt,
      (message) => void pipeline?.announceReminder(message),
      (message) => broadcast(IPC_CHANNELS.log, message)
    )
  })
  ipcMain.handle(IPC_CHANNELS.getChatHistory, (): ChatMessage[] => chatSession.getVisibleMessages())

  // Mode Code (étape 30) : génération d'une application autonome, avec avancement au fil de l'eau (la
  // génération + relecture peut prendre plusieurs minutes sur un modèle local).
  ipcMain.handle(
    IPC_CHANNELS.generateApp,
    (event, description: string, currentHtml?: string): Promise<GeneratedApp> => {
      return generateApp(
        description,
        (message) => event.sender.send(IPC_CHANNELS.codeGenStatus, message),
        currentHtml
      )
    }
  )
  ipcMain.handle(IPC_CHANNELS.openGeneratedApp, async (_event, path?: string) => {
    await shell.openPath(path || getGeneratedAppsDir())
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
   * n'importe quelle appli, comme le double clap (déjà global car basé sur le micro).
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
        pipeline?.triggerWake()
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

  // Toujours lancée dans sa fenêtre normale, comme avant l'étape 19 : la réduire ou la fermer bascule
  // ensuite vers le widget (voir createFullWindow), mais le lancement lui-même ne change pas.
  const profile = await getProfile()
  onboardingDone = Boolean(profile?.capacityScanDone)
  fullWindow = createFullWindow()

  // Widget pré-créé et chargé en arrière-plan dès le démarrage (caché) : sans ça, la première fois qu'on
  // réduit la fenêtre, il fallait créer la fenêtre Electron ET charger toute la page React avant de
  // pouvoir l'afficher, ce qui se voyait clairement comme un délai. Là, il ne reste plus qu'à le
  // positionner et l'afficher (quasi instantané).
  if (onboardingDone) widgetWindow = createWidgetWindow()

  void startVoicePipeline()
})

// Se déclenche une seule fois quel que soit le chemin de sortie (Quitter dans la barre système,
// window-all-closed...), avant que les fenêtres ne se ferment : le bon endroit pour arrêter proprement ce
// que Jaris a lui-même démarré, plutôt qu'un process qui continue de tourner indéfiniment en arrière-plan.
app.on('before-quit', () => {
  stopOllamaIfStartedByJaris()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  pipeline?.stop()
  ttsClient.stop()
  app.quit()
})
