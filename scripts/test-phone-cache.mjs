import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Constat du cache de Mobile connecté (étape 21ter, electron/services/phoneLinkCache.ts).
 *
 * Contrairement à tout ce qui touche à Windows dans ce dépôt, une grande partie est vérifiable ICI pour de
 * vrai : le parcours de dossiers tourne sur un VRAI faux disque (dossier temporaire), et la lecture SQLite
 * sur une VRAIE base créée par le test avec `node:sqlite` — le même module que celui utilisé en production.
 * Ce qui reste invérifiable est uniquement ce qui dépend de la machine de Léo : le chemin réel du cache et
 * le contenu qu'y met Mobile connecté.
 */
const nodeRequire = createRequire(import.meta.url)
const projectRoot = new URL('..', import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('electron/services/phoneLinkCache.ts', projectRoot), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Realm courant : ce fichier compare des tableaux avec deepEqual (piège des prototypes séparés, documenté).
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, nodeRequire)
const { isPhonePackage, isDatabaseFile, collectDatabaseFiles, describeDatabase, summarize } = exports

const { DatabaseSync } = nodeRequire('node:sqlite')
// `readOnly` (O majuscule) : le nom exact attendu par node:sqlite. `readonly` en minuscules est accepté sans
// broncher ET IGNORÉ — la base s'ouvre alors en écriture. C'est ce que la production faisait avant que le
// test ci-dessous ne tente une vraie écriture.
const openDatabase = (file) => new DatabaseSync(file, { readOnly: true })

let workDir = null
function scratch() {
  if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'jaris-phone-cache-'))
  return workDir
}

test('les dossiers de Mobile connecté sont reconnus, ses voisins ignorés', () => {
  // Le paquet a déjà été renommé une fois (Your Phone -> Cross Device) : le motif couvre les deux, et un
  // futur renommage du même genre ne cassera pas tout.
  assert.equal(isPhonePackage('Microsoft.YourPhone_8wekyb3d8bbwe'), true)
  assert.equal(isPhonePackage('MicrosoftWindows.CrossDevice_cw5n1h2txyewy'), true)
  assert.equal(isPhonePackage('Microsoft.WindowsCalculator_8wekyb3d8bbwe'), false)
  assert.equal(isPhonePackage('Microsoft.Windows.Photos_8wekyb3d8bbwe'), false)
})

test('seuls les vrais fichiers de base sont retenus', () => {
  assert.equal(isDatabaseFile('phone.db'), true)
  assert.equal(isDatabaseFile('Messages.SQLite'), true)
  // -wal et -shm sont des fichiers de travail de SQLite : les ouvrir n'a aucun sens et peut gêner
  // l'application qui tourne.
  assert.equal(isDatabaseFile('phone.db-wal'), false)
  assert.equal(isDatabaseFile('phone.db-shm'), false)
  assert.equal(isDatabaseFile('thumbnail.jpg'), false)
})

test('le parcours descend dans les sous-dossiers et trouve les bases', () => {
  const root = join(scratch(), 'cache')
  mkdirSync(join(root, 'Indexed', 'GUID', 'System', 'Database'), { recursive: true })
  writeFileSync(join(root, 'Indexed', 'GUID', 'System', 'Database', 'phone.db'), '')
  writeFileSync(join(root, 'Indexed', 'GUID', 'photo.jpg'), '')
  const trouvees = collectDatabaseFiles(root)
  assert.equal(trouvees.length, 1)
  assert.match(trouvees[0], /phone\.db$/)
})

test('un dossier illisible n’interrompt pas tout le parcours', () => {
  // Un cache d'application contient des dossiers verrouillés : abandonner au premier refus reviendrait à ne
  // rien trouver du tout chez Léo.
  const root = join(scratch(), 'partiel')
  mkdirSync(join(root, 'ok'), { recursive: true })
  writeFileSync(join(root, 'ok', 'trouve.db'), '')
  const fs = {
    readdirSync: (dir) => {
      if (String(dir).endsWith('interdit')) throw new Error('EACCES')
      return nodeRequire('fs').readdirSync(dir)
    },
    statSync: nodeRequire('fs').statSync
  }
  mkdirSync(join(root, 'interdit'), { recursive: true })
  const trouvees = collectDatabaseFiles(root, fs)
  assert.equal(trouvees.length, 1)
})

test('une VRAIE base SQLite est décrite table par table, sans être modifiée', () => {
  const file = join(scratch(), 'vraie.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE message (id INTEGER PRIMARY KEY, body TEXT)')
  db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY)')
  db.exec("INSERT INTO message (body) VALUES ('coucou'), ('deuxieme')")
  db.close()

  const description = describeDatabase(file, openDatabase, 1234)
  assert.equal(description.error, undefined)
  assert.equal(description.sizeBytes, 1234)
  assert.deepEqual(
    description.tables.map((table) => [table.name, table.rows]),
    [['contact', 0], ['message', 2]]
  )
  // Aucun contenu de message ne doit sortir d'ici : Léo doit pouvoir envoyer ce rapport sans exposer ses
  // conversations. C'est la raison d'être de cette étape, pas un détail de présentation.
  assert.doesNotMatch(JSON.stringify(description), /coucou|deuxieme/)
})

test('la base est ouverte en LECTURE SEULE', () => {
  // Ces bases appartiennent à une autre application, en cours d'exécution : une écriture accidentelle de
  // Jaris pourrait corrompre les messages de Léo. On vérifie que l'ouverture utilisée refuse d'écrire.
  const file = join(scratch(), 'lecture-seule.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE t (id INTEGER)')
  db.close()

  const readOnly = openDatabase(file)
  assert.throws(() => readOnly.exec('INSERT INTO t (id) VALUES (1)'))
  readOnly.close()
})

test("un fichier qui n'est pas une base ne fait pas tout échouer", () => {
  const file = join(scratch(), 'faux.db')
  writeFileSync(file, 'ceci n est pas du SQLite')
  const description = describeDatabase(file, openDatabase, 12)
  assert.ok(description.error, 'aucune erreur rapportée pour un fichier illisible')
  assert.deepEqual(description.tables, [])
})

test('le résumé distingue les trois situations, sans les confondre', () => {
  // Même règle que pour les notifications : "rien trouvé" et "trouvé mais vide" ne doivent pas se lire
  // pareil, sinon Léo ne sait pas s'il doit installer quelque chose ou si c'est Jaris qui cherche mal.
  const rien = summarize({ packages: [], databases: [] })
  const vide = summarize({ packages: ['C:/cache'], databases: [] })
  const plein = summarize({ packages: ['C:/cache'], databases: [{ path: 'a.db', sizeBytes: 1, tables: [{ name: 'message', rows: 12 }] }] })
  assert.match(rien, /Aucun dossier/)
  assert.match(vide, /aucune base de données/)
  assert.match(plein, /1 base\(s\)/)
  assert.match(plein, /dont 1 avec des données/)
  assert.match(plein, /Je n'ai lu aucun message/)
})

test.after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})
