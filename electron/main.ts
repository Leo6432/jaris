import { app, ipcMain, shell, BrowserWindow, globalShortcut, screen, Tray, Menu } from 'electron'
import { join } from 'path'
import { checkVoiceSetup } from './config'
import { ensureOllamaRunning, ensureSearxngRunning } from './services/dependencyServices'
import { scanCapacity } from './services/hardwareScan'
import { pullModelIfMissing } from './services/ollama'
import { previewVoice } from './services/tts'
import { ttsClient } from './services/ttsClient'
import { createTrayIcon } from './services/trayIcon'
import { VoicePipeline } from './services/voicePipeline'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, recallNote } from './services/memoryStore'
import {
  clearConversationHistory,
  ensureConversationHistoryFile,
  getConversationHistory,
  getConversationHistoryPath
} from './services/conversationStore'
import { getProfile, markGmailOnboardingDone, saveProfile } from './services/profileStore'
import { connectGmail, disconnectGmail, getGmailStatus } from './services/googleAuth'
import {
  IPC_CHANNELS,
  type CapacityScanResult,
  type JarisEmotion,
  type MemoryGraph,
  type Profile,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload
} from '../shared/ipc'

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null
let fullWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** Passe à true seulement via le menu de la barre système "Quitter" : sinon fermer la fenêtre de réglages la cache juste, Jaris continue à tourner (widget + écoute du mot d'activation). */
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

function currentSetupStatus(): VoiceSetupStatusPayload {
  const status = checkVoiceSetup()
  return { ready: status.wakewordReady, missing: status.missing }
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
  const status = currentSetupStatus()
  const log = (message: string): void => broadcast(IPC_CHANNELS.log, message)
  void ensureOllamaRunning(log)
  void ensureSearxngRunning(log)

  if (!status.ready) {
    broadcast(IPC_CHANNELS.setupStatus, status)
    broadcast(IPC_CHANNELS.log, `Configuration incomplète : ${status.missing.join(' | ')}`)
    return
  }

  pipeline = new VoicePipeline()
  pipeline.on('emotion', (emotion: JarisEmotion) => broadcast(IPC_CHANNELS.emotion, emotion))
  pipeline.on('transcript', (text: string) => broadcast(IPC_CHANNELS.transcript, text))
  pipeline.on('reply', (payload: VoiceReplyPayload) => broadcast(IPC_CHANNELS.reply, payload))
  pipeline.on('log', (message: string) => broadcast(IPC_CHANNELS.log, message))
  // Arrêt d'urgence déclenché par la sécurité thermique GPU (voicePipeline/resourceMonitor) : un vrai
  // app.quit() (pas juste cacher la fenêtre, voir `quitting` plus haut), pour protéger la machine.
  pipeline.on('shutdown', () => {
    console.log('[jaris] Arrêt automatique : GPU en surchauffe.')
    quitting = true
    app.quit()
  })

  try {
    await pipeline.start()
    broadcast(IPC_CHANNELS.setupStatus, status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcast(IPC_CHANNELS.log, `Échec du démarrage du pipeline vocal : ${message}`)
    broadcast(IPC_CHANNELS.setupStatus, { ready: false, missing: [message] })
  }
}

app.whenReady().then(async () => {
  ipcMain.handle(IPC_CHANNELS.setupStatus, () => currentSetupStatus())
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
  ipcMain.handle(IPC_CHANNELS.scanCapacity, async (event): Promise<CapacityScanResult> => {
    const sendStatus = (message: string): void => event.sender.send(IPC_CHANNELS.capacityScanStatus, message)
    sendStatus('Détection de la carte graphique…')
    const result = await scanCapacity()
    const uniqueModels = [...new Set([result.models.flash, result.models.medium, result.models.large])]
    for (const model of uniqueModels) {
      await pullModelIfMissing(model, sendStatus)
    }
    return result
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
   * n'importe quelle appli, comme le mot d'activation "Hey Jarvis" (déjà global car basé sur le micro).
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  pipeline?.stop()
  ttsClient.stop()
  app.quit()
})
