import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const sharedCodeConversations = loadTsModule('shared/codeConversations.ts')

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
function loadStorage(defaultUserData, { exe = '/opt/Jaris/Jaris.exe', isPackaged = false, platform = 'linux', dataModules = {}, storageModules = {} } = {}) {
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
  const storageRoot = load('../electron/services/storageRoot.ts', {
    electron: { app },
    // Les conversations du mode Code sont RÉUNIES au démarrage (disque rebranché), avec le vrai module partagé.
    '../../shared/codeConversations': sharedCodeConversations,
    ...storageModules
  })
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

/** Le vrai store des conversations du mode Code (codeConversationsStore.ts), sur le vrai disque. */
const CodeConversationsStore = loadTsModule('electron/services/codeConversationsStore.ts', {
  fs: nodeRequire('node:fs'),
  path: nodePath,
  '../../shared/codeConversations': sharedCodeConversations
}).CodeConversationsStore
const codeTurns = (text, first = 1) => [
  { id: first, kind: 'user', text },
  { id: first + 1, kind: 'reply', text: 'Fait.' }
]
const CODE_FILE = 'code-conversations.json'
const ASIDE_DIR = 'code-conversations-illisibles'
/** Une copie de secours d'un fichier abîmé, déjà rangée sur D. */
const ASIDE_ON_D = 'code-conversations-2026-10-01T10-00-00-000Z.json'
/**
 * Écrit par l'ancienne version : la conversation d'une application rangée sous son chemin ABSOLU (sur C, avant le
 * déplacement) ; elle doit se retrouver sous le nom du dossier de l'application, où qu'il soit désormais.
 */
const CODE_FILE_BEFORE = {
  version: 1,
  repos: [{ fullName: 'leo/site', at: 5 }],
  conversations: {
    'app:C:\\Users\\leo\\AppData\\Roaming\\Jaris\\generated-apps\\1750000000000-snake': codeTurns('un snake'),
    'repo:leo/site': codeTurns('corrige le README')
  }
}

/** Tout ce qu'un Jaris utilisé a dans ses données en plus des conversations et du profil. */
async function fillForgottenData(jaris) {
  assert.equal(await jaris.github.saveGithubToken({ token: GITHUB_TOKEN, refreshToken: GITHUB_REFRESH, expiresAt: 42 }), true)
  const { token: phoneToken } = await jaris.devices.add('iPhone de Léo')
  mkdirSync(join(jaris.dataRoot, 'phone-tunnel', 'certs'), { recursive: true })
  writeFileSync(join(jaris.dataRoot, 'phone-tunnel', 'tailscaled.state'), '{"_machinekey":"mkey:pc-de-leo"}')
  writeFileSync(join(jaris.dataRoot, 'phone-tunnel', 'certs', 'jaris.ts.net.crt'), 'certificat')
  writeFileSync(join(jaris.dataRoot, CODE_FILE), JSON.stringify(CODE_FILE_BEFORE))
  mkdirSync(join(jaris.dataRoot, ASIDE_DIR), { recursive: true })
  writeFileSync(join(jaris.dataRoot, ASIDE_DIR, ASIDE_ON_D), '{ abîmé sur D')
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
  // Relues avec le vrai store, comme le mode Code les relira : l'application sous le nom de son dossier, le dépôt avec
  // ses messages d'avant (suivis, éventuellement, de ceux d'une session sur C), la copie de secours de D intacte.
  const code = new CodeConversationsStore(join(jaris.dataRoot, CODE_FILE)).load()
  assert.deepEqual(code.conversations['app:1750000000000-snake'], codeTurns('un snake'), 'conversation de l’application perdue')
  assert.deepEqual(code.conversations['repo:leo/site']?.slice(0, 2), codeTurns('corrige le README'), 'historique du dépôt perdu')
  assert.ok(code.repos.some((repo) => repo.fullName === 'leo/site'))
  assert.equal(readFileSync(join(jaris.dataRoot, ASIDE_DIR, ASIDE_ON_D), 'utf8'), '{ abîmé sur D')
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

test('disque débranché puis rebranché : jeton GitHub, téléphone, mode Code et tests de modèles de D jamais écrasés par ceux de C', async () => {
  const { userData, root } = setupUserData()
  const before = startJaris(userData)
  const phoneToken = await fillForgottenData(before)
  await before.github.writeConnectionRecord({ connectedAt: 1, login: 'leo', memoryOnly: false, rejectedAt: null })
  const newRoot = join(root, 'D', 'Jaris')
  await moveData(before, null, newRoot)
  await startJaris(userData).storageRoot.cleanupStaleChromiumData()

  // Disque débranché : Jaris démarre sur C (dossier de Chromium neuf, donc AUTRE clé), Léo s'y reconnecte à GitHub,
  // et l'accès téléphone s'y crée une nouvelle identité avec un nouveau téléphone.
  const unplugged = `${newRoot}-debranche`
  renameSync(newRoot, unplugged)
  const onC = startJaris(userData)
  assert.equal(onC.dataRoot, userData, 'disque absent : Jaris tourne sur l’emplacement par défaut')
  assert.equal(await onC.github.saveGithubToken('gho_jeton_cree_sur_C'), true)
  await onC.github.writeConnectionRecord({ connectedAt: 2, login: 'compte-sur-C', memoryOnly: false, rejectedAt: null })
  mkdirSync(join(userData, 'phone-tunnel'), { recursive: true })
  writeFileSync(join(userData, 'phone-tunnel', 'tailscaled.state'), '{"_machinekey":"mkey:identite-neuve"}')
  await onC.devices.add('Téléphone ajouté sur C')
  // Et le mode Code sur C : une application créée là, le même dépôt repris (numéroté à partir de 1, lui aussi), un
  // test de modèles lancé, et une copie de secours au MÊME nom qu'une de D, au contenu différent.
  const codeOnC = new CodeConversationsStore(join(userData, CODE_FILE))
  const pongOnC = join(userData, 'generated-apps', '1760000000000-pong')
  mkdirSync(pongOnC, { recursive: true })
  writeFileSync(join(pongOnC, 'index.html'), '<html>Pong</html>')
  codeOnC.setConversation(sharedCodeConversations.appConversationKey(pongOnC), codeTurns('un pong'))
  codeOnC.setConversation('repo:leo/site', codeTurns('ajoute une page contact'))
  codeOnC.setRepos([{ fullName: 'leo/site', at: 9 }])
  writeFileSync(join(userData, 'benchmark-nouveaux-modeles.md'), '# Session sur C')
  writeFileSync(join(userData, 'benchmark-nouveaux-modeles.traces.jsonl'), '{"type":"session-sur-C"}\n')
  writeFileSync(join(userData, 'benchmark-nouveaux-modeles.md.telecharges.json'), '["qwen3:0.6b"]')
  mkdirSync(join(userData, ASIDE_DIR), { recursive: true })
  writeFileSync(join(userData, ASIDE_DIR, ASIDE_ON_D), '{ abîmé sur C')
  writeFileSync(join(userData, ASIDE_DIR, 'code-conversations-2026-10-02T08-00-00-000Z.json'), '{ autre copie')

  // Disque rebranché.
  renameSync(unplugged, newRoot)
  const after = startJaris(userData)
  await after.storageRoot.cleanupStaleChromiumData()
  assert.equal(after.dataRoot, join(newRoot, 'jaris-data'))
  await assertForgottenDataReadable(after, phoneToken)
  assert.equal((await after.github.readConnectionRecord())?.login, 'leo', 'la trace décrit le jeton gardé')
  assert.deepEqual((await after.devices.list()).map((d) => d.name), ['iPhone de Léo'])

  // Les deux historiques du mode Code sont RÉUNIS, rien de D ni de C n'est perdu.
  const code = new CodeConversationsStore(join(after.dataRoot, CODE_FILE)).load()
  const pongOnD = join(after.dataRoot, 'generated-apps', '1760000000000-pong')
  assert.equal(readFileSync(join(pongOnD, 'index.html'), 'utf8'), '<html>Pong</html>')
  assert.deepEqual(
    code.conversations[sharedCodeConversations.appConversationKey(pongOnD)],
    codeTurns('un pong'),
    'l’application créée sur C retrouve sa conversation par son nouveau chemin, sur D'
  )
  const site = code.conversations['repo:leo/site']
  assert.deepEqual(site.map((turn) => turn.text), ['corrige le README', 'Fait.', 'ajoute une page contact', 'Fait.'])
  assert.equal(new Set(site.map((turn) => turn.id)).size, site.length, 'deux messages au même numéro')
  assert.deepEqual(code.repos, [{ fullName: 'leo/site', at: 9 }])
  // Copies de secours : celle de D intacte (vérifié plus haut), celle de C au même nom gardée à côté, l'autre ajoutée.
  const asideDir = join(after.dataRoot, ASIDE_DIR)
  assert.deepEqual(
    readdirSync(asideDir).sort(),
    [ASIDE_ON_D, 'code-conversations-2026-10-01T10-00-00-000Z-2.json', 'code-conversations-2026-10-02T08-00-00-000Z.json'].sort()
  )
  assert.equal(readFileSync(join(asideDir, 'code-conversations-2026-10-01T10-00-00-000Z-2.json'), 'utf8'), '{ abîmé sur C')
  assert.deepEqual(readdirSync(userData), ['storage-location.json'], 'les copies laissées sur C sont effacées')
  rmSync(root, { recursive: true, force: true })
})

/** Deux dossiers de données vides, et la racine de stockage chargée (sans repère : rien n'est déplacé au chargement). */
function setupMerge(storageModules) {
  const { userData, root } = setupUserData()
  const from = join(root, 'C', 'Jaris')
  const to = join(root, 'D', 'Jaris-data', 'jaris-data')
  mkdirSync(from, { recursive: true })
  mkdirSync(to, { recursive: true })
  const { storageRoot } = loadStorage(userData, { storageModules })
  return { root, from, to, storageRoot }
}

const codeFile = (conversations) => JSON.stringify({ version: 1, repos: [], conversations })

test('rebranché, démarrage coupé juste après la fusion (originaux pas encore effacés) : le suivant ne double rien', () => {
  const { root, from, to, storageRoot } = setupMerge()
  writeFileSync(join(to, CODE_FILE), codeFile({ 'repo:leo/site': codeTurns('corrige le README') }))
  mkdirSync(join(to, ASIDE_DIR), { recursive: true })
  writeFileSync(join(to, ASIDE_DIR, ASIDE_ON_D), '{ abîmé sur D')
  const fromC = codeFile({ 'repo:leo/site': codeTurns('ajoute une page contact'), 'app:1760000000000-pong': codeTurns('un pong') })
  const putBackOriginals = () => {
    writeFileSync(join(from, CODE_FILE), fromC)
    mkdirSync(join(from, ASIDE_DIR), { recursive: true })
    writeFileSync(join(from, ASIDE_DIR, ASIDE_ON_D), '{ abîmé sur C')
    writeFileSync(join(from, ASIDE_DIR, 'code-conversations-2026-10-02T08-00-00-000Z.json'), '{ autre copie')
  }
  putBackOriginals()

  storageRoot.moveOwnedEntriesSync(from, to)
  const once = readFileSync(join(to, CODE_FILE), 'utf8')
  assert.equal(JSON.parse(once).conversations['repo:leo/site'].length, 4)
  const asideOnce = readdirSync(join(to, ASIDE_DIR)).sort()
  assert.equal(asideOnce.length, 3)
  // Coupure entre la fusion et l'effacement des originaux : ils sont encore sur C au démarrage suivant.
  putBackOriginals()
  storageRoot.moveOwnedEntriesSync(from, to)
  assert.equal(readFileSync(join(to, CODE_FILE), 'utf8'), once, 'des messages ont été doublés')
  assert.deepEqual(readdirSync(join(to, ASIDE_DIR)).sort(), asideOnce, 'une copie de secours a été doublée (…-3.json)')
  rmSync(root, { recursive: true, force: true })
})

test('rebranché, fusion écrite puis démarrage abandonné, la conversation continue sur C : le suivant n’en double rien', () => {
  // Un original de C refuse d'être effacé APRÈS la fusion (antivirus) : le démarrage lève, Jaris tourne sur C, où le
  // code-conversations.json de C est toujours là, et Léo y continue la même conversation.
  const realFs = nodeRequire('node:fs')
  let lockedOriginal = null
  const setup = setupMerge({
    fs: {
      ...realFs,
      rmSync: (target, ...rest) => {
        if (target === lockedOriginal) throw Object.assign(new Error('EPERM: fichier ouvert par un antivirus'), { code: 'EPERM' })
        return realFs.rmSync(target, ...rest)
      }
    }
  })
  writeFileSync(join(setup.to, CODE_FILE), codeFile({ 'repo:leo/site': codeTurns('corrige le README') }))
  writeFileSync(join(setup.from, CODE_FILE), codeFile({ 'repo:leo/site': codeTurns('ajoute une page contact') }))
  writeFileSync(join(setup.from, 'reminders.json'), '[]')
  lockedOriginal = join(setup.from, 'reminders.json')
  assert.throws(() => setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to), /EPERM/)
  assert.equal(JSON.parse(readFileSync(join(setup.to, CODE_FILE), 'utf8')).conversations['repo:leo/site'].length, 4, 'fusion écrite sur D')

  // Session sur C : la conversation y continue, avec le store réel (numérotation de C).
  const onC = new CodeConversationsStore(join(setup.from, CODE_FILE))
  const continued = [...onC.load().conversations['repo:leo/site'], ...codeTurns('ajoute un formulaire', 3)]
  onC.setConversation('repo:leo/site', continued)

  // Démarrage suivant : l'antivirus a lâché le fichier.
  lockedOriginal = null
  setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to)
  const site = new CodeConversationsStore(join(setup.to, CODE_FILE)).load().conversations['repo:leo/site']
  assert.deepEqual(
    site.map((turn) => turn.text),
    ['corrige le README', 'Fait.', 'ajoute une page contact', 'Fait.', 'ajoute un formulaire', 'Fait.'],
    'des messages déjà réunis ont été recopiés'
  )
  assert.equal(new Set(site.map((turn) => turn.id)).size, site.length, 'deux messages au même numéro')
  assert.ok(!existsSync(join(setup.from, CODE_FILE)), 'l’original de C est effacé une fois réuni')
  rmSync(setup.root, { recursive: true, force: true })
})

test('rebranché, un renommage refusé un instant (antivirus) est réessayé : la racine D n’est pas abandonnée pour si peu', () => {
  const realFs = nodeRequire('node:fs')
  const refusals = new Map()
  const setup = setupMerge({
    fs: {
      ...realFs,
      renameSync: (from, to) => {
        const left = refusals.get(to) ?? 0
        if (left !== 0) {
          refusals.set(to, left - 1)
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
        }
        return realFs.renameSync(from, to)
      }
    }
  })
  const fromD = codeFile({ 'repo:leo/site': codeTurns('corrige le README') })
  writeFileSync(join(setup.to, CODE_FILE), fromD)
  writeFileSync(join(setup.from, CODE_FILE), codeFile({ 'app:1760000000000-pong': codeTurns('un pong') }))
  writeFileSync(join(setup.from, 'benchmark-nouveaux-modeles.md'), '# Session sur C')
  // Réunion des conversations (fichier écrit puis renommé) ET copie d'un fichier absent de D (copie puis renommage) :
  // chacune refusée deux fois avant de passer.
  refusals.set(join(setup.to, CODE_FILE), 2)
  refusals.set(join(setup.to, 'benchmark-nouveaux-modeles.md'), 2)
  setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to)
  const merged = new CodeConversationsStore(join(setup.to, CODE_FILE)).load().conversations
  assert.deepEqual(Object.keys(merged).sort(), ['app:1760000000000-pong', 'repo:leo/site'])
  assert.equal(readFileSync(join(setup.to, 'benchmark-nouveaux-modeles.md'), 'utf8'), '# Session sur C')
  assert.deepEqual(readdirSync(setup.to).filter((name) => name.endsWith('.jaris-copie')), [], 'copie temporaire laissée')

  // Un refus qui DURE remonte quand même (le démarrage suivant réessaiera) : rien n'est abîmé, rien ne traîne.
  writeFileSync(join(setup.to, CODE_FILE), fromD)
  writeFileSync(join(setup.from, CODE_FILE), codeFile({ 'app:1760000000000-pong': codeTurns('un pong') }))
  refusals.set(join(setup.to, CODE_FILE), -1)
  assert.throws(() => setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to), /EPERM/)
  assert.equal(readFileSync(join(setup.to, CODE_FILE), 'utf8'), fromD)
  assert.ok(existsSync(join(setup.from, CODE_FILE)), 'l’original de C a été effacé sans être réuni')
  assert.deepEqual(readdirSync(setup.to).filter((name) => name.endsWith('.jaris-copie')), [], 'copie temporaire laissée')
  rmSync(setup.root, { recursive: true, force: true })
})

test('rebranché, un code-conversations.json abîmé n’est jamais perdu : mis de côté, l’autre sert', () => {
  // Celui de D est abîmé : mis de côté (comme le store l'aurait fait), celui de C sert.
  let setup = setupMerge()
  writeFileSync(join(setup.to, CODE_FILE), '{ abîmé sur D')
  writeFileSync(join(setup.from, CODE_FILE), codeFile({ 'app:1760000000000-pong': codeTurns('un pong') }))
  setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to)
  assert.deepEqual(new CodeConversationsStore(join(setup.to, CODE_FILE)).load().conversations['app:1760000000000-pong'], codeTurns('un pong'))
  let aside = readdirSync(join(setup.to, ASIDE_DIR))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(setup.to, ASIDE_DIR, aside[0]), 'utf8'), '{ abîmé sur D')
  rmSync(setup.root, { recursive: true, force: true })

  // Celui de C est abîmé : mis de côté, celui de D reste tel quel — une seule fois, même si le démarrage est rejoué.
  setup = setupMerge()
  const fromD = codeFile({ 'repo:leo/site': codeTurns('corrige le README') })
  writeFileSync(join(setup.to, CODE_FILE), fromD)
  for (let boot = 0; boot < 2; boot++) {
    writeFileSync(join(setup.from, CODE_FILE), '{ abîmé sur C')
    setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to)
    // Une autre milliseconde, donc un autre nom daté : seul le contenu identique doit empêcher une seconde copie.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  assert.equal(readFileSync(join(setup.to, CODE_FILE), 'utf8'), fromD)
  aside = readdirSync(join(setup.to, ASIDE_DIR))
  assert.equal(aside.length, 1, `copie de secours doublée : ${aside}`)
  assert.equal(readFileSync(join(setup.to, ASIDE_DIR, aside[0]), 'utf8'), '{ abîmé sur C')
  rmSync(setup.root, { recursive: true, force: true })
})

test('rebranché, code-conversations.json de D verrouillé un instant : rien n’est touché, le démarrage suivant réessaie', () => {
  const realFs = nodeRequire('node:fs')
  let locked = null
  const setup = setupMerge({
    fs: {
      ...realFs,
      readFileSync: (file, ...rest) => {
        if (file === locked) throw Object.assign(new Error('EBUSY: fichier ouvert par un antivirus'), { code: 'EBUSY' })
        return realFs.readFileSync(file, ...rest)
      }
    }
  })
  const fromD = codeFile({ 'repo:leo/site': codeTurns('corrige le README') })
  const fromC = codeFile({ 'app:1760000000000-pong': codeTurns('un pong') })
  writeFileSync(join(setup.to, CODE_FILE), fromD)
  writeFileSync(join(setup.from, CODE_FILE), fromC)
  locked = join(setup.to, CODE_FILE)
  assert.throws(() => setup.storageRoot.moveOwnedEntriesSync(setup.from, setup.to), /EBUSY/)
  assert.equal(readFileSync(join(setup.to, CODE_FILE), 'utf8'), fromD, 'un fichier momentanément illisible a été touché')
  assert.equal(readFileSync(join(setup.from, CODE_FILE), 'utf8'), fromC, 'l’original de C a été effacé sans être réuni')
  assert.ok(!existsSync(join(setup.to, ASIDE_DIR)), 'un simple refus passager ne met rien de côté')
  rmSync(setup.root, { recursive: true, force: true })
})

test('mise à jour après une session disque débranché : le jeton du dossier de Chromium de la racine passe avant celui de C', async () => {
  const { userData, root } = setupUserData()
  const rootA = join(root, 'D', 'Jaris-data')
  const electronA = join(rootA, 'electron')
  mkdirSync(electronA, { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: rootA }))
  // Version d'avant : le jeton de D rangé dans le dossier de Chromium de D, chiffré avec SA clé…
  writeFileSync(join(electronA, 'github-token.bin'), chromiumSafeStorage({ getPath: () => electronA }).encryptString(GITHUB_TOKEN))
  // … et, laissé sur C par une session disque débranché, un autre jeton chiffré avec la clé de C.
  writeFileSync(join(userData, 'github-token.bin'), chromiumSafeStorage({ getPath: () => userData }).encryptString('gho_jeton_cree_sur_C'))

  const jaris = startJaris(userData)
  await jaris.storageRoot.cleanupStaleChromiumData()
  assert.equal(await jaris.github.loadGithubToken(), GITHUB_TOKEN, 'le jeton lisible avec la clé de D doit être gardé')
  assert.deepEqual(readdirSync(userData), ['storage-location.json'])
  rmSync(root, { recursive: true, force: true })
})

/** Faux `fs` dont la copie de `source` s'arrête en route (disque plein) après avoir écrit un morceau. */
function fsWithInterruptedCopy(source) {
  const realFs = nodeRequire('node:fs')
  return {
    ...realFs,
    renameSync: (from, to) => {
      if (from === source) throw Object.assign(new Error('EPERM: renommage refusé'), { code: 'EPERM' })
      return realFs.renameSync(from, to)
    },
    cpSync: (from, to, options) => {
      if (from !== source) return realFs.cpSync(from, to, options)
      realFs.mkdirSync(to, { recursive: true })
      realFs.writeFileSync(join(to, 'certs-a-moitie'), 'x')
      throw Object.assign(new Error('ENOSPC: plus de place'), { code: 'ENOSPC' })
    }
  }
}

test('rapatriement interrompu en route : aucune copie partielle n’est prise pour la bonne, le démarrage suivant reprend tout', () => {
  const { userData, root } = setupUserData()
  const rootA = join(root, 'D', 'Jaris-data')
  const legacy = join(rootA, 'electron', 'phone-tunnel')
  mkdirSync(join(legacy, 'certs'), { recursive: true })
  writeFileSync(join(legacy, 'tailscaled.state'), '{"_machinekey":"mkey:pc-de-leo"}')
  writeFileSync(join(legacy, 'certs', 'jaris.ts.net.crt'), 'certificat')
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: rootA }))
  const dataDir = join(rootA, 'jaris-data')

  loadStorage(userData, { storageModules: { fs: fsWithInterruptedCopy(legacy) } })
  assert.ok(!existsSync(join(dataDir, 'phone-tunnel')), 'une copie coupée ne doit rien laisser : elle serait sautée pour toujours')
  assert.ok(!existsSync(join(dataDir, 'phone-tunnel.jaris-copie')))
  assert.ok(existsSync(join(legacy, 'tailscaled.state')), 'l’original est intact')

  const { dataLocation } = loadStorage(userData)
  assert.equal(readFileSync(join(dataLocation.getDataRoot(), 'phone-tunnel', 'tailscaled.state'), 'utf8'), '{"_machinekey":"mkey:pc-de-leo"}')
  assert.equal(readFileSync(join(dataLocation.getDataRoot(), 'phone-tunnel', 'certs', 'jaris.ts.net.crt'), 'utf8'), 'certificat')
  assert.ok(!existsSync(legacy))
  rmSync(root, { recursive: true, force: true })
})

test('installé sur D, copie depuis C interrompue : l’identité du téléphone n’est jamais laissée à moitié à destination', () => {
  const { userData, root } = setupUserData()
  const source = join(userData, 'phone-tunnel')
  mkdirSync(join(source, 'certs'), { recursive: true })
  writeFileSync(join(source, 'tailscaled.state'), '{"_machinekey":"mkey:pc-de-leo"}')
  writeFileSync(join(source, 'certs', 'jaris.ts.net.crt'), 'certificat')
  const chosen = join(root, 'D', 'Jaris-data')
  mkdirSync(chosen, { recursive: true })
  writeFileSync(join(userData, 'storage-location.json'), JSON.stringify({ root: chosen }))

  const first = loadStorage(userData, { storageModules: { fs: fsWithInterruptedCopy(source) } })
  assert.equal(first.storageRoot.getStorageRoot(), null, 'copie ratée : Jaris démarre sur l’emplacement par défaut')
  assert.ok(!existsSync(join(chosen, 'jaris-data', 'phone-tunnel')), 'rien de partiel à destination')
  assert.ok(existsSync(join(source, 'tailscaled.state')))

  const { dataLocation } = loadStorage(userData)
  assert.equal(readFileSync(join(dataLocation.getDataRoot(), 'phone-tunnel', 'certs', 'jaris.ts.net.crt'), 'utf8'), 'certificat')
  assert.ok(!existsSync(source))
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

  // electron/ ET shared/ : un nom de fichier partagé avec l'écran vit dans shared/ (ex. code-conversations.json).
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const rel = (file) => nodePath.relative(repo, file).split(nodePath.sep).join('/')
  const sources = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) sources.push({ file: rel(full), ast: ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.ES2022, true) })
    }
  }
  walk(join(repo, 'electron'))
  walk(join(repo, 'shared'))
  const visit = (node, fn) => {
    fn(node)
    ts.forEachChild(node, (child) => visit(child, fn))
  }

  // Constantes texte : celles d'un fichier valent pour lui, les exportées pour tous.
  const exported = new Map()
  const local = new Map()
  for (const { file, ast } of sources) {
    const mine = new Map()
    visit(ast, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer || !ts.isStringLiteral(node.initializer)) return
      if (!(node.parent.flags & ts.NodeFlags.Const)) return
      mine.set(node.name.text, node.initializer.text)
      const statement = node.parent.parent
      if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exported.set(node.name.text, node.initializer.text)
    })
    local.set(file, mine)
  }

  // Lu dans l'ARBRE du code (pas dans le texte) : un commentaire qui cite getDataRoot() ne compte pas, et un usage
  // indirect (variable, paramètre par défaut, fonction passée ailleurs) ne passe plus inaperçu.
  const written = []
  const indirect = new Map()
  for (const { file, ast } of sources) {
    visit(ast, (node) => {
      if (!ts.isIdentifier(node) || node.text !== 'getDataRoot') return
      const parent = node.parent
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || (ts.isFunctionDeclaration(parent) && parent.name === node)) return
      const call = ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 0 ? parent : null
      const join_ = call && ts.isCallExpression(call.parent) && ts.isIdentifier(call.parent.expression) && call.parent.expression.text === 'join' && call.parent.arguments[0] === call ? call.parent : null
      if (!join_) {
        indirect.set(file, (indirect.get(file) ?? 0) + 1)
        return
      }
      const arg = join_.arguments[1]
      const name = arg && ts.isStringLiteral(arg) ? arg.text : arg && ts.isIdentifier(arg) ? local.get(file).get(arg.text) ?? exported.get(arg.text) : undefined
      assert.ok(name, `${file} : nom de fichier introuvable pour ${join_.getText()}`)
      written.push(name)
    })
  }

  // Ceux qui passent par getDataRoot() autrement que join(getDataRoot(), 'nom'). Un nouveau venu fait échouer ce test :
  // l'ajouter ici avec ce qu'il écrit, et vérifier que ces noms sont dans OWNED_ENTRIES.
  const known = {
    // copyDataTo lit le dossier entier pour le copier : n'y écrit rien à lui.
    'electron/services/dataLocation.ts': { uses: 1, writes: [] },
    // Vérifie, mesure et affiche le dossier entier pendant « Déplacer » : n'y écrit rien.
    'electron/services/relocation.ts': { uses: 3, writes: [] },
    // getJournalPath(root = getDataRoot()) puis join(root, 'journal-demandes.txt').
    'electron/services/requestJournal.ts': { uses: 1, writes: ['journal-demandes.txt'] }
  }
  for (const [file, uses] of indirect) {
    assert.ok(
      known[file],
      `${file} utilise getDataRoot() autrement que join(getDataRoot(), 'nom') : ce qu'il y écrit échappe à ce contrôle — l'ajouter à la liste « known » avec ses fichiers`
    )
    assert.equal(uses, known[file].uses, `${file} : usages indirects de getDataRoot() changés, revérifier ce qu'il écrit dans les données`)
  }
  for (const [file, { writes }] of Object.entries(known)) {
    assert.ok(indirect.has(file), `${file} ne passe plus par getDataRoot() indirectement : le retirer de « known »`)
    const text = readFileSync(join(repo, file), 'utf8')
    for (const name of writes) {
      assert.ok(text.includes(`'${name}'`), `${file} n'écrit plus « ${name} » : mettre « known » à jour`)
      written.push(name)
    }
  }

  for (const name of ['github-token.bin', 'phone-tunnel', 'phone-devices.json', 'benchmark-nouveaux-modeles.md', 'searxng-docker', 'journal-demandes.txt']) {
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

test('les entrées liées à une clé ou à une identité ne sont jamais écrasées au démarrage, et suivent toutes « Déplacer »', () => {
  const { userData, root } = setupUserData()
  const { storageRoot } = loadStorage(userData)
  rmSync(root, { recursive: true, force: true })
  for (const name of [
    'github-token.bin',
    'github-connection.json',
    'phone-tunnel',
    'phone-devices.json',
    // Des jours de traces de test : jamais remplacées par celles d'une session lancée disque débranché.
    'benchmark-nouveaux-modeles.md',
    'benchmark-nouveaux-modeles.traces.jsonl',
    'benchmark-nouveaux-modeles.md.telecharges.json'
  ]) {
    assert.ok(storageRoot.KEPT_AT_DESTINATION_ENTRIES.includes(name), `${name} doit être protégé`)
  }
  // Réunies, jamais l'un par-dessus l'autre : ni gardées telles quelles (la session sur C serait perdue), ni écrasées.
  for (const name of ['code-conversations.json', 'code-conversations-illisibles']) {
    assert.ok(!storageRoot.KEPT_AT_DESTINATION_ENTRIES.includes(name), `${name} doit être réuni, pas ignoré`)
  }
  for (const name of storageRoot.KEPT_AT_DESTINATION_ENTRIES) assert.ok(storageRoot.OWNED_ENTRIES.includes(name), `${name} doit aussi suivre « Déplacer »`)
})

test('« Déplacer » arrête d’abord ce qui écrit dans les données : accès téléphone et test de modèles', () => {
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const handlerAt = source.indexOf('IPC_CHANNELS.chooseModelsLocation, async')
  const handler = source.slice(handlerAt, source.indexOf('IPC_CHANNELS.getRuntimeSetupStatus', handlerAt))
  const moveAt = handler.indexOf('relocateEverything(')
  // ATTENDUS (await) : un programme encore en train de sortir garde ses fichiers ouverts, et Windows refuse alors de
  // les effacer de l'ancien dossier.
  for (const stop of ['await stopModelTest()', 'await phoneAccess?.disable()']) {
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

test('les copies de secours d’un code-conversations.json illisible suivent aussi « Déplacer » (étape 319)', () => {
  // Rangées à côté du fichier (codeConversationsStore.ts), pas via join(getDataRoot(), …) : le balayage ci-dessus ne
  // peut pas les voir. Sans cette entrée, un « Déplacer » depuis un ancien jaris-data effaçait la seule copie.
  const { userData, root } = setupUserData()
  const { storageRoot } = loadStorage(userData)
  rmSync(root, { recursive: true, force: true })
  const shared = readFileSync(new URL('../shared/codeConversations.ts', import.meta.url), 'utf8')
  const aside = shared.match(/export const CODE_CONVERSATIONS_ASIDE_DIR = '([^']+)'/)
  assert.ok(aside, 'la constante du dossier de secours existe')
  assert.ok(storageRoot.OWNED_ENTRIES.includes(aside[1]), `${aside[1]} est dans OWNED_ENTRIES`)
  const store = readFileSync(new URL('../electron/services/codeConversationsStore.ts', import.meta.url), 'utf8')
  assert.match(store, /join\(dirname\(filePath\), CODE_CONVERSATIONS_ASIDE_DIR,/, 'le dossier de secours est bien à côté du fichier, dans les données')
})
