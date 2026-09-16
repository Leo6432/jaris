import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Lecture des appels et des contacts du téléphone (étape 21quater, electron/services/phoneData.ts).
 *
 * Ces tests tournent sur de VRAIES bases SQLite créées ici, façonnées d'après le constat réel de la machine
 * de Léo (`calling.db` avec `call_history`, `contacts.db` avec `contact` et `phonenumber`, plus les tables
 * d'index `fts_*`/`contact_index` qui l'accompagnent). Ce qui reste inconnu, ce sont les NOMS DE COLONNES :
 * le constat donne les tables, pas les colonnes. D'où le parti pris testé ici — les colonnes sont reconnues
 * à l'exécution — et deux schémas différents sont donc exercés exprès.
 */
const nodeRequire = createRequire(import.meta.url)
const projectRoot = new URL('..', import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('electron/services/phoneData.ts', projectRoot), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) =>
  name === './phoneLinkCache' ? { collectDatabaseFiles: () => [], isPhonePackage: () => true } : nodeRequire(name)
)
const { pickColumn, toDate, readRecentCalls, searchContacts, formatCalls, formatContacts } = exports

const { DatabaseSync } = nodeRequire('node:sqlite')
let workDir = null
const scratch = () => (workDir ??= mkdtempSync(join(tmpdir(), 'jaris-phone-data-')))

/** Construit une base d'appels avec les noms de colonnes demandés, pour exercer la tolérance au schéma. */
function makeCallsDatabase(fileName, { numberColumn, nameColumn, dateColumn, durationColumn }, rows) {
  const file = join(scratch(), fileName)
  const db = new DatabaseSync(file)
  db.exec(
    `CREATE TABLE call_history (id INTEGER PRIMARY KEY, ${numberColumn} TEXT, ${nameColumn} TEXT, ${dateColumn} INTEGER, ${durationColumn} INTEGER)`
  )
  // sqlite_sequence existe vraiment dans la base de Léo : elle ne doit jamais être prise pour la table des appels.
  // `sqlite_` est un préfixe réservé par SQLite : on imite cette table voisine sous un autre nom.
  db.exec('CREATE TABLE journal_interne (name TEXT, seq INTEGER)')
  for (const row of rows) {
    db.prepare(
      `INSERT INTO call_history (${numberColumn}, ${nameColumn}, ${dateColumn}, ${durationColumn}) VALUES (?, ?, ?, ?)`
    ).run(row.number, row.name, row.date, row.duration)
  }
  db.close()
  return file
}

const openReadOnly = (file) => new DatabaseSync(file, { readOnly: true })

test('les colonnes sont reconnues par ce qu’elles contiennent, pas par un nom deviné', () => {
  assert.equal(pickColumn(['Id', 'PhoneNumber', 'DisplayName'], [/phone.*number/i, /number/i]), 'PhoneNumber')
  assert.equal(pickColumn(['id', 'address', 'caller_name'], [/phone.*number/i, /number/i, /address/i]), 'address')
  assert.equal(pickColumn(['id', 'truc'], [/number/i]), null)
})

test('un horodatage est converti quel que soit son format, ou refusé', () => {
  // Trois formats possibles et rien ne dit lequel : secondes, millisecondes, ou ticks .NET. On convertit
  // puis on vérifie que la date est plausible — sinon "17 janvier 1970" passerait pour une vraie date.
  const attendu = Date.UTC(2026, 8, 15, 12, 0, 0)
  assert.equal(toDate(attendu).getTime(), attendu)
  assert.equal(toDate(Math.floor(attendu / 1000)).getTime(), attendu)
  assert.equal(toDate(attendu * 10_000 + 621_355_968_000_000_000).getTime(), attendu)
  assert.equal(toDate(0), null)
  assert.equal(toDate('pas une date'), null)
  assert.equal(toDate(42), null, 'une valeur absurde ne doit pas devenir une date de 1970')
})

test('les appels sont lus, triés du plus récent au plus ancien', async () => {
  const maintenant = Date.now()
  const file = makeCallsDatabase(
    'calling.db',
    { numberColumn: 'PhoneNumber', nameColumn: 'DisplayName', dateColumn: 'StartTime', durationColumn: 'DurationSeconds' },
    [
      { number: '+33600000001', name: 'Maman', date: maintenant - 3_600_000, duration: 120 },
      { number: '+33600000002', name: 'Docteur', date: maintenant, duration: 0 }
    ]
  )
  const appels = await readRecentCalls(10, { open: openReadOnly, files: [file] })
  assert.equal(appels.length, 2)
  assert.equal(appels[0].name, 'Docteur', 'le plus récent doit venir en premier')
  assert.equal(appels[1].number, '+33600000001')
  assert.equal(appels[1].durationSeconds, 120)
})

test('un AUTRE schéma de colonnes fonctionne aussi', async () => {
  // Le vrai intérêt du choix fait ici : une autre version de Mobile connecté (ou un Windows en anglais) peut
  // nommer ses colonnes autrement. Deviner "date"/"number" aurait marché par chance une fois, puis cassé.
  const file = makeCallsDatabase(
    'autre.db',
    { numberColumn: 'address', nameColumn: 'caller_name', dateColumn: 'call_date', durationColumn: 'duration' },
    [{ number: '0102030405', name: 'Pizzeria', date: Math.floor(Date.now() / 1000), duration: 60 }]
  )
  const appels = await readRecentCalls(10, { open: openReadOnly, files: [file] })
  assert.equal(appels.length, 1)
  assert.equal(appels[0].name, 'Pizzeria')
  assert.ok(appels[0].date, "la date doit être interprétée même en secondes Unix")
})

test('les contacts sont retrouvés avec leurs numéros, sans confondre avec les tables d’index', async () => {
  const file = join(scratch(), 'contacts.db')
  const db = new DatabaseSync(file)
  // Les tables d'index sont créées AVANT la vraie table, exprès : sqlite_master les rend dans l'ordre de
  // création, donc une recherche naïve sur /contact/ tomberait sur `contact_index` (qui ne contient aucun
  // nom) et ne trouverait plus rien. Première version de ce test : la vraie table était créée en premier,
  // et le test passait donc même en retirant l'ancrage — il ne prouvait rien. L'ordre réel chez Léo est
  // inconnu : le code ne doit pas en dépendre.
  db.exec('CREATE TABLE contact_index (id INTEGER, token TEXT)')
  db.exec('CREATE TABLE fts_contact (nom TEXT)')
  db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, DisplayName TEXT)')
  db.exec('CREATE TABLE phonenumber (id INTEGER PRIMARY KEY, contact_id INTEGER, Number TEXT)')
  db.prepare('INSERT INTO contact (id, DisplayName) VALUES (?, ?)').run(1, 'Maman')
  db.prepare('INSERT INTO contact (id, DisplayName) VALUES (?, ?)').run(2, 'Léo Bureau')
  db.prepare('INSERT INTO phonenumber (contact_id, Number) VALUES (?, ?)').run(1, '+33600000001')
  db.prepare('INSERT INTO phonenumber (contact_id, Number) VALUES (?, ?)').run(1, '0155667788')
  db.prepare('INSERT INTO contact_index (id, token) VALUES (?, ?)').run(1, 'maman')
  db.close()

  const trouves = await searchContacts('maman', { open: openReadOnly, files: [file] })
  assert.equal(trouves.length, 1)
  assert.equal(trouves[0].name, 'Maman')
  assert.deepEqual(trouves[0].numbers, ['+33600000001', '0155667788'])

  // Accents et casse : "Léo" doit se retrouver en tapant "leo", comme pour les noms d'applications.
  const accents = await searchContacts('LEO', { open: openReadOnly, files: [file] })
  assert.equal(accents.length, 1)
  assert.equal(accents[0].name, 'Léo Bureau')

  assert.deepEqual(await searchContacts('inexistant', { open: openReadOnly, files: [file] }), [])
  assert.deepEqual(await searchContacts('   ', { open: openReadOnly, files: [file] }), [], 'une recherche vide ne doit rien remonter')
})

test('sans base lisible, on explique au lieu de rendre une liste vide', async () => {
  assert.deepEqual(await readRecentCalls(10, { open: openReadOnly, files: [] }), [])
  assert.match(formatCalls([]), /Mobile connecté est bien relié/)
  assert.match(formatContacts([], 'maman'), /Aucun contact/)
  assert.match(formatContacts([], 'maman'), /maman/)
})

test('la mise en phrase des appels est lisible à voix haute', () => {
  const phrase = formatCalls([{ name: 'Maman', number: '+33600000001', date: new Date(Date.UTC(2026, 8, 15, 10, 30)).toISOString(), durationSeconds: 120 }])
  assert.match(phrase, /Maman/)
  assert.match(phrase, /2 min/)
  assert.doesNotMatch(phrase, /ISO|T10:30/, 'une date brute ne doit jamais être lue à voix haute')
})

test.after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

// Schéma relevé sur le PC : phone_number_id précède le vrai phone_number.
test('le numéro interne phone_number_id ne remplace jamais le téléphone du contact', async () => {
  const file=join(scratch(),'real-schema.db')
  const db=new DatabaseSync(file)
  db.exec('CREATE TABLE contact (contact_id INTEGER, display_name TEXT); CREATE TABLE phonenumber (phone_number_id INTEGER, contact_id INTEGER, phone_number TEXT, display_phone_number TEXT)')
  db.prepare('INSERT INTO contact VALUES (?,?)').run(7,'Test')
  db.prepare('INSERT INTO phonenumber VALUES (?,?,?,?)').run(99999999,7,'+33600000001','06 00 00 00 01')
  db.close()
  assert.deepEqual((await searchContacts('Test',{open:openReadOnly,files:[file]}))[0].numbers,['+33600000001'])
})
