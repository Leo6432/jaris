import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Reprise des conversations du mode Code : l'ancienne version les gardait dans le stockage de la fenêtre
 * (localStorage, dans le dossier de Chromium que « Déplacer » efface). Au premier lancement de la nouvelle version,
 * elles passent dans code-conversations.json (dossier de données), et ne quittent le localStorage qu'une fois
 * l'écriture CONFIRMÉE par le main. Le vrai module de l'écran, avec un faux main puis avec le vrai fichier.
 */
const shared = loadTsModule('shared/codeConversations.ts')
const Store = loadTsModule('electron/services/codeConversationsStore.ts', {
  fs: realFs,
  path,
  '../../shared/codeConversations': shared
}).CodeConversationsStore

/** Un module neuf à chaque fois : comme un écran qui s'ouvre (sa copie en mémoire repart de zéro). */
const loadScreen = () => loadTsModule('src/lib/codeConversations.ts', { '../../shared/codeConversations': shared })

class FakeStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries))
  }
  get length() {
    return this.map.size
  }
  key(index) {
    return [...this.map.keys()][index] ?? null
  }
  getItem(name) {
    return this.map.has(name) ? this.map.get(name) : null
  }
  setItem(name, value) {
    this.map.set(name, String(value))
  }
  removeItem(name) {
    this.map.delete(name)
  }
}

function install({ storage, jaris }) {
  if (storage) globalThis.localStorage = storage
  else delete globalThis.localStorage
  globalThis.window = jaris ? { jaris } : {}
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const flush = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve))
}
const turns = (text) => [{ id: 1, kind: 'user', text }, { id: 2, kind: 'reply', text: 'Fait.' }]

/** Faux main : un « fichier » en mémoire, et la reprise qu'on peut confirmer ou refuser à la main. */
function fakeMain(file = { repos: [], conversations: {} }) {
  const calls = { save: [], repos: [], imports: [] }
  let settle = null
  const jaris = {
    loadCodeConversations: () => clone(file),
    saveCodeConversation: (key, value) => {
      calls.save.push([key, value])
      return Promise.resolve()
    },
    saveCodeRepos: (repos) => {
      calls.repos.push(repos)
      return Promise.resolve()
    },
    importCodeConversations: (data) => {
      calls.imports.push(clone(data))
      return new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
    }
  }
  return { jaris, calls, confirm: () => settle.resolve(), refuse: () => settle.reject(new Error('disque plein')) }
}

const legacyEntries = () => ({
  'jaris.codeRepos': JSON.stringify([{ fullName: 'leo/projet', at: 5 }]),
  'jaris.codeConversation.app:C:/apps/snake': JSON.stringify(turns('un snake')),
  'jaris.codeConversation.repo:leo/projet': JSON.stringify(turns('corrige le README')),
  // Autres réglages de la fenêtre : jamais touchés par la reprise.
  'jaris.codeChatWidth': '420',
  // Entrée abîmée : laissée où elle est plutôt que perdue.
  'jaris.codeConversation.app:C:/apps/abime': '{ pas fini'
})

test('reprise : affichée tout de suite, écrite dans le fichier, PUIS retirée du stockage de la fenêtre', async () => {
  const storage = new FakeStorage(legacyEntries())
  const main = fakeMain()
  install({ storage, jaris: main.jaris })
  const screen = loadScreen()

  assert.deepEqual(screen.loadRecentRepos(), [{ fullName: 'leo/projet', at: 5 }])
  assert.equal(screen.loadConversation('app:C:/apps/snake')[0].text, 'un snake')
  assert.equal(screen.loadConversation('repo:leo/projet')[0].text, 'corrige le README')
  assert.equal(main.calls.imports.length, 1, 'la reprise n’est pas envoyée au main')
  // L'ancienne clé « app:<chemin> » part au main sous le nom du dossier : c'est ce que l'écran demandera ensuite.
  assert.deepEqual(Object.keys(main.calls.imports[0].conversations).sort(), ['app:snake', 'repo:leo/projet'])

  // Tant que le main n'a pas confirmé l'écriture, rien ne quitte le stockage de la fenêtre.
  await flush()
  assert.equal(storage.length, 5, 'des données ont quitté le localStorage avant que le fichier soit écrit')

  main.confirm()
  await flush()
  assert.deepEqual([...storage.map.keys()].sort(), ['jaris.codeChatWidth', 'jaris.codeConversation.app:C:/apps/abime'])
})

test('écriture refusée par le main : le stockage de la fenêtre garde tout, pour réessayer au lancement suivant', async () => {
  const storage = new FakeStorage(legacyEntries())
  const main = fakeMain()
  install({ storage, jaris: main.jaris })
  const screen = loadScreen()
  assert.equal(screen.loadConversation('app:C:/apps/snake')[0].text, 'un snake', 'la session affiche quand même les conversations')
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    main.refuse()
    await flush()
  } finally {
    console.error = original
  }
  assert.equal(storage.length, 5, 'une reprise ratée a vidé le localStorage')
  assert.equal(errors.length, 1)
})

test('une conversation déjà dans le fichier garde sa version ; aucune reprise sans ancien stockage', async () => {
  const storage = new FakeStorage(legacyEntries())
  const main = fakeMain({ repos: [], conversations: { 'app:C:/apps/snake': turns('version du fichier') } })
  install({ storage, jaris: main.jaris })
  assert.equal(loadScreen().loadConversation('app:C:/apps/snake')[0].text, 'version du fichier')

  const empty = fakeMain({ repos: [{ fullName: 'leo/site', at: 1 }], conversations: {} })
  install({ storage: new FakeStorage({ 'jaris.codeChatWidth': '420' }), jaris: empty.jaris })
  assert.deepEqual(loadScreen().loadRecentRepos(), [{ fullName: 'leo/site', at: 1 }])
  assert.equal(empty.calls.imports.length, 0)
})

test('main muet (fichier non lu) : l’écran n’écrit RIEN ; seule la reprise part, et c’est le main qui décide', async () => {
  for (const loadCodeConversations of [() => null, () => { throw new Error('pas de réponse') }, () => Promise.resolve(null)]) {
    const storage = new FakeStorage(legacyEntries())
    const main = fakeMain()
    install({ storage, jaris: { ...main.jaris, loadCodeConversations } })
    const screen = loadScreen()
    screen.rememberRepo('leo/autre')
    screen.saveConversation('app:C:/apps/neuve', turns('nouvelle'))
    screen.forgetConversation('app:C:/apps/snake')
    assert.equal(screen.loadConversation('app:C:/apps/neuve')[0].text, 'nouvelle', 'gardée au moins le temps de la session')
    await flush()
    // Une conversation ou une liste envoyée écraserait le fichier avec ce que l'écran a (presque rien). La reprise,
    // elle, est AJOUTÉE à ce que le main lit sur le disque — et il refuse d'écrire s'il n'a pas pu le lire.
    assert.deepEqual(main.calls.save, [])
    assert.deepEqual(main.calls.repos, [])
    assert.equal(main.calls.imports.length, 1)
    assert.equal(storage.length, 5, 'l’ancien stockage a été vidé sans écriture confirmée')
  }
})

test('reprise lancée à l’ouverture de Jaris, SANS ouvrir l’écran Code : le fichier n’est même pas lu', async () => {
  const storage = new FakeStorage(legacyEntries())
  let loads = 0
  const main = fakeMain()
  install({ storage, jaris: { ...main.jaris, loadCodeConversations: () => (loads++, { repos: [], conversations: {} }) } })
  const screen = loadScreen()
  const first = screen.migrateLegacyCodeConversations()
  // Deux appels pendant l'écriture (ouverture, puis « Déplacer ») : une seule reprise envoyée.
  assert.equal(screen.migrateLegacyCodeConversations(), first)
  await flush()
  assert.equal(main.calls.imports.length, 1)
  assert.equal(loads, 0, 'l’écran Code a été chargé pour rien')
  assert.equal(storage.length, 5)
  main.confirm()
  assert.equal(await first, true)
  assert.deepEqual([...storage.map.keys()].sort(), ['jaris.codeChatWidth', 'jaris.codeConversation.app:C:/apps/abime'])
  // Plus rien à reprendre : rien n'est renvoyé au main.
  assert.equal(await screen.migrateLegacyCodeConversations(), true)
  assert.equal(main.calls.imports.length, 1)
})

test('reprise refusée : `false`, rien ne quitte l’ancien stockage, et l’appel suivant réessaie', async () => {
  const storage = new FakeStorage(legacyEntries())
  const main = fakeMain()
  install({ storage, jaris: main.jaris })
  const screen = loadScreen()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const first = screen.migrateLegacyCodeConversations()
    await flush()
    main.refuse()
    assert.equal(await first, false)
  } finally {
    console.error = original
  }
  assert.equal(storage.length, 5)
  assert.equal(errors.length, 1)

  const second = screen.migrateLegacyCodeConversations()
  await flush()
  assert.equal(main.calls.imports.length, 2, 'la reprise n’a pas été retentée')
  main.confirm()
  assert.equal(await second, true)
  assert.equal(storage.length, 2)
})

test('reprise sans pont vers le main : `false` (jamais « rien à reprendre » alors que tout est encore là)', async () => {
  install({ storage: new FakeStorage(legacyEntries()), jaris: null })
  assert.equal(await loadScreen().migrateLegacyCodeConversations(), false)
  install({ storage: new FakeStorage({ 'jaris.codeChatWidth': '420' }), jaris: null })
  assert.equal(await loadScreen().migrateLegacyCodeConversations(), true)
  install({ storage: null, jaris: fakeMain().jaris })
  assert.equal(await loadScreen().migrateLegacyCodeConversations(), true)
})

test('stockage de la fenêtre refusé (page de test, about:blank) : le mode Code marche quand même', () => {
  const main = fakeMain({ repos: [{ fullName: 'leo/projet', at: 1 }], conversations: {} })
  install({ storage: null, jaris: main.jaris })
  const screen = loadScreen()
  assert.deepEqual(screen.loadRecentRepos(), [{ fullName: 'leo/projet', at: 1 }])
  screen.saveConversation('repo:leo/projet', turns('x'))
  assert.deepEqual(main.calls.save, [['repo:leo/projet', turns('x')]])
  // Rouvrir la conversation la renvoie telle quelle (même liste) : rien n'est réécrit sur le disque.
  screen.saveConversation('repo:leo/projet', screen.loadConversation('repo:leo/projet'))
  assert.equal(main.calls.save.length, 1)
  screen.saveConversation('repo:leo/projet', [])
  assert.deepEqual(main.calls.save.at(-1), ['repo:leo/projet', null], 'une conversation vidée est retirée du fichier')
})

test('de bout en bout avec le vrai fichier : reprise, puis « Déplacer » (nouveau dossier, stockage de la fenêtre vide)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jaris-code-move-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bridgeFor = (store) => ({
    loadCodeConversations: () => clone(store.load()),
    saveCodeConversation: async (key, value) => store.setConversation(key, clone(value)),
    saveCodeRepos: async (repos) => store.setRepos(clone(repos)),
    importCodeConversations: async (data) => store.importLegacy(clone(data))
  })

  // Premier lancement de la nouvelle version, sur l'Agent vocal : l'ancien stockage passe dans le fichier dès
  // l'ouverture (App.tsx), sans que l'écran Code ait été ouvert. L'ancienne version rangeait chaque application sous
  // son chemin ABSOLU, tel que Windows l'écrit.
  const oldData = join(root, 'C', 'Users', 'leo', 'AppData', 'Roaming', 'Jaris')
  const newData = join(root, 'D', 'Jaris-data', 'jaris-data')
  // Le dossier d'une application, tel que codeGenerator.ts le crée : <données>/generated-apps/<horodatage>-<nom>.
  const appPath = (dataRoot, folder) => join(dataRoot, 'generated-apps', folder)
  const oldFile = join(oldData, shared.CODE_CONVERSATIONS_FILE)
  const storage = new FakeStorage({
    ...legacyEntries(),
    'jaris.codeConversation.app:C:\\Users\\leo\\AppData\\Roaming\\Jaris\\generated-apps\\1750000000000-tetris': JSON.stringify(turns('un tetris'))
  })
  install({ storage, jaris: bridgeFor(new Store(oldFile)) })
  assert.equal(await loadScreen().migrateLegacyCodeConversations(), true)
  assert.deepEqual([...storage.map.keys()].sort(), ['jaris.codeChatWidth', 'jaris.codeConversation.app:C:/apps/abime'])
  const screen = loadScreen()
  // Une application créée avant le déplacement : CodePanel range sa conversation sous appConversationKey(result.path).
  screen.saveConversation(screen.appConversationKey(appPath(oldData, '1760000000000-pong')), turns('un pong'))
  await flush()

  // « Déplacer » : les données sont copiées ailleurs (le fichier ET les dossiers des applications, qui changent donc de
  // chemin), le dossier de Chromium (et son localStorage) repart de zéro.
  const newFile = join(newData, shared.CODE_CONVERSATIONS_FILE)
  mkdirSync(path.dirname(newFile), { recursive: true })
  copyFileSync(oldFile, newFile)
  install({ storage: new FakeStorage(), jaris: bridgeFor(new Store(newFile)) })
  const moved = loadScreen()
  assert.deepEqual(moved.loadRecentRepos(), [{ fullName: 'leo/projet', at: 5 }])
  // L'écran demande chaque conversation par le NOUVEAU chemin de l'application (listGeneratedApps lit le nouveau
  // dossier) : elle doit toujours s'afficher.
  assert.equal(moved.loadConversation(moved.appConversationKey(appPath(newData, '1760000000000-pong')))[0]?.text, 'un pong')
  assert.equal(moved.loadConversation(moved.appConversationKey(appPath(newData, 'snake')))[0]?.text, 'un snake')
  assert.equal(moved.loadConversation(moved.appConversationKey(appPath(newData, '1750000000000-tetris')))[0]?.text, 'un tetris')
  assert.equal(moved.loadConversation('repo:leo/projet')[0].text, 'corrige le README')
  // Plus aucun chemin dans le fichier : un prochain « Déplacer » ne peut plus rendre une conversation orpheline.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(newFile, 'utf-8')).conversations).sort(), [
    'app:1750000000000-tetris',
    'app:1760000000000-pong',
    'app:snake',
    'repo:leo/projet'
  ])

  // Retirer un dépôt de la liste l'efface aussi du fichier (et sa conversation avec).
  moved.forgetRepo('leo/projet')
  await flush()
  const reread = new Store(newFile).load()
  assert.deepEqual(reread.repos, [])
  assert.equal(reread.conversations['repo:leo/projet'], undefined)
})
