import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { PhoneCacheDatabase, PhoneCacheReport } from '../../shared/ipc'

/**
 * Trouve ce que « Mobile connecté » range sur le disque (étape 21ter).
 *
 * POURQUOI CE FICHIER EXISTE. Léo : « mais tu peux pas te connecter à mobile connecté, il n'y a pas un outil
 * pour ça ». Non, il n'y a pas d'API — mais la question utile n'est pas « cette application expose-t-elle une
 * API ? », c'est « où atterrit la donnée que je veux ? » (leçon déjà payée deux fois sur ce sujet : d'abord
 * en croyant qu'il faudrait cliquer dans sa fenêtre, puis en trouvant que Windows publie les notifications
 * dans son propre centre). Mobile connecté garde ses données dans un cache local, en bases SQLite — ce sont
 * des travaux publiés d'informatique légale sur l'application « Your Phone »/Phone Link qui le documentent
 * (dossier `%LOCALAPPDATA%\\Packages\\Microsoft.YourPhone_8wekyb3d8bbwe\\LocalCache`, bases SQLite), pas la
 * documentation Microsoft : à traiter comme une piste sérieuse, jamais comme un contrat stable.
 *
 * CE QUE CE MODULE FAIT, ET SURTOUT CE QU'IL NE FAIT PAS. Il REGARDE : quels dossiers de cache existent,
 * quelles bases s'y trouvent, quelles tables elles contiennent et combien de lignes. Il ne lit AUCUN contenu
 * de message et n'écrit RIEN. C'est un constat, pas une fonctionnalité : le schéma de ces bases n'est
 * documenté nulle part et change avec les versions de l'application, donc écrire tout de suite un lecteur de
 * messages reviendrait à deviner. Le rapport sert à décider la suite avec des faits venus de la machine de
 * Léo — exactement ce que ce projet a appris à faire après les quatre hypothèses successives de la saga
 * SearXNG.
 *
 * VIE PRIVÉE : le rapport ne contient que des noms de tables et des nombres, jamais le texte d'un message —
 * Léo peut me l'envoyer sans exposer ses conversations.
 */

/** Noms de paquets connus pour ce composant : « Your Phone » à l'origine, « Cross Device » sur Windows 11
 *  récent. Motif plutôt qu'une liste figée : un renommage de plus ne doit pas tout casser. */
export const PHONE_PACKAGE_PATTERN = /yourphone|crossdevice|phonelink/i

/** Extensions de bases SQLite rencontrées dans ces caches. `-wal`/`-shm` sont des fichiers de travail, jamais ouverts. */
const DATABASE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3']

/** Bornes de parcours : un cache peut contenir des milliers de miniatures. Sans limite, "regarder ce qu'il y
 *  a" bloquerait l'interface plusieurs secondes — même discipline que les attentes bornées de computerUse. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 20_000
const MAX_TABLES_PER_DATABASE = 40

/** true si ce dossier de `Packages` appartient à Mobile connecté. Pur, donc testable sans Windows. */
export function isPhonePackage(name: string): boolean {
  return PHONE_PACKAGE_PATTERN.test(name)
}

export function isDatabaseFile(name: string): boolean {
  const lower = name.toLowerCase()
  return DATABASE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * Parcourt un dossier et renvoie les bases trouvées. `fs` est injecté pour être testable sur un faux disque
 * (aucun Windows ici) — même approche que conversationStore, testé sur un faux disque lui aussi.
 */
export function collectDatabaseFiles(
  root: string,
  fs: { readdirSync: typeof readdirSync; statSync: typeof statSync } = { readdirSync, statSync }
): string[] {
  const found: string[] = []
  let visited = 0
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return
    let entries: string[]
    try {
      entries = fs.readdirSync(directory)
    } catch {
      // Dossier illisible (droits, verrou) : on continue ailleurs plutôt que d'abandonner tout le parcours.
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) return
      visited += 1
      const full = join(directory, entry)
      let isDirectory = false
      try {
        isDirectory = fs.statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) walk(full, depth + 1)
      else if (isDatabaseFile(entry)) found.push(full)
    }
  }
  walk(root, 0)
  return found
}

/**
 * Ouvre une base en LECTURE SEULE et décrit sa structure. `node:sqlite` est intégré à Node 22 (donc à
 * Electron 43) : aucune dépendance native à compiler, rien de plus à installer.
 *
 * `readOnly` n'est pas une précaution de style : ces bases appartiennent à une autre application, en cours
 * d'exécution. Jaris ne doit jamais pouvoir les modifier, même par accident.
 */
export function describeDatabase(
  path: string,
  openDatabase: (file: string) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void },
  sizeBytes: number
): PhoneCacheDatabase {
  try {
    const database = openDatabase(path)
    try {
      const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      const names = rows
        .map((row) => (row as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')
        .slice(0, MAX_TABLES_PER_DATABASE)
      const tables = names.map((name) => {
        try {
          // Le nom de table vient de la base elle-même (sqlite_master), jamais d'une saisie : il est quand
          // même entouré de guillemets doubles, la forme d'échappement d'un identifiant en SQL.
          const count = database.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).all()
          const n = (count[0] as { n?: unknown } | undefined)?.n
          return { name, rows: typeof n === 'number' ? n : Number(n ?? 0) }
        } catch {
          return { name, rows: -1 }
        }
      })
      return { path, sizeBytes, tables }
    } finally {
      database.close()
    }
  } catch (error) {
    return { path, sizeBytes, tables: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Résumé en français, lisible tel quel : il est affiché sans reformulation, comme tous les messages de Jaris. */
export function summarize(report: Omit<PhoneCacheReport, 'message'>): string {
  if (report.packages.length === 0) {
    return "Aucun dossier de Mobile connecté trouvé sur cet ordinateur. Soit il n'est pas installé, soit il range ses données ailleurs que là où je regarde."
  }
  if (report.databases.length === 0) {
    return `Dossier de Mobile connecté trouvé, mais aucune base de données dedans (${report.packages.length} dossier(s) examiné(s)).`
  }
  const withRows = report.databases.filter((database) => database.tables.some((table) => table.rows > 0))
  return (
    `${report.databases.length} base(s) de données trouvée(s) pour Mobile connecté, dont ${withRows.length} avec des données. ` +
    "Je n'ai lu aucun message : seulement les noms des tables et le nombre de lignes."
  )
}

/**
 * Le constat complet, sur la vraie machine. Ne lève jamais : un échec devient un rapport lisible.
 *
 * `node:sqlite` est chargé à la demande plutôt qu'en tête de fichier : il est marqué expérimental par Node
 * et affiche un avertissement au chargement — inutile de le payer au démarrage de Jaris alors que ce
 * constat ne sert qu'au clic d'un bouton. Et s'il venait à manquer dans une future version d'Electron, seul
 * ce bouton le dirait, sans empêcher le reste de démarrer.
 */
export async function inspectPhoneLinkCache(): Promise<PhoneCacheReport> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    return { packages: [], databases: [], message: "Impossible de trouver le dossier des applications Windows sur cette machine." }
  }

  const packagesDir = join(localAppData, 'Packages')
  let packages: string[] = []
  try {
    packages = readdirSync(packagesDir)
      .filter(isPhonePackage)
      .map((name) => join(packagesDir, name, 'LocalCache'))
  } catch (error) {
    return {
      packages: [],
      databases: [],
      message: `Le dossier des applications Windows n'a pas pu être lu : ${error instanceof Error ? error.message : String(error)}`
    }
  }

  let openDatabase: ((file: string) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void }) | null = null
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
        prepare: (sql: string) => { all: () => unknown[] }
        close: () => void
      }
    }
    // `readOnly`, avec un O MAJUSCULE : c'est le nom exact attendu par node:sqlite. Écrit `readonly`, Node
    // l'ignore EN SILENCE et ouvre la base en écriture — mesuré, pas supposé, et attrapé par le test qui
    // tente vraiment une écriture. Ces bases appartiennent à une autre application, en cours d'exécution :
    // Jaris ne doit jamais pouvoir les modifier, même par accident.
    openDatabase = (file) => new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    return {
      packages,
      databases: [],
      message: `Les bases de Mobile connecté n'ont pas pu être ouvertes sur cette version de Jaris : ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const databases: PhoneCacheDatabase[] = []
  for (const cacheDir of packages) {
    for (const file of collectDatabaseFiles(cacheDir)) {
      let sizeBytes = 0
      try {
        sizeBytes = statSync(file).size
      } catch {
        sizeBytes = 0
      }
      databases.push(describeDatabase(file, openDatabase, sizeBytes))
    }
  }

  return { packages, databases, message: summarize({ packages, databases }) }
}
