import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, win32 } from 'path'

/**
 * Étape 143, Léo : « si il choisit dès l'installation le D tout est dans le D, ou si il veut changer dans les
 * options ça doit tout déplacer, jamais une partie ».
 *
 * UNE seule racine de stockage pour tout ce que Jaris écrit — le dossier choisi dans Options → « Déplacer »,
 * ou, à la toute première installation sur un autre disque que C, un dossier `Jaris-data` posé À CÔTÉ du
 * dossier du programme (jamais dedans : chaque mise à jour efface le dossier du programme en entier). Tout le
 * reste en découle : données (conversations, profil, mémoire…), cache interne de Chromium, modèles Ollama,
 * programme Ollama, environnement Python, cache de la voix, Docker.
 *
 * Seul ce petit fichier-repère reste obligatoirement dans le dossier par défaut de Windows (%APPDATA%\Jaris) :
 * c'est le seul endroit que Jaris sait retrouver au démarrage AVANT de savoir où est le reste.
 *
 * Ce module s'exécute à son chargement, AVANT que l'application soit prête : `app.setPath('userData')` n'est
 * pris en compte que s'il est appelé avant `ready` (et avant le verrou d'instance unique, qui en dépend).
 */

/** Le dossier par défaut de Windows, capturé avant toute redirection : c'est là que vit le fichier-repère. */
export const DEFAULT_USER_DATA = app.getPath('userData')

const MARKER_NAME = 'storage-location.json'
/** Ancien repère (étape 121, avant la racine unique) : `{ dataDir: <racine>\jaris-data }`. */
const LEGACY_MARKER_NAME = 'data-location.json'

export const DATA_SUBDIR = 'jaris-data'
export const ELECTRON_SUBDIR = 'electron'
export const DOWNLOADS_SUBDIR = 'downloads'
/** Nom du dossier créé à côté du programme quand Jaris est installé sur un autre disque que C. */
export const AUTO_ROOT_NAME = 'Jaris-data'

/**
 * Ce que Jaris écrit lui-même dans son dossier de données, et RIEN d'autre : jamais les fichiers internes de
 * Chromium qui partageaient autrefois le même dossier.
 */
export const OWNED_ENTRIES = ['conversations', 'conversation-history.json', 'profile.json', 'memory', 'generated-apps', 'reminders.json']

interface StorageMarker {
  root?: unknown
  /** Ancien dossier interne de Chromium à effacer au prochain démarrage (encore ouvert pendant le déplacement). */
  staleElectronDir?: unknown
}

/**
 * Le dossier de stockage automatique quand le PROGRAMME a été installé sur un autre disque que celui de
 * Windows : `D:\Jaris\Jaris.exe` -> `D:\Jaris-data`. `null` si le programme est sur le disque système.
 * Pur (chemins Windows explicites) pour être testé sans Windows.
 */
export function autoRootForInstall(exePath: string, systemDrive: string): string | null {
  const drive = win32.parse(exePath).root.slice(0, 2).toUpperCase()
  if (!/^[A-Z]:$/.test(drive) || drive === systemDrive.slice(0, 2).toUpperCase()) return null
  const installDir = win32.dirname(exePath)
  return win32.join(win32.dirname(installDir), AUTO_ROOT_NAME)
}

/** Lit la racine enregistrée (nouveau repère, sinon ancien repère des données). `null` si jamais déplacé. */
export function readMarkedRoot(userData: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(join(userData, MARKER_NAME), 'utf-8')) as StorageMarker
    if (typeof marker.root === 'string' && marker.root) return marker.root
  } catch {
    // pas de repère, ou illisible : on regarde l'ancien
  }
  try {
    const legacy = JSON.parse(readFileSync(join(userData, LEGACY_MARKER_NAME), 'utf-8')) as { dataDir?: unknown }
    if (typeof legacy.dataDir === 'string' && legacy.dataDir) {
      // L'ancien bouton copiait les données dans <dossier choisi>\jaris-data : la racine est son parent.
      const parent = legacy.dataDir.replace(/[\\/]+$/, '')
      const sep = Math.max(parent.lastIndexOf('\\'), parent.lastIndexOf('/'))
      if (sep > 0 && parent.slice(sep + 1) === DATA_SUBDIR) return parent.slice(0, sep)
    }
  } catch {
    // jamais déplacé
  }
  return null
}

export function readStaleElectronDir(userData: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(join(userData, MARKER_NAME), 'utf-8')) as StorageMarker
    return typeof marker.staleElectronDir === 'string' && marker.staleElectronDir ? marker.staleElectronDir : null
  } catch {
    return null
  }
}

/** Écrit le repère. Seule étape qui « bascule » Jaris vers une nouvelle racine (lue au prochain démarrage). */
export function writeMarker(userData: string, root: string, staleElectronDir?: string | null): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, MARKER_NAME), JSON.stringify({ root, staleElectronDir: staleElectronDir ?? undefined }, null, 2), 'utf-8')
  rmSync(join(userData, LEGACY_MARKER_NAME), { force: true })
}

/**
 * Copie les données de Jaris de `from` vers `to` puis efface les originaux — dans CET ordre, et chaque
 * original n'est effacé qu'une fois TOUTES les copies réussies : une erreur en route laisse les originaux
 * intacts (l'exception remonte). Une source absente est simplement sautée (installation neuve).
 */
export function moveOwnedEntriesSync(from: string, to: string): void {
  if (from === to) return
  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  for (const entry of OWNED_ENTRIES) {
    const source = join(from, entry)
    if (!existsSync(source)) continue
    cpSync(source, join(to, entry), { recursive: true, force: true })
    copied.push(source)
  }
  for (const source of copied) rmSync(source, { recursive: true, force: true })
}

/**
 * Au démarrage : quelle racine utiliser, et prépare-la. Renvoie `null` quand tout reste à l'emplacement par
 * défaut de Windows. Ne lève jamais : dans le pire des cas, Jaris démarre sur l'emplacement par défaut.
 */
function bootstrap(): string | null {
  let root = readMarkedRoot(DEFAULT_USER_DATA)
  let isNewAutoRoot = false
  if (!root && process.platform === 'win32' && app.isPackaged) {
    root = autoRootForInstall(app.getPath('exe'), process.env.SystemDrive ?? 'C:')
    isNewAutoRoot = root !== null
  }
  if (!root) return null

  try {
    // Une racine enregistrée mais introuvable (disque externe débranché) : on ne la recrée surtout pas vide,
    // Jaris repart sur l'emplacement par défaut au lieu de faire croire que tout a disparu.
    if (!existsSync(root)) {
      if (!isNewAutoRoot) return null
      mkdirSync(root, { recursive: true })
    }
    // Données encore dans le dossier par défaut (première installation sur D d'un Jaris déjà utilisé, ou
    // ancien repère) : rapatriées AVANT que le moindre store ne calcule son chemin.
    moveOwnedEntriesSync(DEFAULT_USER_DATA, join(root, DATA_SUBDIR))
    writeMarker(DEFAULT_USER_DATA, root, readStaleElectronDir(DEFAULT_USER_DATA))
    app.setPath('userData', join(root, ELECTRON_SUBDIR))
    return root
  } catch (err) {
    console.error('[jaris] Racine de stockage inutilisable, emplacement par défaut conservé :', err)
    return null
  }
}

let storageRoot: string | null = bootstrap()

/** La racine de stockage en service pour CETTE exécution de Jaris (`null` = emplacement par défaut de Windows). */
export function getStorageRoot(): string | null {
  return storageRoot
}

/** Pour les tests uniquement. */
export function setStorageRootForTests(root: string | null): void {
  storageRoot = root
}

/**
 * Où télécharger les gros installeurs (Ollama 1,5 Go, Docker 600 Mo, Jaris 100 Mo) : dans la racine quand
 * il y en a une, jamais dans le dossier temporaire de Windows (sur C).
 */
export function downloadsDir(): string {
  if (!storageRoot) return tmpdir()
  const dir = join(storageRoot, DOWNLOADS_SUBDIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Efface ce qui reste de l'ancien cache interne de Chromium une fois Jaris redirigé : celui du dossier par
 * défaut de Windows (tout sauf le fichier-repère) et celui d'une ancienne racine après un « Déplacer ». Appelé
 * après le démarrage : ces fichiers ne sont plus utilisés par CETTE exécution (userData a été redirigé avant
 * `ready`). Un fichier encore verrouillé est simplement laissé pour le prochain démarrage.
 */
export async function cleanupStaleChromiumData(): Promise<void> {
  if (!storageRoot) return
  const { readdir, rm, rmdir } = await import('fs/promises')
  try {
    for (const entry of await readdir(DEFAULT_USER_DATA)) {
      if (entry === MARKER_NAME) continue
      await rm(join(DEFAULT_USER_DATA, entry), { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // dossier absent : rien à nettoyer
  }
  const stale = readStaleElectronDir(DEFAULT_USER_DATA)
  if (stale && stale !== join(storageRoot, ELECTRON_SUBDIR)) {
    await rm(stale, { recursive: true, force: true }).catch(() => {})
    if (!existsSync(stale)) {
      writeMarker(DEFAULT_USER_DATA, storageRoot, null)
      // L'ancienne racine d'un « Déplacer » n'a plus rien dedans : on ne laisse pas un dossier vide derrière.
      await rmdir(dirname(stale)).catch(() => {})
    }
  }
  // Installeurs téléchargés lors de la session précédente (Ollama 1,5 Go, Jaris…) : plus rien ne les utilise.
  await rm(join(storageRoot, DOWNLOADS_SUBDIR), { recursive: true, force: true }).catch(() => {})
}
