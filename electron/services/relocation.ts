import { app } from 'electron'
import { existsSync } from 'fs'
import { readdir, rm, rmdir } from 'fs/promises'
import { join, resolve, sep, win32 } from 'path'
import { copyDataTo, getDataRoot, removeDeletedSinceCopy, removeOldData, switchStorageRoot, type DataCopy } from './dataLocation'
import { downloadToFile } from './download'
import {
  bricks,
  bytesToCopy,
  copyAll,
  discardCopies,
  finalizeAll,
  folderSize,
  freeBytes,
  planMoves,
  switchAll,
  undoSwitches,
  currentRealDir,
  type CommittedMove
} from './modelsLocation'
import { DATA_SUBDIR, DOWNLOADS_SUBDIR, getStorageRoot } from './storageRoot'
import { t } from '../../shared/i18n'
import { formatBytes } from '../../shared/formatBytes'

/**
 * Étape 143, Léo : « si il veut changer dans les options ça doit tout déplacer, jamais une partie ».
 *
 * Le bouton « Déplacer » d'Options enchaîne ici, dans cet ordre, TOUT ce que Jaris a écrit sur le disque :
 * dossiers lourds (Ollama, Python, voix), conversations et réglages, et le programme Jaris lui-même.
 *
 * Tout ou rien : tout ce qui peut échouer « pour une raison extérieure » (place disque, installeur introuvable,
 * copie interrompue) est vérifié ou fait AVANT la moindre modification ;
 * la bascule elle-même se défait entièrement si une étape échoue. Seul l'effacement final des anciens
 * dossiers peut laisser un résidu (fichier verrouillé) — les données, elles, sont déjà toutes à destination
 * (un rattrapage de dernière minute qui échouerait laisse l'ancien dossier des données en place, jamais effacé).
 */

const REPO = 'Leo6432/jaris'
/** Marge gardée libre sur le disque de destination, pour ne jamais le remplir à ras bord. */
const FREE_SPACE_MARGIN_BYTES = 2 * 1024 ** 3
/** Taille de l'installeur de Jaris (~100 Mo), comptée si le programme doit être réinstallé ailleurs. */
const PROGRAM_INSTALLER_BYTES = 150 * 1024 ** 2

/** Le programme vit dans `<racine>\Jaris` après un « Déplacer ». */
export const PROGRAM_SUBDIR = 'Jaris'

export function installerUrlForVersion(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/Jaris-Setup-${version}.exe`
}

/**
 * Arguments de l'installeur pour réinstaller Jaris AILLEURS : silencieux, Jaris relancé à la fin, et `/D=` —
 * qui l'emporte sur le dossier déjà enregistré (gabarit multiUser.nsh d'electron-builder : « allow /D switch
 * to override installation path »). `/D=` doit être le DERNIER argument, sans guillemets même avec des
 * espaces (règle NSIS) : d'où une ligne de commande passée telle quelle (windowsVerbatimArguments).
 */
export function programMoveCommandLine(targetDir: string): string {
  return `/S --updated --force-run /D=${targetDir}`
}

export class RelocationRefused extends Error {}

/**
 * Où les anciennes versions installaient Docker dans la racine (étape 143). Jaris ne s'en sert plus depuis l'étape 337,
 * mais Docker Desktop y vit peut-être encore : jamais une destination à l'intérieur, jamais effacés.
 */
const LEGACY_DOCKER_APP_SUBDIR = 'docker'
const LEGACY_DOCKER_DATA_SUBDIR = 'docker-data'

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Refuse une destination qui ferait perdre des données : DANS le dossier du programme (chaque mise à jour
 * l'efface en entier), ou dans un des dossiers déplacés eux-mêmes (copie d'un dossier dans son propre
 * sous-dossier).
 */
export function validateNewRoot(newRoot: string, forbiddenParents: string[]): void {
  for (const parent of forbiddenParents) {
    if (parent && isInside(newRoot, parent)) {
      throw new RelocationRefused(t('move.outsideParent', { parent }))
    }
  }
}

export interface RelocationDeps {
  onProgress: (message: string) => void
}

export interface RelocationResult {
  /** Installeur à lancer une fois Jaris fermé (programme à réinstaller dans la nouvelle racine), sinon `null`. */
  programInstaller: string | null
  programTarget: string | null
  leftovers: string[]
  /** Le nouveau dossier des données (conversations, réglages…), pour y écrire ce qui a été gardé en mémoire pendant le déplacement. */
  dataDir: string
}

function formatGb(bytes: number): string {
  return formatBytes(bytes)
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    // pas vide ou déjà absent
  }
}

export async function relocateEverything(newRoot: string, deps: RelocationDeps): Promise<RelocationResult> {
  const { onProgress } = deps
  // Les emplacements déplacés sont ceux de Windows (%LOCALAPPDATA%, %USERPROFILE%) : ailleurs, ils seraient
  // vides et chaque chemin deviendrait relatif au dossier courant.
  if (process.platform !== 'win32') throw new RelocationRefused(t('move.windowsOnly'))
  const previousRoot = getStorageRoot()
  if (previousRoot && previousRoot.toLowerCase() === newRoot.toLowerCase()) {
    throw new RelocationRefused(t('move.alreadyThere', { dir: newRoot }))
  }

  const exePath = app.getPath('exe')
  const installDir = app.isPackaged ? win32.dirname(exePath) : ''
  const currentDirs = await Promise.all(bricks().map((b) => currentRealDir(b.link)))
  validateNewRoot(newRoot, [
    installDir,
    getDataRoot(),
    app.getPath('userData'),
    // Étape 337 : un Docker installé par une ancienne version de Jaris peut encore vivre dans l'ancienne racine.
    ...(previousRoot ? [join(previousRoot, LEGACY_DOCKER_APP_SUBDIR), join(previousRoot, LEGACY_DOCKER_DATA_SUBDIR)] : []),
    ...currentDirs.filter((d): d is string => Boolean(d))
  ])

  // --- 1. Vérifications, sans rien modifier ---
  onProgress(t('move.checking'))
  const plans = await planMoves(newRoot)
  const programTarget = app.isPackaged && !isInside(exePath, newRoot) ? join(newRoot, PROGRAM_SUBDIR) : null

  const needed =
    (await bytesToCopy(plans)) + (await folderSize(getDataRoot())) + (programTarget ? PROGRAM_INSTALLER_BYTES : 0)
  const free = await freeBytes(newRoot)
  if (free !== null && free - FREE_SPACE_MARGIN_BYTES < needed) {
    throw new RelocationRefused(t('move.noSpace', { dir: newRoot, needed: formatGb(needed + FREE_SPACE_MARGIN_BYTES), free: formatGb(free) }))
  }

  // --- 2. Préparation : installeur du programme, puis copies. L'origine n'est toujours pas touchée ---
  let programInstaller: string | null = null
  if (programTarget) {
    const version = app.getVersion()
    const downloads = join(newRoot, DOWNLOADS_SUBDIR)
    programInstaller = join(downloads, `Jaris-Setup-${version}.exe`)
    onProgress(t('move.downloadingProgram'))
    try {
      await downloadToFile(installerUrlForVersion(version), programInstaller, {
        onProgress: ({ percent }) => {
          if (percent !== null) onProgress(t('move.downloadingProgramPercent', { percent: Math.round(percent) }))
        }
      })
    } catch (err) {
      await rm(downloads, { recursive: true, force: true }).catch(() => {})
      throw new RelocationRefused(t('move.programDownloadFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const dataDest = join(newRoot, DATA_SUBDIR)
  const createdDataDest = !existsSync(dataDest)
  const discardEverything = async (): Promise<void> => {
    await discardCopies(plans)
    if (createdDataDest) await rm(dataDest, { recursive: true, force: true }).catch(() => {})
    if (programInstaller) await rm(join(newRoot, DOWNLOADS_SUBDIR), { recursive: true, force: true }).catch(() => {})
  }

  let dataCopy: DataCopy | null = null
  try {
    await copyAll(plans, onProgress)
    // Les petites données (conversations, réglages, jeton GitHub…) APRÈS les modèles et Python : leur copie dure
    // souvent des dizaines de minutes, pendant lesquelles Jaris reste ouvert. Copiées avant, tout ce qui y était écrit
    // entre-temps (une conversation du Chat, un jeton GitHub renouvelé…) restait dans l'ancien dossier, effacé à la
    // fin. Même essai, même annulation complète si cette copie échoue. Ce qui change encore ensuite (bascule,
    // désinstallation de Docker en attente d'une autorisation Windows, sa réinstallation) est rattrapé juste avant
    // d'effacer l'ancien dossier (étape 5).
    dataCopy = await copyDataTo(newRoot, onProgress)
  } catch (err) {
    await discardEverything()
    throw new Error(t('move.copyFailed', { error: err instanceof Error ? err.message : String(err) }))
  }

  // --- 3. Bascule : tout se défait si une étape échoue ---
  onProgress(t('move.switching'))
  let done: CommittedMove[]
  try {
    done = await switchAll(plans)
  } catch (err) {
    await discardEverything()
    throw new Error(t('move.rolledBack', { error: err instanceof Error ? err.message : String(err) }))
  }

  try {
    switchStorageRoot(newRoot)
  } catch (err) {
    await undoSwitches(done)
    await discardEverything()
    throw new Error(t('move.saveRootFailed', { error: err instanceof Error ? err.message : String(err) }))
  }

  // --- 4. Effacement des anciens emplacements (les données, elles, à l'étape 5) ---
  onProgress(t('move.cleaning'))
  const leftovers = await finalizeAll(done)
  if (previousRoot) {
    // Pas les dossiers d'un Docker installé par une ancienne version (étape 337) : Docker Desktop y tourne peut-être
    // encore, pour Léo ou pour autre chose — Jaris ne s'en sert plus, mais ne le casse pas.
    await rm(join(previousRoot, DOWNLOADS_SUBDIR), { recursive: true, force: true }).catch(() => {})
  }

  // --- 5. Dernières modifications, puis effacement des anciennes données ---
  // Jaris est resté ouvert depuis la copie des données, et il écrit toujours dans l'ancien dossier jusqu'à sa
  // relance : une conversation du Chat envoyée pendant que la fenêtre d'autorisation de Windows attendait (Docker),
  // pendant l'effacement des anciens modèles ou pendant la réinstallation de Docker (plusieurs minutes). Ce qui a été
  // ajouté ou modifié depuis est recopié juste avant d'effacer, sans rien d'autre entre les deux ; ce qui a été
  // SUPPRIMÉ depuis (une conversation, une application, une image, une note) est retiré de la copie, sinon il
  // réapparaissait après la relance. La bascule est déjà faite : si ce rattrapage échoue, rien n'est effacé — l'ancien
  // dossier reste, signalé, plutôt que de perdre ces dernières modifications.
  const oldData = previousRoot ? join(previousRoot, DATA_SUBDIR) : t('move.oldConversations')
  try {
    await copyDataTo(newRoot, onProgress, { onlyChanged: true })
    if (dataCopy) await removeDeletedSinceCopy(dataCopy)
    try {
      await removeOldData(previousRoot, newRoot)
    } catch {
      leftovers.push(oldData)
    }
  } catch {
    leftovers.push(oldData)
  }
  // Le dossier interne de Chromium, encore ouvert, est effacé au prochain démarrage (storageRoot.ts), qui
  // retire aussi l'ancienne racine une fois vide.
  if (previousRoot) await removeIfEmpty(previousRoot)

  return { programInstaller, programTarget, leftovers, dataDir: dataDest }
}

let reconciling: Promise<void> | null = null

/**
 * Au démarrage, quand Jaris a un dossier (installé sur D, ou déplacé) : range dedans tout ce qui n'y est pas
 * encore — une machine neuve (rien d'installé : les jonctions sont posées avant qu'Ollama/Python ne
 * s'installent, donc ils s'installent directement dans le dossier), ou un Ollama installé depuis sur C.
 * Sans ce contrôle, un logiciel installé APRÈS le choix du dossier finirait sur C sans que personne ne le
 * voie (même famille que le contrôle SearXNG de l'étape 103 : un réglage ne corrige que l'avenir, il faut
 * constater l'état réel au démarrage). Tout ou rien, comme « Déplacer ». Un seul passage à la fois.
 */
export function reconcileStorage(log: (message: string) => void, stopOllama: () => Promise<void>): Promise<void> {
  if (reconciling) return reconciling
  reconciling = (async () => {
    const root = getStorageRoot()
    if (!root || process.platform !== 'win32') return
    const plans = await planMoves(root)
    if (!plans.length) return
    const needed = await bytesToCopy(plans)
    const free = await freeBytes(root)
    if (free !== null && free - FREE_SPACE_MARGIN_BYTES < needed) {
      log(t('move.reconcileNoSpace', { dir: root, needed: formatGb(needed) }))
      return
    }
    if (plans.some((p) => p.real && p.brick.subdir.startsWith('ollama'))) await stopOllama()
    log(t('move.reconciling', { dir: root }))
    try {
      await copyAll(plans, log)
      let done: CommittedMove[]
      try {
        done = await switchAll(plans)
      } catch (err) {
        await discardCopies(plans)
        throw err
      }
      await finalizeAll(done)
      log(t('move.reconciled', { dir: root }))
    } catch (err) {
      log(t('move.reconcileFailed', { dir: root, error: err instanceof Error ? err.message : String(err) }))
    }
  })().finally(() => {
    reconciling = null
  })
  return reconciling
}

/** Où vit réellement chaque partie de Jaris, lu sur le disque (Options → Modèles). */
export async function getStorageStatus(): Promise<{ root: string | null; items: { label: string; path: string }[] }> {
  const items: { label: string; path: string }[] = []
  if (app.isPackaged) items.push({ label: t('brick.program'), path: win32.dirname(app.getPath('exe')) })
  items.push({ label: t('brick.data'), path: getDataRoot() })
  for (const brick of bricks()) items.push({ label: brick.label, path: (await currentRealDir(brick.link)) ?? brick.link })
  return { root: getStorageRoot(), items }
}
