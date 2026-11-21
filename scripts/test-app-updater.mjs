import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import nodeChildProcess from 'node:child_process'
import nodeEvents from 'node:events'
import nodeFs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath, { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/appUpdater.ts — le bouton "Mettre à jour" de Jaris (Options → Mise à jour).
 *
 * Léo : "quand on demande une mise à jour on ne sait pas quand c'est terminé et des fois c'est bloqué et ça
 * fait rien". Deux garanties verrouillées ici, les deux invérifiables par relecture :
 *  1. l'avancement remonte vraiment jusqu'à l'interface (phase 'download' puis 'install') ;
 *  2. Jaris ne se ferme JAMAIS sur un installeur incomplet. C'était le pire des cas : Jaris quittait, un
 *     .exe tronqué se lançait sans rien faire de visible, et il n'y avait plus personne pour l'expliquer.
 *
 * Aucune vraie fenêtre Electron ici : `app` est simulé, mais le téléchargement (download.ts) et le disque
 * sont RÉELS — c'est justement ce qui permet de vérifier le fichier écrit.
 */
function loadModule(relativePath, requireShim) {
  const source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, withI18n(requireShim))
  return exports
}

const sharedFormat = loadModule('../shared/formatBytes.ts', () => ({}))
const downloadModule = loadModule('../electron/services/download.ts', (id) => {
  if (id === 'fs') return nodeFs
  if (id === 'fs/promises') return nodeFsPromises
  if (id === 'events') return nodeEvents
  if (id === 'path') return nodePath
  if (id.endsWith('formatBytes')) return sharedFormat
  throw new Error(`module non simulé dans le test : ${id}`)
})

const fakeTmp = mkdtempSync(join(tmpdir(), 'jaris-updater-'))
const electronApp = {
  getVersion: () => '0.8.1',
  quit: () => {
    electronApp.quitCalls += 1
  },
  once: (event, handler) => {
    electronApp.handlers[event] = handler
  },
  quitCalls: 0,
  handlers: {}
}
const spawned = []
// Étape 512 : la version Store demande au Microsoft Store (script PowerShell) — réponse simulée ici.
let storeRun = async () => ({ error: null, stdout: '{"updates":[]}' })
const storeScripts = []

const { checkForUpdate, updateApp, parseStoreAnswer, STORE_UPDATE_SCRIPT } = loadModule('../electron/services/appUpdater.ts', (id) => {
  if (id.endsWith('/inputControl')) {
    return {
      runPowerShellScript: (script, env, idleMs) => {
        storeScripts.push({ script, idleMs })
        return storeRun(script)
      }
    }
  }
  if (id === 'electron') return { app: electronApp }
  if (id === 'child_process') {
    return {
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        return { on: () => ({ unref: () => {} }), unref: () => {} }
      }
    }
  }
  if (id.endsWith('/storageRoot')) return { downloadsDir: () => fakeTmp }
  if (id === 'path') return nodePath
  if (id.endsWith('/download')) return downloadModule
  throw new Error(`module non simulé dans le test : ${id}`)
})

const ASSET_URL = 'https://exemple/Jaris-Setup-0.9.0.exe'
let installerChunks = []
let announcedSize

/** GitHub (l'API des Releases) et le serveur de fichiers, tous les deux simulés sur la même fonction. */
globalThis.fetch = (url) => {
  if (String(url).includes('api.github.com')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          tag_name: 'v0.9.0',
          assets: [{ name: 'Jaris-Setup-0.9.0.exe', browser_download_url: ASSET_URL }]
        })
    })
  }
  const queue = [...installerChunks]
  const total = announcedSize ?? installerChunks.reduce((sum, c) => sum + c.length, 0)
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(total) : null) },
    body: {
      getReader: () => ({
        read: () => Promise.resolve(queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined })
      })
    }
  })
}

function reset() {
  electronApp.quitCalls = 0
  electronApp.handlers = {}
  spawned.length = 0
  announcedSize = undefined
}

test('une mise à jour rapporte son avancement, puis lance l\'installeur seulement en quittant', async () => {
  reset()
  installerChunks = [new Uint8Array(6000).fill(7), new Uint8Array(4000).fill(9)]
  const check = await checkForUpdate()
  assert.deepEqual(check.status, { current: '0.8.1', latest: '0.9.0', outdated: true })

  const progress = []
  let quittingFlag = false
  const result = await updateApp(
    () => {
      quittingFlag = true
    },
    (p) => progress.push(p)
  )

  assert.equal(result.success, true)
  // Nommé d'après la version : un reste verrouillé d'une tentative précédente ne bloque plus celle-ci.
  const installerPath = join(fakeTmp, 'Jaris-Setup-0.9.0.exe')
  assert.equal(readFileSync(installerPath).length, 10000)

  assert.ok(
    progress.some((p) => p.phase === 'download' && p.percent === 100 && p.receivedBytes === 10000),
    `aucun avancement de téléchargement complet : ${JSON.stringify(progress)}`
  )
  assert.equal(progress.at(-1).phase, 'install')

  // L'installeur NSIS refuse de s'installer par-dessus un Jaris encore ouvert : il ne doit donc démarrer
  // qu'une fois Jaris réellement en train de quitter, jamais à la fin du téléchargement.
  assert.equal(spawned.length, 0, "l'installeur a été lancé avant que Jaris ne quitte")
  assert.equal(quittingFlag, true)
  assert.equal(electronApp.quitCalls, 1)

  electronApp.handlers['will-quit']()
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, installerPath)
  // Étape 142 : l'installeur est assisté (choix du dossier) — une mise à jour doit rester SILENCIEUSE, dans le
  // dossier déjà choisi, et relancer Jaris. Sans ces arguments, tout l'assistant se rouvrirait à chaque fois.
  assert.equal(JSON.stringify(spawned[0].args), JSON.stringify(['/S', '--updated', '--force-run']))
})

test('un installeur incomplet ne ferme PAS Jaris et ne se lance jamais', async () => {
  reset()
  // Connexion coupée en route : GitHub annonce 10 000 octets, seuls 6 000 arrivent.
  installerChunks = [new Uint8Array(6000).fill(7)]
  announcedSize = 10000

  const progress = []
  let quittingFlag = false
  const result = await updateApp(
    () => {
      quittingFlag = true
    },
    (p) => progress.push(p)
  )

  assert.equal(result.success, false)
  assert.match(result.message, /incomplet/i)
  // Le message vient de download.ts, déjà rédigé pour Léo : jamais réhabillé en "Échec de la mise à jour :
  // The operation was aborted due to timeout", qui ne lui disait rien d'actionnable.
  assert.doesNotMatch(result.message, /Échec de la mise à jour/)
  assert.equal(quittingFlag, false, 'Jaris se serait fermé sur un installeur tronqué')
  assert.equal(electronApp.quitCalls, 0)
  assert.equal(electronApp.handlers['will-quit'], undefined)
  assert.equal(spawned.length, 0)
  assert.equal(existsSync(join(fakeTmp, 'Jaris-Setup-0.9.0.exe')), false, 'le fichier tronqué est resté sur le disque')
})

test.after(() => rmSync(fakeTmp, { recursive: true, force: true }))

// Étape 502 (Léo : « quand il y a une mise à jour du Store, ça met ou pas nouvelle version dispo ? ») : la version Store
// LIT la dernière Release pour l'annoncer, mais n'installe jamais rien elle-même (étape 491).
test('étape 491/502 : version Microsoft Store — la nouvelle version s’annonce, mais aucune installation par Jaris', async () => {
  reset()
  process.windowsStore = true
  storeRun = async () => ({ error: null, stdout: '{"updates":["0.9.0"]}' })
  try {
    const check = await checkForUpdate()
    assert.deepEqual(check.status, { current: '0.8.1', latest: '0.9.0', outdated: true }, 'la nouvelle version est annoncée')
    const result = await updateApp()
    assert.equal(result.success, false)
    assert.match(result.message, /Microsoft Store/)
    assert.equal(spawned.length, 0, 'aucun installeur lancé')
    assert.equal(electronApp.quitCalls, 0)
  } finally {
    delete process.windowsStore
  }
})

// Étape 512 (capture de Léo : « Jaris 0.75.3 est sorti… il arrive par le Microsoft Store » alors que Microsoft ne
// l'avait pas encore validé) : la version Store ne lit plus GitHub, elle demande au Store lui-même.
test('étape 512 : version Store — Release sur GitHub mais rien dans le Store = aucune annonce ; GitHub n’est jamais lu', async () => {
  reset()
  process.windowsStore = true
  const realFetch = globalThis.fetch
  let githubAsked = 0
  globalThis.fetch = (url) => {
    if (String(url).includes('api.github.com')) githubAsked++
    return realFetch(url)
  }
  storeRun = async () => ({ error: null, stdout: '{"updates":[]}' })
  storeScripts.length = 0
  try {
    const check = await checkForUpdate()
    assert.deepEqual(check, { status: { current: '0.8.1', latest: '0.8.1', outdated: false }, error: null }, 'pas encore validée par Microsoft : rien à annoncer')
    assert.equal(githubAsked, 0, 'la version Store ne demande jamais à GitHub')
    assert.equal(storeScripts.length, 1)
    assert.match(storeScripts[0].script, /GetAppAndOptionalStorePackageUpdatesAsync/)
    assert.ok(storeScripts[0].idleMs >= 60_000, 'le Store peut mettre du temps à répondre : surveillance par inactivité large')
    // Plusieurs paquets proposés (ex. un ancien et le dernier) : la plus récente, jamais une plus vieille que l'actuelle.
    storeRun = async () => ({ error: null, stdout: 'bruit\r\n{"updates":["0.8.0","0.9.2","0.9.1"]}\r\n' })
    assert.deepEqual((await checkForUpdate()).status, { current: '0.8.1', latest: '0.9.2', outdated: true })
    // PowerShell 5.1 peut sérialiser un seul élément sans tableau.
    storeRun = async () => ({ error: null, stdout: '{"updates":"0.9.0"}' })
    assert.equal((await checkForUpdate()).status.latest, '0.9.0')
    // Erreur du Store : le vrai message, jamais une annonce.
    storeRun = async () => ({ error: null, stdout: '{"error":"Le service du Store est indisponible."}' })
    const failed = await checkForUpdate()
    assert.equal(failed.status, null)
    assert.match(failed.error, /Microsoft Store.*Le service du Store est indisponible\./)
    storeRun = async () => ({ error: 'PowerShell ne répond plus depuis 90 s.', stdout: '' })
    assert.match((await checkForUpdate()).error, /PowerShell ne répond plus/)
  } finally {
    delete process.windowsStore
    globalThis.fetch = realFetch
  }
})

test('étape 512 : la réponse du Store est lue sans jamais planter', () => {
  assert.deepEqual(parseStoreAnswer('{"updates":[]}'), { updates: [] })
  assert.deepEqual(parseStoreAnswer('{"updates":null}'), { updates: [] })
  assert.deepEqual(parseStoreAnswer('{"error":"x"}'), { error: 'x' })
  assert.equal(parseStoreAnswer(''), null)
  assert.equal(parseStoreAnswer('{pas du json'), null)
})

const powershellExe = process.platform === 'win32' ? 'powershell' : null
test('étape 512 : sur Windows, le script du Store est du PowerShell valide et répond toujours en JSON (même hors paquet)', { skip: powershellExe ? false : 'Windows seulement (vérifié par la CI)' }, () => {
  const out = nodeChildProcess.execFileSync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', STORE_UPDATE_SCRIPT], { encoding: 'utf8', timeout: 120_000 })
  const answer = parseStoreAnswer(out)
  assert.ok(answer, `réponse illisible : ${out}`)
  // Hors du paquet (la CI), le Store répond en général par une erreur — rendue en JSON, jamais un plantage du script.
  if ('error' in answer) assert.ok(answer.error.length > 0)
  else assert.ok(Array.isArray(answer.updates))
})

test('étape 491 : la Release porte aussi le paquet du Store — la mise à jour habituelle prend toujours le .exe', async () => {
  reset()
  const realFetch = globalThis.fetch
  globalThis.fetch = (url) =>
    String(url).includes('api.github.com')
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              tag_name: 'v0.9.0',
              assets: [
                { name: 'Jaris-Store-0.9.0.msix', browser_download_url: 'https://exemple/Jaris-Store-0.9.0.msix' },
                { name: 'Jaris-Setup-0.9.0.exe', browser_download_url: ASSET_URL }
              ]
            })
        })
      : realFetch(url)
  try {
    const { status } = await checkForUpdate()
    assert.equal(status.outdated, true)
    installerChunks = [Buffer.from('MZ installeur')]
    const urls = []
    const before = globalThis.fetch
    globalThis.fetch = (url) => {
      urls.push(String(url))
      return before(url)
    }
    await updateApp(() => {})
    assert.ok(urls.includes(ASSET_URL), 'l’installeur .exe est téléchargé')
    assert.ok(!urls.some((u) => u.endsWith('.msix')), 'jamais le paquet du Store')
  } finally {
    globalThis.fetch = realFetch
  }
})
