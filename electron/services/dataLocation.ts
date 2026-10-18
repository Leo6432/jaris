import { app } from 'electron'
import { existsSync, rmSync } from 'fs'
import { cp, lstat, mkdir, rm, rmdir, stat } from 'fs/promises'
import { join, relative } from 'path'
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

/**
 * Un fichier a-t-il changé depuis sa copie ? Plus récent ou d'une autre taille que la copie. Une copie garde la date du
 * fichier sous Windows (CopyFile) et prend celle du moment de la copie ailleurs : dans les deux cas, un fichier
 * modifié après elle est plus récent qu'elle. Un dossier est toujours parcouru, ses fichiers sont filtrés un par un.
 */
async function changedSinceCopy(source: string, destination: string): Promise<boolean> {
  const original = await stat(source)
  if (original.isDirectory()) return true
  const copy = await stat(destination).catch(() => null)
  return !copy || copy.size !== original.size || original.mtimeMs > copy.mtimeMs
}

/** L'état d'un fichier juste après sa copie : s'il a changé depuis, quelqu'un d'autre y a écrit. */
interface CopyStamp {
  size: number
  mtimeMs: number
}

/**
 * Ce qu'une copie des données a CRÉÉ dans la destination : les fichiers et dossiers qui n'y existaient pas avant elle,
 * en chemins relatifs au dossier des données (`generated-apps\…\index.html`). Un nom déjà présent à destination avant
 * la copie (dossier déjà utilisé par Jaris, ancienne racine) n'y figure jamais : il appartient à ce qui était là.
 */
export interface DataCopy {
  from: string
  dest: string
  files: Map<string, CopyStamp>
  dirs: string[]
}

/**
 * Étape 1 d'un « Déplacer » : copie des données vers la nouvelle racine. Rien n'est effacé. Renvoie ce que la copie a
 * créé à destination (`null` si la source EST la destination), pour que le rattrapage final retire ce que Léo a
 * supprimé entre-temps (removeDeletedSinceCopy).
 * `onlyChanged` : rattrapage, juste avant d'effacer l'ancien dossier — seuls les fichiers ajoutés ou modifiés depuis la
 * première copie sont recopiés (sans tout recopier, vidéos comprises), sans message d'avancement.
 */
export async function copyDataTo(
  newRoot: string,
  onProgress: (message: string) => void,
  { onlyChanged = false }: { onlyChanged?: boolean } = {}
): Promise<DataCopy | null> {
  const from = getDataRoot()
  const dest = join(newRoot, DATA_SUBDIR)
  if (from === dest) return null
  await mkdir(dest, { recursive: true })
  const createdFiles: string[] = []
  const dirs: string[] = []
  // Appelé par cp AVANT de copier chaque élément : un élément absent de la destination à ce moment-là est créé par
  // cette copie. Un élément sauté (rattrapage : inchangé) n'est pas copié, donc pas noté.
  const filter = async (source: string, destination: string): Promise<boolean> => {
    if (onlyChanged && !(await changedSinceCopy(source, destination))) return false
    if (!(await lstat(destination).catch(() => null))) {
      const created = (await lstat(source)).isDirectory() ? dirs : createdFiles
      created.push(relative(dest, destination))
    }
    return true
  }
  for (const entry of OWNED_ENTRIES) {
    const source = join(from, entry)
    if (!existsSync(source)) continue
    if (!onlyChanged) onProgress(t('move.copyingData', { entry }))
    await cp(source, join(dest, entry), { recursive: true, force: true, filter })
  }
  const files = new Map<string, CopyStamp>()
  for (const rel of createdFiles) {
    const copy = await lstat(join(dest, rel)).catch(() => null)
    if (copy?.isFile()) files.set(rel, { size: copy.size, mtimeMs: copy.mtimeMs })
  }
  return { from, dest, files, dirs }
}

/**
 * Rattrapage d'un « Déplacer », après la recopie de ce qui a changé : retire de la destination ce que la PREMIÈRE copie
 * y avait mis et qui a été supprimé de l'ancien dossier depuis — une conversation, une application, une image ou une
 * note supprimée pendant la longue copie des modèles réapparaissait sinon après la relance. Ne retire jamais :
 * - un fichier qui était à destination avant le déplacement (absent de `copy`) ;
 * - un fichier modifié à destination depuis la copie (quelqu'un d'autre y a écrit, par exemple les conversations du
 *   mode Code relâchées dans le nouveau dossier) ;
 * - un dossier qui existe encore à la source, ou qui n'est pas vide.
 * Lève à la moindre erreur : le rattrapage a échoué, l'ancien dossier n'est alors pas effacé (relocation.ts).
 */
export async function removeDeletedSinceCopy(copy: DataCopy): Promise<void> {
  for (const [rel, stamp] of copy.files) {
    if (existsSync(join(copy.from, rel))) continue
    const target = join(copy.dest, rel)
    const now = await lstat(target).catch(() => null)
    if (!now || !now.isFile() || now.size !== stamp.size || now.mtimeMs !== stamp.mtimeMs) continue
    await rm(target, { force: true })
  }
  // Les plus profonds d'abord : un sous-dossier vidé libère son parent. Un dossier vide créé par la copie et supprimé
  // depuis à la source compte : une application du mode Code est un dossier, elle reviendrait sinon dans la liste.
  for (const rel of [...copy.dirs].sort((a, b) => b.length - a.length)) {
    if (existsSync(join(copy.from, rel))) continue
    try {
      await rmdir(join(copy.dest, rel))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Pas vide : quelqu'un y a écrit depuis, rien n'est effacé. Déjà absent : rien à faire.
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err
    }
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
