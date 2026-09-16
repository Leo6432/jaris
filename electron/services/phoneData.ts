import { readdirSync } from 'fs'
import { join } from 'path'
import type { PhoneCall, PhoneContact } from '../../shared/ipc'
import { collectDatabaseFiles, isPhonePackage } from './phoneLinkCache'

/**
 * Lecture des appels et des contacts rangés par « Mobile connecté » (étape 21quater).
 *
 * CE FICHIER EST ÉCRIT SUR DES FAITS, PAS SUR UNE HYPOTHÈSE. Le constat livré à l'étape 21ter a tourné sur
 * la machine de Léo et a renvoyé exactement ceci : `calling.db` avec une table `call_history` (100 lignes),
 * `contacts.db` avec `contact` (24) et `phonenumber` (29) — et AUCUNE table de messages. D'où le périmètre :
 * ce module lit les appels et contacts du cache ; phoneLink.ts pilote la fenêtre pour les autres actions.
 * Pour un iPhone, Mobile connecté affiche les messages dans sa fenêtre sans les garder sur le disque.
 *
 * CE QUI RESTE INCONNU, ET COMMENT C'EST TRAITÉ. Le constat donne les noms des TABLES, pas ceux des
 * COLONNES, et ce schéma n'est documenté nulle part. Plutôt que de deviner `date`/`number`/`name` et de
 * livrer quelque chose qui ne marcherait que par chance, les colonnes sont RECONNUES à l'exécution
 * (`PRAGMA table_info`) par ce qu'elles contiennent : une colonne de numéro, une de nom, une de date. Un
 * schéma légèrement différent (autre version de l'application, Windows en anglais) continue donc de
 * fonctionner, et si vraiment rien ne correspond, Jaris le DIT au lieu de rendre une liste vide.
 */

/** Ouvre une base en lecture seule. `readOnly` avec un O MAJUSCULE : `readonly` est ignoré EN SILENCE par
 *  node:sqlite et ouvre la base en écriture (mesuré, et attrapé par un test à l'étape 21ter). Ces bases
 *  appartiennent à une autre application en cours d'exécution : Jaris ne doit jamais pouvoir les modifier. */
export type OpenDatabase = (file: string) => {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] }
  close: () => void
}

async function defaultOpenDatabase(): Promise<OpenDatabase> {
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => ReturnType<OpenDatabase>
  }
  return (file) => new DatabaseSync(file, { readOnly: true })
}

/** Toutes les bases du cache de Mobile connecté présentes sur cette machine. */
export function findPhoneDatabases(): string[] {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []
  const packagesDir = join(localAppData, 'Packages')
  let packages: string[] = []
  try {
    packages = readdirSync(packagesDir).filter(isPhonePackage)
  } catch {
    return []
  }
  return packages.flatMap((name) => collectDatabaseFiles(join(packagesDir, name, 'LocalCache')))
}

/**
 * Choisit, parmi les colonnes réellement présentes, celle qui porte l'information cherchée.
 * Pur et exporté : c'est le cœur de la tolérance au schéma, donc ce qui mérite le plus d'être testé.
 */
export function pickColumn(columns: string[], patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = columns.find((column) => pattern.test(column))
    if (found) return found
  }
  return null
}

/**
 * Ramène un horodatage de base de données à une vraie date.
 *
 * Trois formats possibles selon ce qu'écrit l'application, et rien ne dit lequel : secondes Unix,
 * millisecondes Unix, ou "ticks" .NET (100 ns depuis l'an 1). On ne devine pas — on convertit puis on VÉRIFIE
 * que la date obtenue est plausible (entre 2000 et 2100). Sans ce contrôle, un mauvais format donnerait
 * "17 janvier 1970" ou "an 4521" sans que rien ne signale l'erreur.
 */
export function toDate(value: unknown): Date | null {
  const raw = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  const candidates = [
    raw, // millisecondes Unix
    raw * 1000, // secondes Unix
    (raw - 621_355_968_000_000_000) / 10_000 // ticks .NET -> millisecondes Unix
  ]
  for (const candidate of candidates) {
    const date = new Date(candidate)
    const year = date.getFullYear()
    if (!Number.isNaN(year) && year >= 2000 && year <= 2100) return date
  }
  return null
}

function readTable(
  open: OpenDatabase,
  file: string,
  tablePattern: RegExp
): { rows: Record<string, unknown>[]; columns: string[] } | null {
  const database = open(file)
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const table = tables.find((name) => tablePattern.test(name))
    if (!table) return null
    const quoted = `"${table.replace(/"/g, '""')}"`
    const columns = database
      .prepare(`PRAGMA table_info(${quoted})`)
      .all()
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    // Plafond dur : ces tables peuvent être longues, et rien ici n'a besoin de tout charger.
    const rows = database.prepare(`SELECT * FROM ${quoted} LIMIT 2000`).all() as Record<string, unknown>[]
    return { rows, columns }
  } finally {
    database.close()
  }
}

/**
 * Les derniers appels, du plus récent au plus ancien. Ne lève jamais : un échec devient une liste vide.
 *
 * `deps` existe pour les tests : l'ouverture des bases ET la liste des fichiers sont injectables. Première
 * version de ce fichier : seule l'ouverture l'était, et le test remplaçait `findPhoneDatabases` sur les
 * exports du module — sans le moindre effet, puisqu'un appel INTERNE ne passe jamais par les exports. Le
 * test lisait donc la vraie machine (aucune, ici) et ne vérifiait rien. Piège de la même famille que le
 * `grep -c` qui comptait juste sans rien prouver (étape 97).
 */
export async function readRecentCalls(
  limit = 10,
  deps: { open?: OpenDatabase; files?: string[] } = {}
): Promise<PhoneCall[]> {
  const openDatabase = deps.open ?? (await defaultOpenDatabase())
  for (const file of deps.files ?? findPhoneDatabases()) {
    let table: ReturnType<typeof readTable> = null
    try {
      table = readTable(openDatabase, file, /call/i)
    } catch {
      continue
    }
    if (!table) continue

    const numberColumn = pickColumn(table.columns, [/phone.*number/i, /number/i, /address/i])
    const nameColumn = pickColumn(table.columns, [/display.*name/i, /name/i, /caller/i])
    const dateColumn = pickColumn(table.columns, [/start.*time/i, /date/i, /time/i, /timestamp/i])
    const durationColumn = pickColumn(table.columns, [/duration/i])

    const calls = table.rows
      .map((row) => ({
        name: nameColumn ? String(row[nameColumn] ?? '') : '',
        number: numberColumn ? String(row[numberColumn] ?? '') : '',
        date: dateColumn ? toDate(row[dateColumn]) : null,
        durationSeconds: durationColumn ? Number(row[durationColumn] ?? 0) || 0 : 0
      }))
      .filter((call) => call.name || call.number)
      .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
      .slice(0, limit)
      .map((call) => ({ ...call, date: call.date ? call.date.toISOString() : '' }))
    if (calls.length > 0) return calls
  }
  return []
}

/** Cherche un contact par son nom (ou une partie). Recherche locale, insensible à la casse et aux accents. */
export async function searchContacts(
  query: string,
  deps: { open?: OpenDatabase; files?: string[] } = {}
): Promise<PhoneContact[]> {
  const needle = normalize(query)
  if (!needle) return []
  const openDatabase = deps.open ?? (await defaultOpenDatabase())

  for (const file of deps.files ?? findPhoneDatabases()) {
    let contactTable: ReturnType<typeof readTable> = null
    let numberTable: ReturnType<typeof readTable> = null
    try {
      // `^contact` : la base contient aussi contact_index et fts_contact* (index de recherche interne de
      // SQLite), qui ne portent pas les vraies valeurs — vu tel quel dans le constat de la machine de Léo.
      contactTable = readTable(openDatabase, file, /^contact$/i)
      numberTable = readTable(openDatabase, file, /^phonenumber$/i)
    } catch {
      continue
    }
    if (!contactTable) continue

    const nameColumn = pickColumn(contactTable.columns, [/display.*name/i, /full.*name/i, /name/i])
    if (!nameColumn) continue
    const idColumn = pickColumn(contactTable.columns, [/^id$/i, /contact.*id/i, /rowid/i])

    const numbersByContact = new Map<string, string[]>()
    if (numberTable) {
      const numberColumn = pickColumn(numberTable.columns.filter(column => !/(?:^id$|_id$|Id$)/i.test(column)), [/^phone_number$/i, /^display_phone_number$/i, /number/i, /value/i])
      const linkColumn = pickColumn(numberTable.columns, [/contact.*id/i, /^id$/i])
      if (numberColumn && linkColumn) {
        for (const row of numberTable.rows) {
          const key = String(row[linkColumn] ?? '')
          const value = String(row[numberColumn] ?? '').trim()
          if (!key || !value) continue
          numbersByContact.set(key, [...(numbersByContact.get(key) ?? []), value])
        }
      }
    }

    const found = contactTable.rows
      .map((row) => ({
        name: String(row[nameColumn] ?? '').trim(),
        numbers: idColumn ? (numbersByContact.get(String(row[idColumn] ?? '')) ?? []) : []
      }))
      .filter((contact) => contact.name && normalize(contact.name).includes(needle))
    if (found.length > 0) return found
  }
  return []
}

/** Minuscules sans accents : "Léo" doit se retrouver en tapant "leo" (même normalisation que appLauncher). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/** Mise en phrase lisible à voix haute : jamais une liste vide silencieuse, toujours une raison. */
export function formatCalls(calls: PhoneCall[]): string {
  if (calls.length === 0) {
    return (
      "Je ne trouve aucun appel sur cet ordinateur. Vérifie que Mobile connecté est bien relié à ton " +
      'téléphone — c\'est lui qui garde cet historique, Jaris ne fait que le lire.'
    )
  }
  return calls
    .map((call) => {
      const qui = call.name || call.number || 'Numéro inconnu'
      const quand = call.date ? new Date(call.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'date inconnue'
      const duree = call.durationSeconds > 0 ? `, ${Math.round(call.durationSeconds / 60)} min` : ''
      return `${qui} — ${quand}${duree}`
    })
    .join('\n')
}

export function formatContacts(contacts: PhoneContact[], query: string): string {
  if (contacts.length === 0) {
    return `Aucun contact ne correspond à « ${query} » dans ceux que Mobile connecté a recopiés sur cet ordinateur.`
  }
  return contacts
    .map((contact) => (contact.numbers.length > 0 ? `${contact.name} : ${contact.numbers.join(', ')}` : contact.name))
    .join('\n')
}
