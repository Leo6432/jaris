import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 336 — l'Ollama de Jaris (ollamaEngine.ts) et le bouton d'Options qui l'installe ou le met à jour
 * (updateOllama, dependencyServices.ts). Les deux modules RÉELS sont chargés ensemble, sur un vrai dossier
 * temporaire ; seuls internet, le serveur Ollama et les programmes Windows (tar.exe, PowerShell, taskkill) sont
 * simulés par une fausse machine qui sait quelle version d'Ollama tourne.
 *
 * Ce qui est verrouillé :
 *  - passer de l'Ollama de Windows à celui de Jaris, avec l'avancement réel du téléchargement (étape 112 :
 *    1,6 Go sans signe de vie se lit comme un blocage) ;
 *  - une mise à jour qui démarre la nouvelle version, vérifie son numéro, et efface l'ancienne seulement après ;
 *  - une nouvelle version qui ne démarre pas : retour à l'ancienne, rien de perdu ;
 *  - un fichier dont l'empreinte ne correspond pas : rien n'est installé ni lancé.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function compile(relativePath) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/**
 * Horloge rapide : les attentes de quelques secondes (serveur qui démarre, port qui se libère) passent en un
 * tour de boucle, sinon un démarrage raté coûterait 30 vraies secondes au test.
 */
function fastClock() {
  let now = 0
  const timers = new Map()
  let next = 1
  return {
    setTimeout: (fn, ms = 0) => {
      const id = next++
      timers.set(id, true)
      setImmediate(() => {
        if (!timers.delete(id)) return
        now += ms
        fn()
      })
      return { unref() {}, id }
    },
    clearTimeout: (handle) => timers.delete(handle?.id),
    Date: class extends Date {
      static now() {
        return now
      }
    }
  }
}

const ZIP_CONTENT = {
  '0.40.4': 'paquet officiel 0.40.4',
  '0.40.5': 'paquet officiel 0.40.5'
}
const sha = (text) => createHash('sha256').update(text).digest('hex')

/**
 * La fausse machine : `running` est la version d'Ollama qui répond sur le port de Jaris, `broken` les versions qui
 * ne démarrent jamais, `latest` la dernière publiée sur GitHub.
 */
function setupMachine({ latest = '0.40.5', installed = null, broken = [], corrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jaris-ollama-engine-'))
  const localAppData = join(root, 'local')
  const machine = { root, localAppData, latest, broken, running: null, downloads: [], spawns: [], host: 'http://127.0.0.1:11434' }
  const engineDir = join(localAppData, 'Jaris', 'ollama-engine')
  mkdirSync(engineDir, { recursive: true })
  if (installed) {
    mkdirSync(join(engineDir, 'versions', installed), { recursive: true })
    writeFileSync(join(engineDir, 'versions', installed, 'ollama.exe'), `ollama ${installed}`)
    writeFileSync(join(engineDir, 'current.json'), JSON.stringify({ version: installed }))
    machine.running = installed
  }
  const engineUrl = 'http://127.0.0.1:11435'

  machine.fetch = async (url) => {
    url = String(url)
    if (url.startsWith(engineUrl)) {
      if (!machine.running) throw new Error('connexion refusée')
      if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: machine.running }) }
      return { ok: true, json: async () => ({ models: [] }) }
    }
    if (url.includes('api.github.com/repos/ollama/ollama/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: `v${machine.latest}` }) }
    }
    if (url.endsWith('/sha256sum.txt')) {
      const version = /\/v([^/]+)\/sha256sum\.txt$/.exec(url)[1]
      return { ok: true, text: async () => `${'0'.repeat(64)}  ./ollama-windows-arm64.zip\n${sha(ZIP_CONTENT[version])}  ./ollama-windows-amd64.zip\n` }
    }
    throw new Error(`connexion refusée : ${url}`)
  }

  const fakeProcess = { platform: 'win32', env: { ...process.env, LOCALAPPDATA: localAppData, SystemRoot: 'C:\\Windows' } }

  const childProcess = {
    execFile: (_file, args, _opts, cb) => {
      // tar.exe -xf <zip> -C <dossier> : le paquet contient ollama.exe à sa racine.
      const zip = args[1]
      const destination = args[3]
      writeFileSync(join(destination, 'ollama.exe'), readFileSync(zip, 'utf8'))
      cb(null)
    },
    execSync: (command) => {
      if (/taskkill \/pid/.test(command)) machine.running = null
      return ''
    },
    exec: (_command, _opts, cb) => cb?.(null, { stdout: '', stderr: '' }),
    spawn: (file, _args, options = {}) => {
      const handlers = {}
      const proc = { pid: 4242, unref() {}, on: (event, cb) => ((handlers[event] = cb), proc) }
      const exe = options.env?.JARIS_OLLAMA_EXE
      if (exe) {
        const version = /versions[\\/]([^\\/]+)[\\/]ollama\.exe$/.exec(exe)[1]
        machine.spawns.push({ version, env: options.env })
        if (!machine.broken.includes(version)) machine.running = version
      } else if (file === 'powershell.exe') {
        // Arrêt des restes d'un lancement précédent (stopStrayEngines).
        machine.running = null
        setImmediate(() => handlers.close?.(0))
      }
      return proc
    }
  }

  const clock = fastClock()
  const wrap = (relativePath, requireShim) => {
    const exports = {}
    vm.runInThisContext(`(function (exports, module, require, process, setTimeout, clearTimeout, Date, fetch) { ${compile(relativePath)} })`)(
      exports,
      { exports },
      withI18n(requireShim),
      fakeProcess,
      clock.setTimeout,
      clock.clearTimeout,
      clock.Date,
      machine.fetch
    )
    return exports
  }

  const engine = wrap('electron/services/ollamaEngine.ts', (id) => {
    if (id === 'child_process') return childProcess
    if (id === './download') {
      return {
        downloadToFile: async (url, destination, options) => {
          machine.downloads.push(url)
          const version = /\/v([^/]+)\/ollama-windows-amd64\.zip$/.exec(url)[1]
          const content = corrupt ? 'fichier abîmé en route' : ZIP_CONTENT[version]
          const total = 1_610_612_736
          for (const percent of [0, 50, 100]) options?.onProgress?.({ receivedBytes: Math.round(total * (percent / 100)), totalBytes: total, percent })
          writeFileSync(destination, content)
          return content.length
        }
      }
    }
    if (id === './ollamaModelsVariable') return { countOllamaModels: async () => 0 }
    if (id === 'os') return { homedir: () => join(root, 'home') }
    if (id === 'fs') return nodeFs
    if (id === 'fs/promises') return fsPromises
    if (id === 'crypto' || id === 'path') return id === 'crypto' ? { createHash } : { join }
    throw new Error(`module non simulé (ollamaEngine) : ${id}`)
  })

  const services = wrap('electron/services/dependencyServices.ts', (id) => {
    if (id === './ollamaEngine') return engine
    if (id === 'child_process') return childProcess
    if (id === 'fs') return { mkdirSync: () => {} }
    if (id === 'fs/promises') return { rm: fsPromises.rm, rmdir: async () => {} }
    if (id === 'path') return { join, basename: (p) => p.split('/').pop(), dirname: (p) => p.split('/').slice(0, -1).join('/') }
    if (id === 'util') return { promisify: () => async () => ({ stdout: '', stderr: '' }) }
    if (id.endsWith('/storageRoot')) return { downloadsDir: () => root, getStorageRoot: () => null }
    if (id.endsWith('/config')) {
      return {
        config: { ollama: { get host() { return machine.host } } },
        setOllamaHost: (host) => (machine.host = host),
        WINDOWS_OLLAMA_HOST: 'http://127.0.0.1:11434'
      }
    }
    if (id.endsWith('/appLauncher')) return { didAppLaunch: () => true, openApp: async () => '' }
    if (id.endsWith('/download')) return { downloadToFile: async () => 0 }
    if (id.endsWith('/formatBytes')) return { formatBytes: (n) => `${n} o` }
    throw new Error(`module non simulé (dependencyServices) : ${id}`)
  })

  machine.engineDir = engineDir
  machine.current = () => JSON.parse(readFileSync(join(engineDir, 'current.json'), 'utf8')).version
  machine.versions = () => (existsSync(join(engineDir, 'versions')) ? nodeFs.readdirSync(join(engineDir, 'versions')).sort() : [])
  machine.cleanup = () => rmSync(root, { recursive: true, force: true })
  return { machine, services, engine }
}

test("Ollama de Windows → Ollama de Jaris : avancement réel, bascule sans redémarrer Jaris", async () => {
  const { machine, services } = setupMachine({ latest: '0.40.5' })
  const recu = []
  const result = await services.updateOllama((progress) => recu.push(progress))

  assert.equal(result.success, true, result.message)
  assert.match(result.message, /0\.40\.5/)
  assert.deepEqual(recu.filter((p) => p.phase === 'download').map((p) => p.percent), [0, 50, 100])
  assert.equal(recu.at(-1).phase, 'install', 'la fin du téléchargement doit être annoncée')
  assert.equal(machine.current(), '0.40.5')
  assert.equal(machine.running, '0.40.5')
  assert.equal(machine.host, 'http://127.0.0.1:11435', "Jaris doit interroger son propre Ollama, sur son propre port")
  assert.equal(machine.spawns[0].env.OLLAMA_HOST, '127.0.0.1:11435')
  assert.ok(machine.spawns[0].env.OLLAMA_MODELS, 'le dossier des modèles doit être passé au moteur')
  assert.equal(services.getOllamaVersionStatus().embedded, true)
  assert.deepEqual(machine.versions(), ['0.40.5'])
  assert.ok(!existsSync(join(machine.engineDir, 'download', 'ollama-0.40.5.zip')), 'le paquet de 1,6 Go doit être effacé après usage')
  machine.cleanup()
})

test('mise à jour : la nouvelle version démarre, son numéro est vérifié, puis seulement l’ancienne est effacée', async () => {
  const { machine, services } = setupMachine({ installed: '0.40.4', latest: '0.40.5' })
  await services.ensureOllamaRunning(() => {})
  const result = await services.updateOllama()

  assert.equal(result.success, true, result.message)
  assert.equal(machine.running, '0.40.5')
  assert.equal(machine.current(), '0.40.5')
  assert.deepEqual(machine.versions(), ['0.40.5'])
  assert.equal(services.getOllamaVersionStatus().outdated, false)
  machine.cleanup()
})

test('une nouvelle version qui ne démarre pas : retour à l’ancienne, rien de perdu', async () => {
  const { machine, services } = setupMachine({ installed: '0.40.4', latest: '0.40.5', broken: ['0.40.5'] })
  await services.ensureOllamaRunning(() => {})
  const result = await services.updateOllama()

  assert.equal(result.success, false)
  assert.match(result.message, /0\.40\.5/)
  assert.equal(machine.current(), '0.40.4', 'la version qui marchait doit rester notée en service')
  assert.equal(machine.running, '0.40.4', 'la version qui marchait doit tourner de nouveau')
  assert.deepEqual(machine.versions(), ['0.40.4'], 'la version qui ne démarre pas est effacée, jamais l’autre')
  machine.cleanup()
})

test('un fichier dont l’empreinte ne correspond pas : rien n’est installé ni arrêté', async () => {
  const { machine, services } = setupMachine({ installed: '0.40.4', latest: '0.40.5', corrupt: true })
  await services.ensureOllamaRunning(() => {})
  const spawnsBefore = machine.spawns.length
  const result = await services.updateOllama()

  assert.equal(result.success, false)
  assert.match(result.message, /0\.40\.5/)
  assert.equal(machine.running, '0.40.4', 'le serveur en service ne doit même pas être arrêté')
  assert.equal(machine.spawns.length, spawnsBefore)
  assert.deepEqual(machine.versions(), ['0.40.4'])
  assert.equal(machine.current(), '0.40.4')
  machine.cleanup()
})

test('déjà à jour : aucun téléchargement', async () => {
  const { machine, services } = setupMachine({ installed: '0.40.5', latest: '0.40.5' })
  await services.ensureOllamaRunning(() => {})
  const result = await services.updateOllama()
  assert.equal(result.success, true)
  assert.deepEqual(machine.downloads, [])
  machine.cleanup()
})

test('premier lancement : Jaris installe son Ollama et le démarre', async () => {
  const { machine, services } = setupMachine({ latest: '0.40.5' })
  assert.equal(await services.isOllamaInstalled(), false)
  const messages = []
  assert.equal(await services.installOllamaSilently((message) => messages.push(message)), true, messages.join(' | '))
  assert.equal(await services.isOllamaInstalled(), true)
  assert.equal(machine.running, '0.40.5')
  assert.ok(messages.some((m) => /1610612736 o/.test(m)), `taille du téléchargement absente : ${messages.join(' | ')}`)
  machine.cleanup()
})

test('jamais une version qui ressemble à un chemin', async () => {
  const { machine, engine } = setupMachine()
  for (const bad of ['../../Windows', '0.40', 'v0.40.5', '0.40.5/../x']) assert.equal(engine.isValidEngineVersion(bad), false, bad)
  assert.equal(engine.isValidEngineVersion('0.40.4-rc1'), true)
  assert.equal(engine.checksumFor('abc  ./ollama-windows-amd64.zip'), null, 'une empreinte mal formée ne vaut rien')
  machine.cleanup()
})

test('aucun téléchargement du dépôt ne se fait en silence', () => {
  // Garde pour la suite : c'est précisément l'oubli d'un `onProgress` sur UN seul appel (le plus lourd) qui a
  // produit le blocage apparent de l'étape 112. Un futur téléchargement ajouté sans avancement se lirait pareil.
  const fichiers = globSync('electron/**/*.ts', { cwd: projectRoot })
  const appels = []
  for (const fichier of fichiers) {
    const source = ts.transpileModule(readFileSync(join(projectRoot, fichier), 'utf8'), {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }).outputText
    // La définition elle-même (download.ts) n'est pas un appel.
    for (const match of source.matchAll(/downloadToFile\(([\s\S]{0,400}?)\)\s*[;\n]/g)) {
      if (fichier.endsWith('download.ts')) continue
      appels.push({ fichier, args: match[1] })
    }
  }
  assert.ok(appels.length >= 3, `motif de détection des téléchargements en panne : ${appels.length} appel(s)`)
  const muets = appels.filter((appel) => !appel.args.includes('onProgress')).map((appel) => appel.fichier)
  assert.deepEqual(muets, [], `téléchargement(s) sans le moindre signe de vie : ${muets.join(', ')}`)
})
