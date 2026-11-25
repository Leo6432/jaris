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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

/**
 * Étape 466 (campagne de code de Léo du 11/11, 37 modèles) : depuis l'étape 368, l'aperçu de Jaris remplace
 * localStorage/sessionStorage, refusés dans l'iframe isolée, par une mémoire tenue le temps de l'aperçu
 * (MEMORY_STORAGE_SCRIPT, generatedAppPreview.ts) — et la consigne du mode Code DEMANDE localStorage. Le test, lui,
 * laissait le refus : une liste de tâches qui enregistre (dans un try/catch, comme demandé) perdait chaque tâche et
 * comptait fausse alors qu'elle marche dans Jaris (qwen3.8:27b, qwen3.6:27b, ornith-1.5:9b…). Copie EXACTE du script
 * de l'aperçu (sans les balises), vérifiée par test-benchmark-code.mjs, ajoutée après le refus comme dans Jaris.
 */
export const PREVIEW_MEMORY_STORAGE_SOURCE =
  '(function(){function m(){var d=Object.create(null),s={' +
  'getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},' +
  'removeItem:function(k){delete d[String(k)]},clear:function(){for(var k in d)delete d[k]},' +
  'key:function(i){var k=Object.keys(d);return i>=0&&i<k.length?k[i]:null}};' +
  "Object.defineProperty(s,'length',{get:function(){return Object.keys(d).length}});return s}" +
  "['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('jaris')}catch(e){" +
  'try{Object.defineProperty(window,n,{configurable:true,value:m()})}catch(e2){}}})})();'

/**
 * Lance le navigateur invisible et renvoie une page pilotable. Toujours appeler close().
 *
 * Étape 525 (Léo, version Store : « le navigateur s'est fermé dès son lancement (code 0) », test de code impossible) :
 * dans un paquet du Store, Windows range à part ce que Jaris écrit dans AppData — le dossier temporaire compris — et
 * Edge, lancé depuis le paquet, peut passer la main à un autre processus (sortie « code 0 ») qui ne voit pas ce dossier
 * rangé à part. D'où : `profileRoot` (JARIS_BROWSER_PROFILE_ROOT, donné par Jaris : son dossier de données, hors
 * d'AppData, dans la version Store), et une sortie « code 0 » qui n'est plus un échec : on attend le port de contrôle
 * du navigateur qui a pris la suite, puis on le ferme par ce port (il n'est pas notre processus).
 */
export async function openBrowser(browserPath, { profileRoot = process.env.JARIS_BROWSER_PROFILE_ROOT || tmpdir() } = {}) {
  mkdirSync(profileRoot, { recursive: true })
  const profile = mkdtempSync(join(profileRoot, 'jaris-navigateur-'))
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
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  )
  let exited = false
  // Étape 523 (Léo, 0.78.0 : « le navigateur s'est fermé dès son lancement », sans rien de plus) : le code de sortie et
  // la fin de ce que le navigateur a écrit disent POURQUOI — jamais un arrêt muet.
  let exitInfo = ''
  let stderrTail = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000)
  })
  proc.on('exit', (code, signal) => {
    exited = true
    exitInfo = signal ? `signal ${signal}` : `code ${code}`
  })
  proc.on('error', (err) => {
    exited = true
    exitInfo = err.message
  })
  const why = () => {
    const lines = stderrTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' / ')
    return [exitInfo, lines.slice(0, 300)].filter(Boolean).join(' : ')
  }

  let port = null
  let handedOff = false
  /** Ferme le navigateur par son port de contrôle (« Browser.close ») : celui qui a pris la suite n'est pas notre processus. */
  const closeThroughPort = async () => {
    if (!port) return
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json()
      const browserSocket = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        browserSocket.onopen = resolve
        browserSocket.onerror = reject
        setTimeout(reject, 2000)
      })
      browserSocket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await sleep(500)
      browserSocket.close()
    } catch {
      /* déjà fermé */
    }
  }
  const close = async () => {
    try {
      socket?.close()
    } catch {
      /* déjà fermé */
    }
    if (handedOff) await closeThroughPort()
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
      if (exited && !handedOff) {
        // Laisse arriver le code de sortie et les derniers messages (ils suivent la fin du processus de peu).
        await sleep(200)
        // Étape 525 : « code 0 » = passé la main à un autre processus du navigateur — on attend son port de contrôle.
        if (exitInfo === 'code 0') handedOff = true
        else throw new Error(`le navigateur s’est fermé dès son lancement${why() ? ` (${why()})` : ''}`)
      }
      if (Date.now() > deadline) {
        throw new Error(handedOff ? 'le navigateur a passé la main à un autre processus (code 0), qui n’a pas ouvert son port de contrôle en 30 s' : 'le navigateur n’a pas démarré en 30 s')
      }
      await sleep(100)
      content = readPortFile()
    }
    port = Number(content.split('\n')[0])
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
    // ne s'affiche, et localStorage refuse tout accès — puis l'aperçu le remplace par une mémoire (étape 466).
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "window.alert = () => {}; window.confirm = () => false; window.prompt = () => null; " +
        "Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Accès refusé (aperçu isolé)', 'SecurityError') } });" +
        "Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Accès refusé (aperçu isolé)', 'SecurityError') } });" +
        // Étape 466 : puis la mémoire de l'aperçu de Jaris, exactement comme dans l'application.
        PREVIEW_MEMORY_STORAGE_SOURCE
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
