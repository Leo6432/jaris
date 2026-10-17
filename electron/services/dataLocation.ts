import { app } from 'electron'
import { existsSync, rmSync } from 'fs'
import { cp, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { DATA_SUBDIR, DEFAULT_USER_DATA, ELECTRON_SUBDIR, OWNED_ENTRIES, carryChromiumKeySync, getStorageRoot, writeMarker } from './storageRoot'
import { t } from '../../shared/i18n'

/**
 * Où vivent les données PROPRES à Jaris — conversations, profil, mémoire, applications générées, rappels.
 *
 * Étape 143 : elles suivent la racine de stockage unique (storageRoot.ts) — `<racine>\jaris-data` quand Jaris
 * a été installé sur un autre disque ou déplacé, sinon le dossier par défaut de Windows. Pas de jonction ici :
 * ce sont nos propres fichiers, Jaris sait où les lire.
 *
 * Toujours la règle d'origine (étape 121) pour un déplacement : copier D'ABORD, basculer ensuite (le
 * fichier-repère), n'effacer les originaux qu'EN DERNIER — jamais une donnée effacée avant d'exister ailleurs.
 */
export function getDataRoot(): string {
  const root = getStorageRoot()
  return root ? join(root, DATA_SUBDIR) : DEFAULT_USER_DATA
}

/** Étape 1 d'un « Déplacer » : copie des données vers la nouvelle racine. Rien n'est effacé. */
export async function copyDataTo(newRoot: string, onProgress: (message: string) => void): Promise<void> {
  const from = getDataRoot()
  const dest = join(newRoot, DATA_SUBDIR)
  if (from === dest) return
  await mkdir(dest, { recursive: true })
  for (const entry of OWNED_ENTRIES) {
    const source = join(from, entry)
    if (!existsSync(source)) continue
    onProgress(t('move.copyingData', { entry }))
    await cp(source, join(dest, entry), { recursive: true, force: true })
  }
}

/**
 * Étape 2 : bascule. Le fichier-repère pointe désormais vers la nouvelle racine, lue au prochain démarrage.
 * Le dossier interne de Chromium de CETTE exécution est encore ouvert : noté pour être effacé au démarrage
 * suivant (cleanupStaleChromiumData).
 *
 * Sa clé de chiffrement part d'abord dans le nouveau dossier de Chromium (CHROMIUM_KEY_FILE), en remplaçant toute
 * clé laissée là par une ancienne session : c'est elle qui a chiffré le jeton GitHub copié avec les données. Sans
 * elle, Chromium en crée une nouvelle au démarrage suivant et le jeton devient illisible (déconnecté de GitHub).
 */
export function switchStorageRoot(newRoot: string): void {
  const currentElectronDir = app.getPath('userData')
  const newElectronDir = join(newRoot, ELECTRON_SUBDIR)
  const createdElectronDir = !existsSync(newElectronDir)
  carryChromiumKeySync([currentElectronDir], newElectronDir, true)
  try {
    writeMarker(DEFAULT_USER_DATA, newRoot, currentElectronDir === DEFAULT_USER_DATA ? null : currentElectronDir)
  } catch (err) {
    // Rien n'a basculé : ne rien laisser derrière.
    if (createdElectronDir) rmSync(newElectronDir, { recursive: true, force: true })
    throw err
  }
}

/** Étape 3 : effacement des anciennes données, une fois la bascule faite. */
export async function removeOldData(previousRoot: string | null, newRoot: string): Promise<void> {
  const from = previousRoot ? join(previousRoot, DATA_SUBDIR) : DEFAULT_USER_DATA
  if (from === join(newRoot, DATA_SUBDIR)) return
  // Dans le dossier par défaut de Windows, seules les entrées CONNUES sont effacées (il garde le
  // fichier-repère) ; un ancien dossier `jaris-data` n'a jamais contenu que nos fichiers.
  if (!previousRoot) {
    // Chaque entrée est tentée, même après un échec (fichier encore ouvert) : une seule entrée bloquée ne doit pas
    // laisser toutes les suivantes sur l'ancien disque. L'échec remonte ensuite (signalé comme reste à effacer).
    let failure: unknown = null
    for (const entry of OWNED_ENTRIES) {
      try {
        await rm(join(from, entry), { recursive: true, force: true })
      } catch (err) {
        failure ??= err
      }
    }
    if (failure) throw failure
  } else {
    await rm(from, { recursive: true, force: true })
  }
}
