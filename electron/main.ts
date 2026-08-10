import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'

const isDev = !app.isPackaged

function createWindow(): void {
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
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
