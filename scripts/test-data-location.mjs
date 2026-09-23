import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

/**
 * Étape 143 : une racine de stockage UNIQUE (storageRoot.ts) pour tout ce que Jaris écrit. Ce fichier vérifie
 * le démarrage (repère lu, données rapatriées, dossier interne de Chromium redirigé AVANT `ready`), le calcul
 * du dossier automatique quand le programme est installé sur D, et les trois temps du déplacement des données
 * (copie, bascule du repère, effacement des originaux EN DERNIER).
 *
 * Historique : "Déplacer" ne bougeait que les trois briques lourdes (modèles Ollama, environnement Python, cache
 * HuggingFace). Léo, étape 121 : "le fichier jaris avec conversation cache ne change pas quand on clique sur
 * déplacer", puis, quand je lui ai demandé pourquoi déplacer quelques Ko de JSON alors que la fonctionnalité
 * vise des dizaines de Go : "sa doit déplacer tout".
 *
 * Mécanisme volontairement DIFFÉRENT des trois autres briques (voir dataLocation.ts) : pas de jonction NTFS
 * sur userData, qui héberge aussi les fichiers internes de Chromium ouverts en permanence par Electron —
 * seulement une copie des fichiers que Jaris écrit lui-même, plus un marqueur laissé dans userData (l'ancrage
 * fixe) qui dit où ils vivent désormais.
 *
 * Étape 124, Léo, après avoir constaté par lui-même ce qui restait sur le C une fois "Déplacer" utilisé (une
 * copie de secours de quelques Mo, choix délibéré de l'étape 121) : "Je veut tout dans le dossier choisit
 * TOUT". Les originaux sont donc désormais SUPPRIMÉS après confirmation de la copie — seule la suppression a
 * changé, la copie reste faite AVANT toute suppression (jamais l'inverse), et le cache Chromium (jamais notre
 * fichier) n'est toujours jamais touché.
 */
function transpile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/**
 * Charge storageRoot.ts (qui s'exécute à son chargement, comme au vrai démarrage) puis dataLocation.ts, avec
 * un `app` simulé qui retient les appels à setPath.
 */
function loadStorage(defaultUserData, { exe = '/opt/Jaris/Jaris.exe', isPackaged = false, platform = 'linux' } = {}) {
  const paths = { userData: defaultUserData, exe }
  const setPathCalls = []
  const app = {
    isPackaged,
    getPath: (name) => paths[name],
    setPath: (name, value) => {
      setPathCalls.push([name, value])
      paths[name] = value
    }
  }
  const fakeProcess = { platform, env: { SystemDrive: 'C:' } }
  const load = (path, modules) => {
    const exports = {}
    vm.runInThisContext(`(function (exports, module, require, process) { ${transpile(path)} })`)(
      exports,
      { exports },
      (name) => modules[name] ?? nodeRequire(name),
      fakeProcess
    )
    return exports
  }
  const storageRoot = load('../electron/services/storageRoot.ts', { electron: { app } })
  const dataLocation = load('../electron/services/dataLocation.ts', { electron: { app }, './storageRoot': storageRoot })
  return { storageRoot, dataLocation, setPathCalls, app }
}

function setupUserData() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-data-location-'))
  const userData = join(root, 'AppData', 'Jaris')
  mkdirSync(userData, { recursive: true })
  return { root, userData }
}

/** Les vraies données de Jaris, telles qu'elles existent sur une installation utilisée. */
function fillUserData(userData) {
  mkdirSync(join(userData, 'conversations'), { recursive: true })
  writeFileSync(join(userData, 'conversations', 'index.json'), '{"activeId":"abc","conversations":[]}')
  writeFileSync(join(userData, 'profile.json'), '{"name":"Léo"}')
  mkdirSync(join(userData, 'memory'), { recursive: true })
  writeFileSync(join(userData, 'memory', 'Adresse.md'), '# Adresse')
  mkdirSync(join(userData, 'generated-apps', '2026-snake'), { recursive: true })
  writeFileSync(join(userData, 'generated-apps', '2026-snake', 'index.html'), '<html>Snake</html>')
  writeFileSync(join(userData, 'reminders.json'), '[]')
  // Fichier INTERNE de Chromium : jamais copié avec nos données.
  mkdirSync(join(userData, 'Cache'), { recursive: true })
  writeFileSync(join(userData, 'Cache', 'data_0'), 'cache chromium')
}

test('installé sur D : le dossier de Jaris se met À CÔTÉ du programme (jamais dedans), rien sur le disque système', () => {
  const { userData, root } = setupUserData()
  const { storageRoot } = loadStorage(userData)
  assert.equal(storageRoot.autoRootForInstall('D:\\Jaris\\Jaris.exe', 'C:'), 'D:\\Jaris-data')
  assert.equal(storageRoot.autoRootForInstall('d:\\Programmes\\jaris\\Jaris.exe', 'C:'), 'd:\\Programmes\\Jaris-data')
  assert.equal(storageRoot.autoRootForInstall('C:\\Users\\leo\\AppData\\Local\\Programs\\jaris\\Jaris.exe', 'C:'), null)
  assert.equal(storageRoot.autoRootForInstall('c:\\Jaris\\Jaris.exe', 'C:'), null, 'la casse de la lettre ne compte pas')
  rmSync(root, { recursive: true, force: true })
})

test('sans repère : tout reste à l’emplacement par défaut, et le dossier de Chromium n’est pas redirigé', () => {
  const { userData, root } = setupUserData()
  const { storageRoot, dataLocation, setPathCalls } = loadStorage(userData)
  assert.equal(storageRoot.getStorageRoot(), null)
  assert.equal(dataLocation.getDataRoot(), userData)
  assert.equal(setPathCalls.length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('au démarrage avec un repère : données rapatriées AVANT tout, et Chromium redirigé dans le dossier choisi', () => {
  const { userData, root } = setupUserData()
  fillUserData(userData)
  const chosen = join(root, 'D', 'Jaris-data')
  mkdirSync(chosen, { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: chosen }))

  const { storageRoot, dataLocation, setPathCalls } = loadStorage(userData)

  assert.equal(storageRoot.getStorageRoot(), chosen)
  assert.equal(dataLocation.getDataRoot(), join(chosen, 'jaris-data'))
  assert.equal(JSON.stringify(setPathCalls), JSON.stringify([['userData', join(chosen, 'electron')]]))
  assert.equal(readFileSync(join(chosen, 'jaris-data', 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.equal(readFileSync(join(chosen, 'jaris-data', 'generated-apps', '2026-snake', 'index.html'), 'utf8'), '<html>Snake</html>')
  assert.ok(!existsSync(join(userData, 'profile.json')), 'plus rien de nos données sur C')
  assert.ok(!existsSync(join(chosen, 'jaris-data', 'Cache')), 'le cache de Chromium n’est jamais copié avec nos données')
  rmSync(root, { recursive: true, force: true })
})

test('ancien repère (étape 121) : repris tel quel, converti, rien n’est perdu', () => {
  const { userData, root } = setupUserData()
  const chosen = join(root, 'D', 'Stockage')
  mkdirSync(join(chosen, 'jaris-data'), { recursive: true })
  writeFileSync(join(chosen, 'jaris-data', 'profile.json'), '{"name":"Léo"}')
  writeFileSync(join(userData, 'data-location.json'), JSON.stringify({ dataDir: join(chosen, 'jaris-data') }))

  const { storageRoot, dataLocation } = loadStorage(userData)

  assert.equal(storageRoot.getStorageRoot(), chosen)
  assert.equal(readFileSync(join(dataLocation.getDataRoot(), 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.ok(existsSync(join(userData, 'storage-location.json')))
  assert.ok(!existsSync(join(userData, 'data-location.json')))
  rmSync(root, { recursive: true, force: true })
})

test('un dossier disparu (disque débranché) n’est JAMAIS recréé vide : Jaris repart sur l’emplacement par défaut', () => {
  const { userData, root } = setupUserData()
  writeFileSync(join(userData, 'profile.json'), '{"name":"Léo"}')
  const gone = join(root, 'E', 'Jaris-data')
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: gone }))

  const { storageRoot, dataLocation, setPathCalls } = loadStorage(userData)

  assert.equal(storageRoot.getStorageRoot(), null)
  assert.equal(dataLocation.getDataRoot(), userData)
  assert.equal(setPathCalls.length, 0)
  assert.ok(!existsSync(gone))
  assert.ok(existsSync(join(userData, 'profile.json')))
  rmSync(root, { recursive: true, force: true })
})

test('un repère illisible ne casse pas le démarrage', () => {
  const { userData, root } = setupUserData()
  writeFileSync(join(userData, 'storage-location.json'), '{pas du json')
  const { storageRoot } = loadStorage(userData)
  assert.equal(storageRoot.getStorageRoot(), null)
  rmSync(root, { recursive: true, force: true })
})

test('« Déplacer » : copie d’abord, bascule du repère ensuite, effacement des originaux EN DERNIER', async () => {
  const { userData, root } = setupUserData()
  fillUserData(userData)
  const { dataLocation } = loadStorage(userData)
  const newRoot = join(root, 'D', 'Jaris')

  await dataLocation.copyDataTo(newRoot, () => {})
  assert.ok(existsSync(join(userData, 'profile.json')), 'après la copie, les originaux sont encore là')
  assert.equal(readFileSync(join(newRoot, 'jaris-data', 'memory', 'Adresse.md'), 'utf8'), '# Adresse')

  dataLocation.switchStorageRoot(newRoot)
  assert.equal(JSON.parse(readFileSync(join(userData, 'storage-location.json'), 'utf8')).root, newRoot)

  await dataLocation.removeOldData(null, newRoot)
  assert.ok(!existsSync(join(userData, 'profile.json')))
  assert.ok(existsSync(join(userData, 'storage-location.json')), 'le fichier-repère, lui, reste')
  rmSync(root, { recursive: true, force: true })
})

test('au démarrage suivant : l’ancien cache de Chromium et les installeurs téléchargés sont effacés, le repère gardé', async () => {
  const { userData, root } = setupUserData()
  const chosen = join(root, 'D', 'Jaris-data')
  const oldRoot = join(root, 'E', 'Ancien')
  mkdirSync(join(oldRoot, 'electron', 'Cache'), { recursive: true })
  mkdirSync(join(chosen, 'downloads'), { recursive: true })
  writeFileSync(join(chosen, 'downloads', 'OllamaSetup.exe'), 'x')
  mkdirSync(join(userData, 'GPUCache'), { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: chosen, staleElectronDir: join(oldRoot, 'electron') }))

  const { storageRoot } = loadStorage(userData)
  await storageRoot.cleanupStaleChromiumData()

  assert.ok(!existsSync(join(userData, 'GPUCache')))
  assert.ok(existsSync(join(userData, 'storage-location.json')))
  assert.ok(!existsSync(oldRoot), 'l’ancienne racine, vide, est retirée')
  assert.ok(!existsSync(join(chosen, 'downloads')))
  rmSync(root, { recursive: true, force: true })
})

test('main.ts charge la racine de stockage AVANT tout autre service (sinon un store calcule son chemin trop tôt)', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '(\.\/services\/[^']+)'/gm)].map((m) => m[1])
  assert.equal(imports[0], './services/storageRoot')
})

test('« Déplacer » emporte tout (relocateEverything) puis relance Jaris, fenêtre autorisée à se fermer', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const handlerAt = source.indexOf('IPC_CHANNELS.chooseModelsLocation, async')
  assert.ok(handlerAt !== -1, 'handler chooseModelsLocation introuvable')
  const handler = source.slice(handlerAt, source.indexOf('IPC_CHANNELS.getRuntimeSetupStatus', handlerAt))
  assert.ok(handler.includes('relocateEverything('))
  assert.ok(handler.includes('app.relaunch()'))
  assert.ok(handler.includes('programMoveCommandLine('), 'le programme lui-même doit être réinstallé dans le nouveau dossier')
  assert.ok(handler.includes('quitting = true'), 'sinon la fenêtre intercepte sa fermeture et se replie en widget (étape 109)')
})

test('les 5 stores lisent leur emplacement via getDataRoot, plus jamais userData en dur', () => {
  const stores = ['profileStore', 'memoryStore', 'reminders', 'conversationStore', 'codeGenerator']
  for (const name of stores) {
    const source = readFileSync(new URL(`../electron/services/${name}.ts`, import.meta.url), 'utf8')
    assert.ok(source.includes('getDataRoot()'), `${name}.ts doit lire son dossier via getDataRoot()`)
    assert.ok(
      !source.includes("app.getPath('userData')"),
      `${name}.ts ne doit plus calculer son chemin depuis userData en dur, sinon "Déplacer" ne le déplace pas`
    )
  }
})
