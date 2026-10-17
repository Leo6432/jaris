import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

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
function loadStorage(defaultUserData, { exe = '/opt/Jaris/Jaris.exe', isPackaged = false, platform = 'linux', dataModules = {} } = {}) {
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
      withI18n((name) => modules[name] ?? nodeRequire(name)),
      fakeProcess
    )
    return exports
  }
  const storageRoot = load('../electron/services/storageRoot.ts', { electron: { app } })
  const dataLocation = load('../electron/services/dataLocation.ts', { electron: { app }, './storageRoot': storageRoot, ...dataModules })
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
  // Étape 293 : la langue choisie dans les réglages suit les données, sinon Jaris repart dans celle de Windows.
  writeFileSync(join(userData, 'language.json'), '{"setting":"de"}')
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
  assert.equal(readFileSync(join(newRoot, 'jaris-data', 'language.json'), 'utf8'), '{"setting":"de"}', 'la langue choisie est emportée')

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

// ---------------------------------------------------------------------------------------------------------
// Données oubliées par « Déplacer » : jeton GitHub, identité du téléphone, téléphones appairés, conversations du
// mode Code, résultats des tests de modèles. Seules les entrées de OWNED_ENTRIES sont copiées ; tout le reste de
// l'ancien dossier de données est effacé, et l'ancien dossier de Chromium aussi au démarrage suivant.
// ---------------------------------------------------------------------------------------------------------

/**
 * Faux `safeStorage` qui se comporte comme le vrai sous Windows : la clé de chiffrement est lue dans le fichier
 * « Local State » du dossier de Chromium EN SERVICE (`os_crypt.encrypted_key`), et un dossier sans ce fichier en
 * reçoit une NOUVELLE au premier usage (Chromium, OSCrypt::Init). Un texte chiffré avec une autre clé ne se relit pas.
 */
function chromiumSafeStorage(app) {
  let key = null
  const currentKey = () => {
    if (key) return key
    const file = join(app.getPath('userData'), 'Local State')
    try {
      key = JSON.parse(readFileSync(file, 'utf8')).os_crypt.encrypted_key
    } catch {
      key = null
    }
    if (!key) {
      key = `cle-${randomUUID()}`
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file, JSON.stringify({ os_crypt: { encrypted_key: key } }))
    }
    return key
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`v10|${currentKey()}|${Buffer.from(text).toString('base64')}`),
    decryptString: (buffer) => {
      const [, usedKey, data] = buffer.toString().split('|')
      if (usedKey !== currentKey()) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from(data, 'base64').toString()
    }
  }
}

/** Une « exécution » de Jaris : la racine lue au démarrage, puis github.ts et la liste des téléphones. */
function startJaris(userData, options) {
  const session = loadStorage(userData, options)
  const github = loadTsModule('electron/services/github.ts', {
    electron: { safeStorage: chromiumSafeStorage(session.app) },
    'fs/promises': fsPromises,
    path: nodePath,
    './dataLocation': session.dataLocation
  })
  const { PhoneDeviceStore } = loadTsModule('electron/services/phoneDevices.ts', {
    crypto: nodeRequire('node:crypto'),
    'fs/promises': fsPromises,
    path: nodePath
  })
  const dataRoot = session.dataLocation.getDataRoot()
  return { ...session, github, devices: new PhoneDeviceStore(join(dataRoot, 'phone-devices.json')), dataRoot }
}

const GITHUB_TOKEN = 'gho_jeton_de_leo'
const GITHUB_REFRESH = 'ghr_renouvellement_de_leo'

/** Tout ce qu'un Jaris utilisé a dans ses données en plus des conversations et du profil. */
async function fillForgottenData(jaris) {
  assert.equal(await jaris.github.saveGithubToken({ token: GITHUB_TOKEN, refreshToken: GITHUB_REFRESH, expiresAt: 42 }), true)
  const { token: phoneToken } = await jaris.devices.add('iPhone de Léo')
  mkdirSync(join(jaris.dataRoot, 'phone-tunnel', 'certs'), { recursive: true })
  writeFileSync(join(jaris.dataRoot, 'phone-tunnel', 'tailscaled.state'), '{"_machinekey":"mkey:pc-de-leo"}')
  writeFileSync(join(jaris.dataRoot, 'phone-tunnel', 'certs', 'jaris.ts.net.crt'), 'certificat')
  writeFileSync(join(jaris.dataRoot, 'code-conversations.json'), '{"repos":["leo/site"]}')
  writeFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.md'), '# Résultats')
  writeFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.traces.jsonl'), '{"type":"campagne"}\n')
  writeFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.md.telecharges.json'), '["k2-horizon:7b"]')
  mkdirSync(join(jaris.dataRoot, 'duel-pilotes'), { recursive: true })
  writeFileSync(join(jaris.dataRoot, 'duel-pilotes', 'resultat-duel-pilotes.md'), '# Duel')
  return phoneToken
}

/** Après le déplacement et le redémarrage : chaque donnée est là ET se relit avec le vrai code de Jaris. */
async function assertForgottenDataReadable(jaris, phoneToken) {
  assert.deepEqual(
    { ...(await jaris.github.readGithubToken()) },
    { token: GITHUB_TOKEN, unreadable: false, refreshToken: GITHUB_REFRESH, expiresAt: 42 },
    'le jeton GitHub doit suivre ET rester lisible (sinon : déconnecté de GitHub après chaque « Déplacer »)'
  )
  assert.equal((await jaris.devices.findByToken(phoneToken))?.name, 'iPhone de Léo', 'le téléphone appairé doit encore être reconnu')
  assert.equal(readFileSync(join(jaris.dataRoot, 'phone-tunnel', 'tailscaled.state'), 'utf8'), '{"_machinekey":"mkey:pc-de-leo"}')
  assert.equal(readFileSync(join(jaris.dataRoot, 'phone-tunnel', 'certs', 'jaris.ts.net.crt'), 'utf8'), 'certificat')
  assert.equal(readFileSync(join(jaris.dataRoot, 'code-conversations.json'), 'utf8'), '{"repos":["leo/site"]}')
  assert.equal(readFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.md'), 'utf8'), '# Résultats')
  assert.equal(readFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.traces.jsonl'), 'utf8'), '{"type":"campagne"}\n')
  assert.equal(readFileSync(join(jaris.dataRoot, 'benchmark-nouveaux-modeles.md.telecharges.json'), 'utf8'), '["k2-horizon:7b"]')
  assert.equal(readFileSync(join(jaris.dataRoot, 'duel-pilotes', 'resultat-duel-pilotes.md'), 'utf8'), '# Duel')
}

/** « Déplacer » tel que relocation.ts l'enchaîne pour les données : copie, bascule, effacement des originaux. */
async function moveData(jaris, previousRoot, newRoot) {
  await jaris.dataLocation.copyDataTo(newRoot, () => {})
  jaris.dataLocation.switchStorageRoot(newRoot)
  await jaris.dataLocation.removeOldData(previousRoot, newRoot)
}

test('« Déplacer » (emplacement par défaut → D) : jeton GitHub, téléphone, Code, tests de modèles suivent et se relisent', async () => {
  const { userData, root } = setupUserData()
  fillUserData(userData)
  const before = startJaris(userData)
  assert.equal(before.dataRoot, userData)
  const phoneToken = await fillForgottenData(before)
  const newRoot = join(root, 'D', 'Jaris')

  await moveData(before, null, newRoot)
  assert.equal(
    readFileSync(join(newRoot, 'electron', 'Local State'), 'utf8'),
    readFileSync(join(userData, 'Local State'), 'utf8'),
    'la clé de chiffrement doit partir dans le nouveau dossier de Chromium au moment de la bascule'
  )

  // Redémarrage : Chromium dans le nouveau dossier, puis effacement de tout l'ancien dossier par défaut.
  const after = startJaris(userData)
  await after.storageRoot.cleanupStaleChromiumData()
  assert.equal(after.dataRoot, join(newRoot, 'jaris-data'))
  await assertForgottenDataReadable(after, phoneToken)
  assert.deepEqual(readdirSync(userData), ['storage-location.json'], 'il ne reste que le fichier-repère sur C')
  rmSync(root, { recursive: true, force: true })
})

test('« Déplacer » (D → E) : la clé suit même si un ancien dossier de Chromium traîne déjà à destination', async () => {
  const { userData, root } = setupUserData()
  const rootA = join(root, 'D', 'Jaris-data')
  const rootB = join(root, 'E', 'Jaris')
  mkdirSync(rootA, { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: rootA }))
  // Reste d'une ancienne session sur E : un dossier de Chromium avec une AUTRE clé.
  mkdirSync(join(rootB, 'electron'), { recursive: true })
  writeFileSync(join(rootB, 'electron', 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'cle-oubliee' } }))

  const before = startJaris(userData)
  assert.equal(before.dataRoot, join(rootA, 'jaris-data'))
  const phoneToken = await fillForgottenData(before)
  await moveData(before, rootA, rootB)
  assert.ok(!existsSync(join(rootA, 'jaris-data')), 'l’ancien dossier de données est bien effacé en entier')

  const after = startJaris(userData)
  await after.storageRoot.cleanupStaleChromiumData()
  await assertForgottenDataReadable(after, phoneToken)
  assert.ok(!existsSync(rootA), 'l’ancienne racine, vide, est retirée')
  rmSync(root, { recursive: true, force: true })
})

test('mise à jour : jeton GitHub et identité du téléphone encore dans le dossier de Chromium sont rapatriés au démarrage', async () => {
  const { userData, root } = setupUserData()
  const rootA = join(root, 'D', 'Jaris-data')
  const electronA = join(rootA, 'electron')
  mkdirSync(electronA, { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: rootA }))
  // Ce que les versions d'avant écrivaient dans le dossier de Chromium (chiffré avec SA clé).
  const legacyStorage = chromiumSafeStorage({ getPath: () => electronA })
  writeFileSync(join(electronA, 'github-token.bin'), legacyStorage.encryptString(GITHUB_TOKEN))
  mkdirSync(join(electronA, 'phone-tunnel'), { recursive: true })
  writeFileSync(join(electronA, 'phone-tunnel', 'tailscaled.state'), '{"_machinekey":"mkey:pc-de-leo"}')

  const jaris = startJaris(userData)
  assert.equal(jaris.app.getPath('userData'), electronA)
  assert.equal(await jaris.github.loadGithubToken(), GITHUB_TOKEN, 'connexion GitHub gardée à la mise à jour')
  assert.equal(readFileSync(join(jaris.dataRoot, 'phone-tunnel', 'tailscaled.state'), 'utf8'), '{"_machinekey":"mkey:pc-de-leo"}')
  assert.ok(!existsSync(join(electronA, 'github-token.bin')) && !existsSync(join(electronA, 'phone-tunnel')), 'plus rien au vieil endroit')

  // Et le « Déplacer » suivant les emporte enfin.
  const rootB = join(root, 'E', 'Jaris')
  await moveData(jaris, rootA, rootB)
  const after = startJaris(userData)
  await after.storageRoot.cleanupStaleChromiumData()
  assert.equal(await after.github.loadGithubToken(), GITHUB_TOKEN)
  assert.equal(readFileSync(join(after.dataRoot, 'phone-tunnel', 'tailscaled.state'), 'utf8'), '{"_machinekey":"mkey:pc-de-leo"}')
  rmSync(root, { recursive: true, force: true })
})

test('rapatriement : jamais par-dessus une donnée déjà rangée avec les autres', () => {
  const { userData, root } = setupUserData()
  const rootA = join(root, 'D', 'Jaris-data')
  mkdirSync(join(rootA, 'electron'), { recursive: true })
  mkdirSync(join(rootA, 'jaris-data'), { recursive: true })
  writeFileSync(join(rootA, 'electron', 'github-token.bin'), 'vieux')
  writeFileSync(join(rootA, 'jaris-data', 'github-token.bin'), 'récent')
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: rootA }))
  const { dataLocation } = loadStorage(userData)
  assert.equal(readFileSync(join(dataLocation.getDataRoot(), 'github-token.bin'), 'utf8'), 'récent')
  rmSync(root, { recursive: true, force: true })
})

test('installé sur D (ou ancien repère) : la clé de chiffrement de l’ancien dossier suit les données rapatriées', async () => {
  const { userData, root } = setupUserData()
  // Jaris déjà utilisé à l'emplacement par défaut, connecté à GitHub.
  const before = startJaris(userData)
  await before.github.saveGithubToken(GITHUB_TOKEN)
  const chosen = join(root, 'D', 'Jaris-data')
  mkdirSync(chosen, { recursive: true })
  // Racine décidée au démarrage SANS passer par « Déplacer » (même chemin que le dossier automatique sur D) :
  // seul le démarrage peut reprendre la clé.
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: chosen }))

  const after = startJaris(userData)
  await after.storageRoot.cleanupStaleChromiumData()
  assert.equal(after.dataRoot, join(chosen, 'jaris-data'))
  assert.deepEqual({ ...(await after.github.readGithubToken()) }, { token: GITHUB_TOKEN, unreadable: false })
  rmSync(root, { recursive: true, force: true })
})

test('rien n’est relu depuis un dossier qui va être effacé : jeton et identité du téléphone lus avec les données', () => {
  const github = readFileSync(new URL('../electron/services/github.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.ok(!github.includes("app.getPath('userData')"), 'github.ts ne doit plus ranger le jeton dans le dossier de Chromium')
  assert.match(github, /return join\(getDataRoot\(\), GITHUB_TOKEN_FILE\)/)
  assert.match(main, /tunnelStateDir: join\(getDataRoot\(\), PHONE_TUNNEL_DIR\)/)
  assert.match(main, /devicesFile: join\(getDataRoot\(\), 'phone-devices\.json'\)/)
})

test('chaque fichier que Jaris écrit dans ses données suit « Déplacer », sauf ce qu’il sait reconstruire seul', () => {
  const { userData, root } = setupUserData()
  const { storageRoot } = loadStorage(userData)
  rmSync(root, { recursive: true, force: true })
  const owned = new Set(storageRoot.OWNED_ENTRIES)
  // Recopié depuis le programme à chaque démarrage, conteneur recréé s'il pointe ailleurs (searxngHome.ts).
  const rebuiltAlone = new Set(['searxng-docker'])

  const sources = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) sources.push([full, readFileSync(full, 'utf8')])
    }
  }
  walk(fileURLToPath(new URL('../electron', import.meta.url)))
  const constants = new Map()
  for (const [, text] of sources) {
    for (const m of text.matchAll(/export const ([A-Z_]+) = '([^']+)'/g)) constants.set(m[1], m[2])
  }
  const written = []
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/join\(getDataRoot\(\), (?:'([^']+)'|([A-Z_]+))/g)) {
      const name = m[1] ?? constants.get(m[2])
      assert.ok(name, `${file} : nom de fichier introuvable pour ${m[0]}`)
      written.push(name)
    }
  }
  for (const name of ['github-token.bin', 'phone-tunnel', 'phone-devices.json', 'benchmark-nouveaux-modeles.md', 'searxng-docker']) {
    assert.ok(written.includes(name), `${name} devrait être trouvé par ce contrôle (sinon le contrôle lui-même ne voit plus rien)`)
  }
  for (const name of written) {
    assert.ok(owned.has(name) || rebuiltAlone.has(name), `« ${name} » est écrit dans les données mais perdu au prochain « Déplacer » (OWNED_ENTRIES)`)
  }

  // Les fichiers voisins que le script de test écrit à côté de ses résultats (mêmes règles de nom que lui).
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  assert.ok(script.includes("const TRACES_PATH = `${RESULTS_PATH.replace(/\\.md$/i, '')}.traces.jsonl`"), 'nom des traces changé dans le script')
  assert.ok(script.includes('const ledgerPath = `${RESULTS_PATH}.telecharges.json`'), 'nom du registre changé dans le script')
  const results = 'benchmark-nouveaux-modeles.md'
  for (const name of [results.replace(/\.md$/i, '') + '.traces.jsonl', `${results}.telecharges.json`, 'code-conversations.json']) {
    assert.ok(owned.has(name), `« ${name} » doit suivre « Déplacer »`)
  }
})

test('« Déplacer » arrête d’abord ce qui écrit dans les données : accès téléphone et test de modèles', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const handlerAt = source.indexOf('IPC_CHANNELS.chooseModelsLocation, async')
  const handler = source.slice(handlerAt, source.indexOf('IPC_CHANNELS.getRuntimeSetupStatus', handlerAt))
  const moveAt = handler.indexOf('relocateEverything(')
  for (const stop of ['stopModelTest()', 'phoneAccess?.disable()']) {
    const at = handler.indexOf(stop)
    assert.ok(at !== -1 && at < moveAt, `${stop} doit venir avant relocateEverything`)
  }
})

test('effacement des anciennes données : une entrée bloquée n’empêche pas d’effacer les suivantes', async () => {
  const { userData, root } = setupUserData()
  fillUserData(userData)
  writeFileSync(join(userData, 'phone-devices.json'), '{"devices":[]}')
  const realRm = fsPromises.rm
  const { dataLocation } = loadStorage(userData, {
    dataModules: {
      'fs/promises': {
        ...fsPromises,
        // « conversations » encore ouvert par un autre programme : Windows refuse de l'effacer.
        rm: async (path, options) => {
          if (path === join(userData, 'conversations')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
          return realRm(path, options)
        }
      }
    }
  })
  await assert.rejects(dataLocation.removeOldData(null, join(root, 'D', 'Jaris')), /EBUSY/)
  assert.ok(!existsSync(join(userData, 'profile.json')), 'les entrées suivantes sont quand même effacées')
  assert.ok(!existsSync(join(userData, 'phone-devices.json')))
  assert.ok(existsSync(join(userData, 'conversations')))
  rmSync(root, { recursive: true, force: true })
})
