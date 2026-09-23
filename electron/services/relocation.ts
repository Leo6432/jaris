import { app } from 'electron'
import { existsSync } from 'fs'
import { readdir, rm, rmdir } from 'fs/promises'
import { join, win32 } from 'path'
import { copyDataTo, getDataRoot, removeOldData, switchStorageRoot } from './dataLocation'
import { DOCKER_APP_SUBDIR, DOCKER_DATA_SUBDIR, isInside, planDockerMove, uninstallDockerForMove, type DockerMovePlan } from './dockerLocation'
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

/**
 * Étape 143, Léo : « si il veut changer dans les options ça doit tout déplacer, jamais une partie ».
 *
 * Le bouton « Déplacer » d'Options enchaîne ici, dans cet ordre, TOUT ce que Jaris a écrit sur le disque :
 * dossiers lourds (Ollama, Python, voix), conversations et réglages, Docker, et le programme Jaris lui-même.
 *
 * Tout ou rien : tout ce qui peut échouer « pour une raison extérieure » (place disque, Docker qui contient
 * autre chose, installeur introuvable, copie interrompue) est vérifié ou fait AVANT la moindre modification ;
 * la bascule elle-même se défait entièrement si une étape échoue. Seul l'effacement final des anciens
 * dossiers peut laisser un résidu (fichier verrouillé) — les données, elles, sont déjà toutes à destination.
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
 * Refuse une destination qui ferait perdre des données : DANS le dossier du programme (chaque mise à jour
 * l'efface en entier), ou dans un des dossiers déplacés eux-mêmes (copie d'un dossier dans son propre
 * sous-dossier).
 */
export function validateNewRoot(newRoot: string, forbiddenParents: string[]): void {
  for (const parent of forbiddenParents) {
    if (parent && isInside(newRoot, parent)) {
      throw new RelocationRefused(
        `Choisis un dossier en dehors de ${parent} : Jaris y range déjà ses propres fichiers. Rien n'a été déplacé.`
      )
    }
  }
}

export interface RelocationDeps {
  onProgress: (message: string) => void
  /** Démarre Docker Desktop s'il ne répond pas (pour vérifier ce qu'il contient). */
  startDocker: () => Promise<void>
  /** Réinstalle Docker directement dans la nouvelle racine après sa désinstallation. */
  installDocker: (root: string) => Promise<boolean>
}

export interface RelocationResult {
  /** Installeur à lancer une fois Jaris fermé (programme à réinstaller dans la nouvelle racine), sinon `null`. */
  programInstaller: string | null
  programTarget: string | null
  dockerUninstalled: boolean
  dockerReinstalled: boolean
  leftovers: string[]
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go`
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
  if (process.platform !== 'win32') throw new RelocationRefused("Cette fonctionnalité n'est disponible que sur Windows.")
  const previousRoot = getStorageRoot()
  if (previousRoot && previousRoot.toLowerCase() === newRoot.toLowerCase()) {
    throw new RelocationRefused(`Tout est déjà dans ${newRoot}.`)
  }

  const exePath = app.getPath('exe')
  const installDir = app.isPackaged ? win32.dirname(exePath) : ''
  const currentDirs = await Promise.all(bricks().map((b) => currentRealDir(b.link)))
  validateNewRoot(newRoot, [
    installDir,
    getDataRoot(),
    app.getPath('userData'),
    ...(previousRoot ? [join(previousRoot, DOCKER_APP_SUBDIR), join(previousRoot, DOCKER_DATA_SUBDIR)] : []),
    ...currentDirs.filter((d): d is string => Boolean(d))
  ])

  // --- 1. Vérifications, sans rien modifier ---
  onProgress('Vérification de ce qui doit être déplacé…')
  const plans = await planMoves(newRoot)
  const dockerPlan: DockerMovePlan = await planDockerMove(newRoot, deps.startDocker, previousRoot ? [join(previousRoot, DOCKER_APP_SUBDIR)] : [])
  const programTarget = app.isPackaged && !isInside(exePath, newRoot) ? join(newRoot, PROGRAM_SUBDIR) : null

  const needed =
    (await bytesToCopy(plans)) + (await folderSize(getDataRoot())) + (programTarget ? PROGRAM_INSTALLER_BYTES : 0)
  const free = await freeBytes(newRoot)
  if (free !== null && free - FREE_SPACE_MARGIN_BYTES < needed) {
    throw new RelocationRefused(
      `Pas assez de place dans ${newRoot} : il faut ${formatGb(needed + FREE_SPACE_MARGIN_BYTES)} libres, il y en a ` +
        `${formatGb(free)}. Rien n'a été déplacé.`
    )
  }

  // --- 2. Préparation : installeur du programme, puis copies. L'origine n'est toujours pas touchée ---
  let programInstaller: string | null = null
  if (programTarget) {
    const version = app.getVersion()
    const downloads = join(newRoot, DOWNLOADS_SUBDIR)
    programInstaller = join(downloads, `Jaris-Setup-${version}.exe`)
    onProgress('Téléchargement du programme Jaris pour le réinstaller dans le nouveau dossier…')
    try {
      await downloadToFile(installerUrlForVersion(version), programInstaller, {
        onProgress: ({ percent }) => {
          if (percent !== null) onProgress(`Téléchargement du programme Jaris… ${Math.round(percent)} %`)
        }
      })
    } catch (err) {
      await rm(downloads, { recursive: true, force: true }).catch(() => {})
      throw new RelocationRefused(
        `Impossible de télécharger le programme Jaris (${err instanceof Error ? err.message : String(err)}) : il faut ` +
          'Internet pour le déplacer lui aussi. Rien n\'a été déplacé.'
      )
    }
  }

  const dataDest = join(newRoot, DATA_SUBDIR)
  const createdDataDest = !existsSync(dataDest)
  const discardEverything = async (): Promise<void> => {
    await discardCopies(plans)
    if (createdDataDest) await rm(dataDest, { recursive: true, force: true }).catch(() => {})
    if (programInstaller) await rm(join(newRoot, DOWNLOADS_SUBDIR), { recursive: true, force: true }).catch(() => {})
  }

  try {
    await copyDataTo(newRoot, onProgress)
    await copyAll(plans, onProgress)
  } catch (err) {
    await discardEverything()
    throw new Error(`La copie a échoué (${err instanceof Error ? err.message : String(err)}). Rien n'a été déplacé.`)
  }

  // --- 3. Bascule : tout se défait si une étape échoue ---
  onProgress('Bascule vers le nouveau dossier…')
  let done: CommittedMove[]
  try {
    done = await switchAll(plans)
  } catch (err) {
    await discardEverything()
    throw new Error(`${err instanceof Error ? err.message : String(err)}. Tout a été remis comme avant.`)
  }

  let dockerUninstalled = false
  if (dockerPlan.action === 'uninstall') {
    onProgress('Désinstallation de Docker Desktop (une fenêtre Windows va demander une autorisation — accepte-la)…')
    dockerUninstalled = await uninstallDockerForMove(dockerPlan.installDir)
    if (!dockerUninstalled) {
      await undoSwitches(done)
      await discardEverything()
      throw new Error(
        "Docker Desktop n'a pas pu être désinstallé (autorisation Windows refusée ?) : tout a été remis comme avant."
      )
    }
  }

  try {
    switchStorageRoot(newRoot)
  } catch (err) {
    await undoSwitches(done)
    await discardEverything()
    throw new Error(`Impossible d'enregistrer le nouveau dossier (${err instanceof Error ? err.message : String(err)}). Tout a été remis comme avant.`)
  }

  // --- 4. Effacement des anciens emplacements ---
  onProgress("Effacement des anciens emplacements…")
  const leftovers = await finalizeAll(done)
  try {
    await removeOldData(previousRoot, newRoot)
  } catch {
    leftovers.push(previousRoot ? join(previousRoot, DATA_SUBDIR) : 'anciennes conversations')
  }
  if (previousRoot) {
    for (const sub of [DOWNLOADS_SUBDIR, DOCKER_APP_SUBDIR, DOCKER_DATA_SUBDIR]) {
      await rm(join(previousRoot, sub), { recursive: true, force: true }).catch(() => {})
    }
    // Le dossier interne de Chromium, encore ouvert, est effacé au prochain démarrage (storageRoot.ts), qui
    // retire aussi l'ancienne racine une fois vide.
    await removeIfEmpty(previousRoot)
  }

  // Docker ne peut pas être déplacé par jonction : l'installation officielle doit recréer son programme
  // ET son disque WSL dans la nouvelle racine. Ne pas reporter cette étape à une future recherche web.
  let dockerReinstalled = !dockerUninstalled
  if (dockerUninstalled) {
    onProgress('Réinstallation de Docker Desktop et de ses données dans le nouveau dossier…')
    try {
      dockerReinstalled = await deps.installDocker(newRoot)
    } catch {
      dockerReinstalled = false
    }
  }

  return { programInstaller, programTarget, dockerUninstalled, dockerReinstalled, leftovers }
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
      log(`Pas assez de place dans ${root} pour y ranger ${formatGb(needed)} : laissé en place pour l'instant.`)
      return
    }
    if (plans.some((p) => p.real && p.brick.subdir.startsWith('ollama'))) await stopOllama()
    log(`Rangement dans ${root} de ce qui était encore ailleurs…`)
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
      log(`Tout est rangé dans ${root}.`)
    } catch (err) {
      log(`Rangement dans ${root} impossible pour l'instant (${err instanceof Error ? err.message : String(err)}) : rien n'a changé.`)
    }
  })().finally(() => {
    reconciling = null
  })
  return reconciling
}

/** Où vit réellement chaque partie de Jaris, lu sur le disque (Options → Modèles). */
export async function getStorageStatus(dockerInstallDir: string | null): Promise<{ root: string | null; items: { label: string; path: string }[] }> {
  const items: { label: string; path: string }[] = []
  if (app.isPackaged) items.push({ label: 'le programme Jaris', path: win32.dirname(app.getPath('exe')) })
  items.push({ label: 'tes conversations et réglages', path: getDataRoot() })
  for (const brick of bricks()) items.push({ label: brick.label, path: (await currentRealDir(brick.link)) ?? brick.link })
  if (dockerInstallDir) items.push({ label: 'Docker Desktop (recherche web)', path: dockerInstallDir })
  return { root: getStorageRoot(), items }
}
