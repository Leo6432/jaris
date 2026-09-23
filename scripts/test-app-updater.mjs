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
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, requireShim)
  return exports
}

const sharedFormat = loadModule('../shared/formatBytes.ts', () => ({}))
const downloadModule = loadModule('../electron/services/download.ts', (id) => {
  if (id === 'fs') return nodeFs
  if (id === 'fs/promises') return nodeFsPromises
  if (id === 'events') return nodeEvents
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

const { checkForUpdate, updateApp } = loadModule('../electron/services/appUpdater.ts', (id) => {
  if (id === 'electron') return { app: electronApp }
  if (id === 'child_process') {
    return {
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        return { on: () => ({ unref: () => {} }), unref: () => {} }
      }
    }
  }
  if (id === 'os') return { ...nodeFs, tmpdir: () => fakeTmp }
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
