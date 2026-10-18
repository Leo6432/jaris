import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { mkdir, open, readFile, rename, rm, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { t } from '../../shared/i18n'

/**
 * Écriture et lecture sûres des fichiers de données de Jaris (étape 325). Aucune dépendance à Electron : la racine de
 * stockage (storageRoot.ts) s'en sert avant même que l'application soit prête.
 *
 * Écrire PAR-DESSUS un fichier (`writeFile(chemin, …)`) le vide d'abord : une coupure de courant, un plantage ou un
 * antivirus pendant l'écriture laisse un fichier tronqué — et un profil tronqué relançait l'écran de premier lancement,
 * dont le premier enregistrement écrasait le vrai. Ici, le contenu part dans un fichier temporaire voisin, forcé sur le
 * disque, puis REMPLACE l'ancien d'un seul geste (renommage dans le même dossier) : l'ancien fichier reste intact
 * jusqu'au dernier instant, et le temporaire n'est jamais lu à la place du vrai.
 *
 * Même logique que les conversations du mode Code (codeConversationsStore.ts, étape 324), d'où elle est extraite.
 */

/**
 * Dossier des copies de secours d'un fichier de données abîmé (profil, conversations, rappels, langue) : jamais
 * remplacé en silence par un fichier neuf vide, il est d'abord rangé ici sous un nom daté. Suit « Déplacer »
 * (OWNED_ENTRIES, storageRoot.ts).
 */
export const UNREADABLE_DATA_DIR = 'fichiers-illisibles'

/** Suffixe du fichier temporaire d'une écriture en cours. */
export const TEMPORARY_SUFFIX = '.tmp'

/**
 * Délais entre deux essais quand Windows refuse un instant un renommage (antivirus ou indexeur qui ouvre le fichier
 * qu'on vient d'écrire) : au plus ~350 ms d'attente, et seulement quand ça échoue.
 */
export const RENAME_RETRY_DELAYS_MS = [50, 100, 200]
/** Lecture : un peu plus de patience (~1,5 s), parce qu'abandonner une lecture fait échouer l'action en cours. */
const READ_RETRY_DELAYS_MS = [50, 100, 200, 400, 800]

/** Les refus passagers de Windows (fichier tenu ouvert un instant par un autre programme). */
export const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export function isTransientFsError(err: unknown): boolean {
  return TRANSIENT_FS_CODES.has((err as NodeJS.ErrnoException | undefined)?.code ?? '')
}

/** Attente SYNCHRONE : courte, rare, et indispensable avant que l'application soit prête (pas de boucle d'évènements). */
export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `renameSync` réessayé sur un refus passager. Toute autre erreur, ou un refus qui dure, remonte telle quelle. */
export function renameWithRetriesSync(from: string, to: string, wait: (ms: number) => void = sleepSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      wait(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

export interface AtomicWriteSyncOptions {
  /** Remplacé par les tests, pour ne pas attendre pour de vrai. */
  sleep?: (ms: number) => void
  temporarySuffix?: string
  /** Renommage refusé pour de bon : efface le temporaire (sinon il est simplement réécrit à la prochaine écriture). */
  removeTemporaryOnFailure?: boolean
}

/**
 * Écrit `file` d'un seul tenant, de façon SYNCHRONE : temporaire voisin, forcé sur le disque (sinon, après une coupure,
 * le renommage peut être là sans le contenu), puis remplacement réessayé sur un refus passager de Windows.
 */
export function writeFileAtomicSync(file: string, content: string, options: AtomicWriteSyncOptions = {}): void {
  const { sleep: wait = sleepSync, temporarySuffix = TEMPORARY_SUFFIX, removeTemporaryOnFailure = false } = options
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}${temporarySuffix}`
  const fd = openSync(temporary, 'w')
  try {
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameWithRetriesSync(temporary, file, wait)
  } catch (err) {
    if (removeTemporaryOnFailure) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // réécrit à la prochaine écriture
      }
    }
    throw err
  }
}

/** Une écriture à la fois par fichier : deux écritures simultanées partageraient le même temporaire. */
const writeQueues = new Map<string, Promise<void>>()

async function writeNow(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}${TEMPORARY_SUFFIX}`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file)
      return
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        // `file` est intact (le remplacement n'a pas eu lieu) : le temporaire ne traîne pas à côté.
        await rm(temporary, { force: true }).catch(() => {})
        throw err
      }
      await sleep(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Écrit `file` d'un seul tenant (version asynchrone des magasins de données). Les écritures d'un même fichier passent
 * l'une après l'autre, dans l'ordre demandé : la dernière demandée est celle qui reste.
 */
export function writeFileAtomic(file: string, content: string): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => writeNow(file, content))
  writeQueues.set(file, next)
  const forget = (): void => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  }
  next.then(forget, forget)
  return next
}

/**
 * Le fichier existe mais n'a pas pu être LU (verrouillé par un antivirus…, même après plusieurs essais) : rien ne doit
 * l'écraser, et l'action en cours s'arrête là plutôt que de le prendre pour un fichier vide.
 */
export class DataFileUnreadableError extends Error {
  constructor(file: string, cause: unknown) {
    const detail = (cause as NodeJS.ErrnoException | undefined)?.code ?? String((cause as Error)?.message ?? cause)
    super(t('data.fileBusy', { file: basename(file), detail }))
    this.name = 'DataFileUnreadableError'
  }
}

/** Le contenu de `file`, `null` s'il n'existe pas. Un refus passager est réessayé ; s'il dure, DataFileUnreadableError. */
export async function readFileWithRetries(file: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (!isTransientFsError(err) || attempt >= READ_RETRY_DELAYS_MS.length) throw new DataFileUnreadableError(file, err)
      await sleep(READ_RETRY_DELAYS_MS[attempt])
    }
  }
}

/** Version SYNCHRONE (racine de stockage, avant que l'application soit prête). */
export function readFileWithRetriesSync(file: string, wait: (ms: number) => void = sleepSync): string | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return readFileSync(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (!isTransientFsError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      wait(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Nom daté d'une copie de secours : « profile » + « .json » → « profile-2026-10-17T09-30-00-000Z.json ». Daté, pour
 * qu'un second incident n'écrase jamais le premier.
 */
export function unreadableCopyName(label: string, extension: string, now: number): string {
  const safeLabel = label.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'fichier'
  return `${safeLabel}-${new Date(now).toISOString().replace(/[:.]/g, '-')}${extension}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Range un fichier abîmé dans `asideDir` sous un nom daté libre (jamais par-dessus une autre copie), et le retire de
 * sa place : le magasin peut alors repartir d'un fichier neuf sans rien perdre. Un fichier déjà parti (un autre accès
 * l'a rangé juste avant) n'est pas une erreur. Ni lisible ni déplaçable : DataFileUnreadableError, rien n'est écrit.
 *
 * `expected` : le contenu abîmé lu juste avant. S'il a changé entre-temps (un autre accès l'a déjà rangé, puis un
 * fichier neuf a été écrit), le fichier en place n'est PAS déplacé : `null`, et l'appelant le relit.
 */
export async function setAsideDamagedFile(file: string, asideDir: string, label: string, now = Date.now(), expected?: string): Promise<string | null> {
  const extension = extname(file)
  const name = unreadableCopyName(label, extension, now)
  const base = name.slice(0, name.length - extension.length)
  try {
    if (expected !== undefined && (await readFileWithRetries(file)) !== expected) return null
    await mkdir(asideDir, { recursive: true })
    for (let index = 1; ; index++) {
      const candidate = join(asideDir, index === 1 ? name : `${base}-${index}${extension}`)
      if (await exists(candidate)) continue
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(file, candidate)
          console.error(`[jaris] ${basename(file)} abîmé, mis de côté dans ${candidate}`)
          return candidate
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
          if (!isTransientFsError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
          await sleep(RENAME_RETRY_DELAYS_MS[attempt])
        }
      }
    }
  } catch (err) {
    throw err instanceof DataFileUnreadableError ? err : new DataFileUnreadableError(file, err)
  }
}

export type DataFileRead<T> = { status: 'missing' } | { status: 'ok'; value: T } | { status: 'damaged'; asidePath: string | null }

/**
 * Lit un fichier JSON de données. `parse` reçoit le JSON décodé et renvoie la valeur, ou `null` si sa forme ne va pas.
 * - absent : `missing` ;
 * - abîmé (pas du JSON, ou mauvaise forme) : rangé dans `asideDir`, puis `damaged` — l'appelant repart d'une valeur
 *   neuve SANS rien perdre ;
 * - illisible (refus qui dure) : DataFileUnreadableError — surtout pas pris pour un fichier absent ou vide.
 */
export async function readJsonDataFile<T>(file: string, parse: (value: unknown) => T | null, asideDir: string, label: string): Promise<DataFileRead<T>> {
  for (let attempt = 0; ; attempt++) {
    const raw = await readFileWithRetries(file)
    if (raw === null) return { status: 'missing' }
    let value: T | null = null
    try {
      value = parse(JSON.parse(raw))
    } catch {
      value = null
    }
    if (value !== null) return { status: 'ok', value }
    const asidePath = await setAsideDamagedFile(file, asideDir, label, Date.now(), raw)
    // Remplacé entre la lecture et la mise de côté (un autre accès l'a déjà rangé, puis un fichier neuf a été écrit) :
    // on relit ce fichier neuf, une fois, plutôt que de le prendre pour abîmé.
    if (asidePath !== null || attempt >= 1) return { status: 'damaged', asidePath }
  }
}

/** Le nom d'un fichier temporaire d'écriture (ou de copie en cours) : jamais une donnée à lire ou à réunir. */
export function isTemporaryDataName(name: string): boolean {
  return name.endsWith(TEMPORARY_SUFFIX) || name.endsWith('.jaris-copie')
}
