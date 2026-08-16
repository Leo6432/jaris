import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { checkVoiceSetup } from './config'
import { VoicePipeline } from './services/voicePipeline'
import { ensureMemoryDir, getMemoryDir, getMemoryGraph, recallNote } from './services/memoryStore'
import { getProfile, saveProfile } from './services/profileStore'
import { IPC_CHANNELS, type JarisEmotion, type Profile, type VoiceReplyPayload, type VoiceSetupStatusPayload } from '../shared/ipc'

const isDev = !app.isPackaged
let pipeline: VoicePipeline | null = null

function currentSetupStatus(): VoiceSetupStatusPayload {
  const status = checkVoiceSetup()
  return { ready: status.wakewordReady && status.piperReady, missing: status.missing }
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
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

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
  ipcMain.handle(IPC_CHANNELS.openMemoryFolder, async () => {
    await ensureMemoryDir()
    await shell.openPath(getMemoryDir())
  })
  ipcMain.handle(IPC_CHANNELS.getMemoryGraph, () => getMemoryGraph())
  ipcMain.handle(IPC_CHANNELS.getMemoryNoteContent, (_event, title: string) => recallNote(title))
  const mainWindow = createWindow()
  void startVoicePipeline(mainWindow)
})

app.on('window-all-closed', () => {
  pipeline?.stop()
  app.quit()
})
