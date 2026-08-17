import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { checkVoiceSetup } from './config'
import { ensureOllamaRunning, ensureSearxngRunning } from './services/dependencyServices'
import { previewVoice } from './services/tts'
import { ttsClient } from './services/ttsClient'
import { VoicePipeline } from './services/voicePipeline'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, recallNote } from './services/memoryStore'
import { getProfile, markGmailOnboardingDone, saveProfile } from './services/profileStore'
import { connectGmail, disconnectGmail, getGmailStatus } from './services/googleAuth'
import {
  IPC_CHANNELS,
  type JarisEmotion,
  type MemoryGraph,
  type Profile,
  type VoiceReplyPayload,
  type VoiceSetupStatusPayload
} from '../shared/ipc'

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null

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

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

async function startVoicePipeline(mainWindow: BrowserWindow): Promise<void> {
  const status = currentSetupStatus()
  const send = (channel: string, payload?: unknown): void => {
    if (channel === IPC_CHANNELS.log) console.log('[jaris]', payload)
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  const log = (message: string): void => send(IPC_CHANNELS.log, message)
  void ensureOllamaRunning(log)
  void ensureSearxngRunning(log)

  if (!status.ready) {
    send(IPC_CHANNELS.setupStatus, status)
    send(IPC_CHANNELS.log, `Configuration incomplète : ${status.missing.join(' | ')}`)
    return
  }

  pipeline = new VoicePipeline()
  pipeline.on('emotion', (emotion: JarisEmotion) => send(IPC_CHANNELS.emotion, emotion))
  pipeline.on('transcript', (text: string) => send(IPC_CHANNELS.transcript, text))
  pipeline.on('reply', (payload: VoiceReplyPayload) => send(IPC_CHANNELS.reply, payload))
  pipeline.on('log', (message: string) => send(IPC_CHANNELS.log, message))

  try {
    await pipeline.start()
    send(IPC_CHANNELS.setupStatus, status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send(IPC_CHANNELS.log, `Échec du démarrage du pipeline vocal : ${message}`)
    send(IPC_CHANNELS.setupStatus, { ready: false, missing: [message] })
  }
}

app.whenReady().then(() => {
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
  ipcMain.handle(IPC_CHANNELS.getGmailStatus, () => getGmailStatus())
  ipcMain.handle(IPC_CHANNELS.connectGmail, () => connectGmail())
  ipcMain.handle(IPC_CHANNELS.disconnectGmail, () => disconnectGmail())
  ipcMain.handle(IPC_CHANNELS.previewVoice, async (_event, voice: string) => {
    const audio = await previewVoice(voice)
    return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
  })
  const mainWindow = createWindow()
  void startVoicePipeline(mainWindow)
})

app.on('window-all-closed', () => {
  pipeline?.stop()
  ttsClient.stop()
  app.quit()
})
