import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'

const conversationsData = loadTsModule('shared/conversationsData.ts')

/**
 * Plusieurs conversations dans le Chat (étape 96, demande de Léo : "avoir plusieurs conversation sur chat"),
 * là où Jaris n'avait qu'un seul fil continu depuis l'étape 47.
 *
 * Le point le plus sensible n'est pas la fonctionnalité elle-même mais la MIGRATION : tout ce qui a déjà été
 * dit vit dans conversation-history.json, et Léo s'est explicitement inquiété de perdre des données au fil
 * des versions. Un faux système de fichiers en mémoire permet de le vérifier pour de vrai plutôt que de
 * relire le code en espérant.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/conversationStore.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const USER_DATA = '/fake/userData'
const LEGACY = nodePath.join(USER_DATA, 'conversation-history.json')

function entry(transcript, reply, timestamp) {
  return { id: `e-${timestamp}`, timestamp, transcript, reply }
}

/**
 * Faux disque : un simple dictionnaire chemin -> contenu, plus le suivi des dossiers créés.
 * `faults` (étape 325) : `readFile` refusé pour un chemin (`busy`, comme un antivirus qui tient le fichier), ou écriture
 * interrompue au milieu (`cutWrite`, comme une coupure de courant : seule la moitié du contenu arrive sur le disque).
 */
function setup({ files = {}, faults = {} } = {}) {
  const disk = { ...files }
  let uuid = 0
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const fsPromises = {
    readFile: async (path) => {
      if (faults.busy?.has(path)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      if (!(path in disk)) throw enoent()
      return disk[path]
    },
    writeFile: async (path, content) => {
      disk[path] = content
    },
    open: async (path) => ({
      writeFile: async (content) => {
        if (faults.cutWrite) {
          disk[path] = String(content).slice(0, Math.floor(String(content).length / 2))
          throw Object.assign(new Error('EIO: coupure'), { code: 'EIO' })
        }
        disk[path] = String(content)
      },
      sync: async () => {},
      close: async () => {}
    }),
    rename: async (from, to) => {
      if (!(from in disk)) throw enoent()
      disk[to] = disk[from]
      delete disk[from]
    },
    stat: async (path) => {
      if (!(path in disk) && !Object.keys(disk).some((other) => other.startsWith(`${path}${nodePath.sep}`))) throw enoent()
      return {}
    },
    readdir: async (dir) => {
      const prefix = `${dir}${nodePath.sep}`
      const names = Object.keys(disk)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
      if (!names.length && !Object.keys(disk).some((path) => path.startsWith(dir))) {
        throw enoent()
      }
      return names
    },
    rm: async (path) => {
      delete disk[path]
    },
    mkdir: async () => {}
  }
  const modules = {
    electron: { app: { getPath: () => USER_DATA } },
    './dataLocation': { getDataRoot: () => USER_DATA },
    crypto: { randomUUID: () => `id-${++uuid}` },
    'fs/promises': fsPromises,
    // Écritures d'un seul tenant et lectures prudentes (étape 325) : le vrai module, sur le même faux disque.
    './atomicFile': loadTsModule('electron/services/atomicFile.ts', { fs: {}, 'fs/promises': fsPromises, path: nodePath }),
    '../../shared/conversationsData': conversationsData,
    path: nodePath
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: withI18n((name) => modules[name]), module: { exports } })
  return { ...exports, disk }
}

test('un titre est dérivé du premier message, coupé proprement sur un mot', () => {
  const { titleFromMessage, UNTITLED_CONVERSATION } = setup()
  assert.equal(titleFromMessage('Quelle heure est-il ?'), 'Quelle heure est-il ?')
  assert.equal(titleFromMessage('   plusieurs   espaces   '), 'plusieurs espaces')
  assert.equal(titleFromMessage(''), UNTITLED_CONVERSATION)

  const source = 'Explique moi comment fonctionne la photosynthèse des plantes en détail'
  const long = titleFromMessage(source, 30)
  assert.ok(long.length <= 31, long)
  assert.ok(long.endsWith('…'))
  // Coupé sur une VRAIE frontière de mot : le début doit se retrouver tel quel dans le message, et le
  // caractère suivant dans le message doit être un espace — sinon un mot a été tranché en deux.
  const kept = long.slice(0, -1)
  assert.ok(source.startsWith(kept), `"${kept}" n'est pas un début du message`)
  assert.equal(source[kept.length], ' ', `coupé en plein mot : "${long}"`)
})

test("l'ancien historique devient la première conversation, sans rien perdre", async () => {
  const legacy = [
    entry('bonjour jaris', 'Bonjour Léo !', '2026-09-01T10:00:00.000Z'),
    entry('quelle heure', 'Il est midi.', '2026-09-02T12:00:00.000Z')
  ]
  const { listConversations, getConversationHistory, disk } = setup({ files: { [LEGACY]: JSON.stringify(legacy) } })

  const { conversations, activeId } = await listConversations()
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].id, activeId)
  // Titre repris du tout premier message, dates reprises des échanges eux-mêmes.
  assert.equal(conversations[0].title, 'bonjour jaris')
  assert.equal(conversations[0].messageCount, 2)
  assert.equal(conversations[0].createdAt, '2026-09-01T10:00:00.000Z')

  const history = await getConversationHistory()
  assert.equal(history.length, 2)
  assert.equal(history[1].reply, 'Il est midi.')

  // L'ancien fichier n'est JAMAIS supprimé par la migration : il reste comme filet.
  assert.ok(LEGACY in disk)
})

test('sans historique existant, une première conversation vide est créée', async () => {
  const { listConversations, UNTITLED_CONVERSATION } = setup()
  const { conversations } = await listConversations()
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].title, UNTITLED_CONVERSATION)
  assert.equal(conversations[0].messageCount, 0)
})

test("un échange s'écrit dans la conversation active et lui donne son titre", async () => {
  const store = setup()
  await store.appendConversationEntry(entry('comment ça va', 'Très bien.', '2026-09-10T08:00:00.000Z'))
  const { conversations } = await store.listConversations()
  assert.equal(conversations[0].title, 'comment ça va')
  assert.equal(conversations[0].messageCount, 1)

  // Le titre se FIGE sur le premier message : la liste ne doit pas danser à chaque échange.
  await store.appendConversationEntry(entry('et demain ?', 'Il pleuvra.', '2026-09-10T08:01:00.000Z'))
  const after = await store.listConversations()
  assert.equal(after.conversations[0].title, 'comment ça va')
  assert.equal(after.conversations[0].messageCount, 2)
})

test('créer une conversation isole vraiment les messages des deux fils', async () => {
  const store = setup()
  await store.appendConversationEntry(entry('fil un', 'ok', '2026-09-10T08:00:00.000Z'))

  await store.createConversation()
  assert.equal((await store.getConversationHistory()).length, 0, 'le nouveau fil doit être vide')

  await store.appendConversationEntry(entry('fil deux', 'ok', '2026-09-10T09:00:00.000Z'))
  const second = await store.getConversationHistory()
  assert.equal(second.length, 1)
  assert.equal(second[0].transcript, 'fil deux')

  const { conversations } = await store.listConversations()
  assert.equal(conversations.length, 2)
  // Trié du plus récemment utilisé au plus ancien.
  assert.equal(conversations[0].title, 'fil deux')

  // L'ancien fil est intact : revenir dessus le retrouve tel quel.
  const first = conversations[1]
  await store.setActiveConversation(first.id)
  const back = await store.getConversationHistory()
  assert.equal(back.length, 1)
  assert.equal(back[0].transcript, 'fil un')
})

test('cliquer deux fois sur "nouvelle conversation" ne crée pas deux fils vides', async () => {
  const store = setup()
  await store.appendConversationEntry(entry('premier', 'ok', '2026-09-10T08:00:00.000Z'))
  const created = await store.createConversation()
  const again = await store.createConversation()
  assert.equal(created, again)
  assert.equal((await store.listConversations()).conversations.length, 2)
})

test('supprimer une conversation efface ses messages et en laisse toujours une', async () => {
  const store = setup()
  await store.appendConversationEntry(entry('à supprimer', 'ok', '2026-09-10T08:00:00.000Z'))
  const { activeId } = await store.listConversations()

  await store.deleteConversation(activeId)
  const after = await store.listConversations()
  // Jamais zéro conversation : le Chat ne doit pas se retrouver sans fil courant.
  assert.equal(after.conversations.length, 1)
  assert.notEqual(after.activeId, activeId)
  assert.equal((await store.getConversationHistory()).length, 0)
})

test("supprimer un fil INACTIF ne change pas celui qu'on est en train de lire", async () => {
  const store = setup()
  await store.appendConversationEntry(entry('ancien', 'ok', '2026-09-10T08:00:00.000Z'))
  const old = (await store.listConversations()).activeId
  await store.createConversation()
  await store.appendConversationEntry(entry('courant', 'ok', '2026-09-10T09:00:00.000Z'))
  const current = (await store.listConversations()).activeId

  await store.deleteConversation(old)
  const after = await store.listConversations()
  assert.equal(after.activeId, current)
  assert.equal((await store.getConversationHistory())[0].transcript, 'courant')
})

test("l'onglet Historique voit TOUTES les conversations, remises dans l'ordre du temps", async () => {
  const store = setup()
  await store.appendConversationEntry(entry('fil un', 'ok', '2026-09-10T08:00:00.000Z'))
  await store.createConversation()
  await store.appendConversationEntry(entry('fil deux', 'ok', '2026-09-09T08:00:00.000Z'))

  const all = await store.getAllConversationEntries()
  assert.equal(all.length, 2)
  assert.equal(all[0].transcript, 'fil deux', 'le plus ancien en premier, quel que soit son fil')
  assert.equal(all[1].transcript, 'fil un')
})

test('tout effacer ne laisse aucun message, ni dans les fils ni dans l\'ancien fichier', async () => {
  const store = setup({ files: { [LEGACY]: JSON.stringify([entry('vieux', 'ok', '2026-09-01T10:00:00.000Z')]) } })
  await store.appendConversationEntry(entry('récent', 'ok', '2026-09-10T08:00:00.000Z'))

  await store.clearConversationHistory()
  assert.equal((await store.getAllConversationEntries()).length, 0)
  const { conversations } = await store.listConversations()
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].messageCount, 0)
  // L'ancien fichier est vidé lui aussi : sinon la migration le ressortirait juste après avoir tout effacé.
  assert.equal(store.disk[LEGACY], '[]')
})

// ---------------------------------------------------------------------------------------------------------
// Étape 325 : écritures d'un seul tenant, et un fichier illisible n'est plus jamais remplacé en silence. Avant, une
// coupure pendant une écriture tronquait le fichier ; un index tronqué était reconstruit avec UNE conversation neuve
// qui cachait toutes les autres ; un fil tronqué ou verrouillé (antivirus) était lu comme vide, et l'échange suivant
// réécrivait le fichier avec ce seul échange.
// ---------------------------------------------------------------------------------------------------------

const CONVERSATIONS = nodePath.join(USER_DATA, 'conversations')
const INDEX = nodePath.join(CONVERSATIONS, 'index.json')
const ASIDE = nodePath.join(USER_DATA, 'fichiers-illisibles')
/** Les copies de secours rangées sur le faux disque, sous la forme `nom → contenu`. */
const asideCopies = (disk) =>
  Object.fromEntries(Object.entries(disk).filter(([path]) => path.startsWith(`${ASIDE}${nodePath.sep}`)).map(([path, text]) => [nodePath.basename(path), text]))

test('index tronqué : rangé de côté, et TOUTES les conversations restent visibles', async () => {
  const store = setup()
  await store.appendConversationEntry(entry('fil un', 'ok', '2026-09-10T08:00:00.000Z'))
  await store.createConversation()
  await store.appendConversationEntry(entry('fil deux', 'ok', '2026-09-10T09:00:00.000Z'))
  const truncated = store.disk[INDEX].slice(0, 40)
  store.disk[INDEX] = truncated

  const { conversations, activeId } = await store.listConversations()
  assert.equal(conversations.map((c) => c.title).sort().join(' | '), ['fil deux', 'fil un'].join(' | '), 'des conversations ont été cachées')
  assert.equal(conversations.find((c) => c.id === activeId)?.title, 'fil deux', 'la plus récente redevient active')
  const copies = Object.entries(asideCopies(store.disk))
  assert.equal(copies.length, 1)
  assert.match(copies[0][0], /^conversations-index-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
  assert.equal(copies[0][1], truncated, 'l’index abîmé est gardé tel quel')
})

test('fil tronqué : rangé de côté avant que l’échange suivant n’écrive un fichier neuf', async () => {
  const store = setup()
  await store.appendConversationEntry(entry('premier', 'ok', '2026-09-10T08:00:00.000Z'))
  const { activeId } = await store.listConversations()
  const file = nodePath.join(CONVERSATIONS, `${activeId}.json`)
  const truncated = store.disk[file].slice(0, 30)
  store.disk[file] = truncated

  await store.appendConversationEntry(entry('deuxième', 'ok', '2026-09-10T08:01:00.000Z'))
  assert.equal((await store.getConversationHistory()).map((e) => e.transcript).join(' | '), ['deuxième'].join(' | '))
  assert.deepEqual(Object.values(asideCopies(store.disk)), [truncated], 'le fil abîmé a été écrasé sans copie')
  assert.match(Object.keys(asideCopies(store.disk))[0], new RegExp(`^conversation-${activeId}-`))

  // « Supprimer l'historique » ne laisse aucun message, pas même dans les copies de secours (les autres restent).
  const profileCopy = nodePath.join(ASIDE, 'profile-2026-10-01T10-00-00-000Z.json')
  store.disk[profileCopy] = '{"name":"Lé'
  await store.clearConversationHistory()
  assert.deepEqual(Object.keys(asideCopies(store.disk)), ['profile-2026-10-01T10-00-00-000Z.json'])
})

test('fil ou index verrouillés (antivirus) : jamais pris pour vides, rien n’est réécrit', async () => {
  const faults = { busy: new Set() }
  const store = setup({ faults })
  await store.appendConversationEntry(entry('premier', 'ok', '2026-09-10T08:00:00.000Z'))
  const { activeId } = await store.listConversations()
  const file = nodePath.join(CONVERSATIONS, `${activeId}.json`)
  const before = { ...store.disk }

  faults.busy.add(file)
  await assert.rejects(store.appendConversationEntry(entry('deuxième', 'ok', '2026-09-10T08:01:00.000Z')), /EBUSY/)
  faults.busy.delete(file)
  faults.busy.add(INDEX)
  await assert.rejects(store.listConversations(), /EBUSY/)
  assert.deepEqual(store.disk, before, 'un fichier momentanément illisible a été touché')

  faults.busy.clear()
  assert.equal((await store.getConversationHistory()).map((e) => e.transcript).join(' | '), ['premier'].join(' | '))
})

test('coupure pendant une écriture : l’ancien fichier reste intact, et le temporaire abandonné n’est jamais lu', async () => {
  const faults = {}
  const store = setup({ faults })
  await store.appendConversationEntry(entry('premier', 'ok', '2026-09-10T08:00:00.000Z'))
  const { activeId } = await store.listConversations()
  const file = nodePath.join(CONVERSATIONS, `${activeId}.json`)
  const before = store.disk[file]

  faults.cutWrite = true
  await assert.rejects(store.appendConversationEntry(entry('deuxième', 'ok', '2026-09-10T08:01:00.000Z')), /EIO/)
  faults.cutWrite = false
  assert.equal(store.disk[file], before, 'la coupure a tronqué le vrai fichier')
  assert.ok(`${file}.tmp` in store.disk, 'la coupure a laissé un temporaire à moitié écrit')

  // Le temporaire abandonné ne remplace jamais le vrai, ni à la lecture, ni quand l'index doit être reconstruit.
  assert.equal((await store.getConversationHistory()).map((e) => e.transcript).join(' | '), ['premier'].join(' | '))
  store.disk[`${INDEX}.tmp`] = JSON.stringify({
    activeId: 'fantome',
    conversations: [{ id: 'fantome', title: 'fantôme', createdAt: 'x', updatedAt: 'z', messageCount: 1 }]
  })
  delete store.disk[INDEX]
  const { conversations } = await store.listConversations()
  assert.equal(conversations.map((c) => c.title).join(' | '), ['premier'].join(' | '))

  // L'écriture suivante passe, et le temporaire disparaît avec elle.
  await store.appendConversationEntry(entry('deuxième', 'ok', '2026-09-10T08:02:00.000Z'))
  assert.equal((await store.getConversationHistory()).map((e) => e.transcript).join(' | '), ['premier', 'deuxième'].join(' | '))
  assert.ok(!(`${file}.tmp` in store.disk))
})
