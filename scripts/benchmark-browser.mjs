/**
 * Ouvrir pour de vrai une application générée et cliquer dedans (étape 232, test de code version 2). L'ancien test
 * de code ne vérifiait que l'allure du fichier HTML : tous les modèles y faisaient 3/3, même quand les boutons ne
 * marchaient pas — exactement ce que Léo a vécu (« les boutons marchent jamais »).
 *
 * Le script de test tourne dans le Node de Jaris (ELECTRON_RUN_AS_NODE), sans fenêtre ni navigateur à lui. Il
 * pilote donc le navigateur déjà présent sur la machine — Microsoft Edge, installé avec Windows (Chrome à défaut) —
 * en mode invisible (« headless »), par son protocole de débogage (CDP) et le WebSocket intégré à Node. Aucune
 * dépendance à installer. Ici (Linux), le même code pilote Chromium : JARIS_BROWSER_PATH.
 *
 * Comme dans l'aperçu de Jaris (iframe sans `allow-modals`), alert/confirm/prompt ne s'affichent pas : une
 * application qui confirme une action par une alerte ne montre RIEN à Léo, elle est donc comptée fausse.
 */
import { spawn, execFile } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

/** Taille de la page : proche de l'aperçu du mode Code dans une fenêtre de Jaris ordinaire. */
const VIEWPORT = { width: 1000, height: 680 }
const STEP_TIMEOUT_MS = 20000

/** Le navigateur à piloter : variable d'environnement, sinon Edge puis Chrome aux emplacements standard de Windows. */
export function findBrowser(env = process.env) {
  if (env.JARIS_BROWSER_PATH) return existsSync(env.JARIS_BROWSER_PATH) ? env.JARIS_BROWSER_PATH : null
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)
  const candidates = [
    ...roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lance le navigateur invisible et renvoie une page pilotable. Toujours appeler close(). */
export async function openBrowser(browserPath) {
  const profile = mkdtempSync(join(tmpdir(), 'jaris-navigateur-'))
  const proc = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      // Linux en administrateur (environnement de développement) : Chromium refuse sinon de démarrer. Jamais sous Windows.
      ...(process.platform !== 'win32' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  let exited = false
  proc.on('exit', () => (exited = true))
  proc.on('error', () => (exited = true))

  const close = async () => {
    try {
      socket?.close()
    } catch {
      /* déjà fermé */
    }
    if (!exited) {
      // Sous Windows, Edge lance des sous-processus : on arrête tout l'arbre.
      if (process.platform === 'win32') await new Promise((r) => execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => r()))
      else proc.kill('SIGKILL')
    }
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await sleep(300) // fichiers encore verrouillés quelques instants après l'arrêt
      }
    }
  }

  let socket
  try {
    // Le navigateur écrit son port de débogage dans ce fichier dès qu'il est prêt.
    const portFile = join(profile, 'DevToolsActivePort')
    // Sous Windows, le fichier reste verrouillé quelques instants pendant qu'Edge l'écrit (EBUSY, vu sur la CI
    // Windows le 04/10/2026) : une lecture refusée veut seulement dire « pas encore prêt ».
    const readPortFile = () => {
      try {
        return existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''
      } catch {
        return ''
      }
    }
    const deadline = Date.now() + 30000
    let content = readPortFile()
    while (!content.includes('\n')) {
      if (exited) throw new Error('le navigateur s’est fermé dès son lancement')
      if (Date.now() > deadline) throw new Error('le navigateur n’a pas démarré en 30 s')
      await sleep(100)
      content = readPortFile()
    }
    const port = Number(content.split('\n')[0])
    let pageWs
    for (let i = 0; i < 50 && !pageWs; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      pageWs = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl
      if (!pageWs) await sleep(100)
    }
    if (!pageWs) throw new Error('aucune page dans le navigateur')

    socket = new WebSocket(pageWs)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error('connexion au navigateur impossible'))
    })
    let nextId = 1
    const pending = new Map()
    const listeners = []
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) for (const l of listeners) l(msg)
    }
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`l'application ne répond plus (${method})`))
        }, STEP_TIMEOUT_MS)
      })

    const errors = []
    listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text)
    })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    // Comme dans l'aperçu de Jaris (iframe « allow-scripts allow-forms », origine opaque) : aucune boîte de dialogue
    // ne s'affiche, et localStorage refuse tout accès.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "window.alert = () => {}; window.confirm = () => false; window.prompt = () => null; " +
        "Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Accès refusé (aperçu isolé)', 'SecurityError') } });"
    })

    const page = {
      errors,
      async loadHtml(html) {
        const file = join(profile, 'application.html')
        writeFileSync(file, html, 'utf8')
        const loaded = new Promise((resolve) => listeners.push((m) => m.method === 'Page.loadEventFired' && resolve()))
        await send('Page.navigate', { url: pathToFileURL(file).href })
        await Promise.race([loaded, sleep(10000)])
        await sleep(300)
      },
      /** Évalue une expression dans la page et renvoie sa valeur (JSON). */
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
        return result.result.value
      },
      async click(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await sleep(250)
      },
      /** Molette de la souris : fait défiler la page comme un humain (rien ne bouge si la page l'interdit). */
      async wheel(x, y, deltaY) {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
        await sleep(150)
      },
      async insertText(text) {
        await send('Input.insertText', { text })
        await sleep(100)
      },
      async pressEnter() {
        for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
        await sleep(250)
      }
    }
    return { page, close }
  } catch (err) {
    await close()
    throw err
  }
}
