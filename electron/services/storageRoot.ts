import { app } from 'electron'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, extname, join, resolve, win32 } from 'path'
import {
  CODE_CONVERSATIONS_ASIDE_DIR,
  CODE_CONVERSATIONS_FILE,
  codeConversationsAsideName,
  combineCodeConversations,
  sanitizeCodeConversations,
  type CodeConversationsData
} from '../../shared/codeConversations'

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
 * Identité Tailscale de l'accès téléphone (main.ts). JAMAIS nommé « tailscale » : sous Windows, Tailscale réécrit
 * alors les droits du dossier, ce qui est refusé sans administrateur (v0.22.0 ; voir stateDirFor, tunnel/main.go).
 */
export const PHONE_TUNNEL_DIR = 'phone-tunnel'

/**
 * Les trois fichiers du bouton « Tester les modèles sans score » (benchmarkRunner.ts et scripts/benchmark-models.mjs) :
 * résultats, traces brutes, registre des modèles téléchargés par le test.
 */
const MODEL_TEST_ENTRIES = [
  'benchmark-nouveaux-modeles.md',
  'benchmark-nouveaux-modeles.traces.jsonl',
  'benchmark-nouveaux-modeles.md.telecharges.json'
]

/**
 * Ce que Jaris écrit lui-même dans son dossier de données, et RIEN d'autre : jamais les fichiers internes de
 * Chromium qui partageaient autrefois le même dossier. `generated-videos` reste après le retrait du Montage
 * (étape 200) : ce sont les vidéos de Léo, elles suivent ses données comme avant. `language.json` (étape 293) aussi :
 * sans lui, un « Déplacer » faisait repartir Jaris dans la langue de Windows au lieu de celle choisie.
 * `github-connection.json` (étape 297) : la trace de la connexion GitHub, sans le jeton.
 *
 * Tout ce qui n'est PAS dans cette liste est perdu par un « Déplacer » : l'ancien dossier de données est effacé en
 * entier, et l'ancien dossier de Chromium aussi au démarrage suivant (cleanupStaleChromiumData). D'où les ajouts :
 * - `github-token.bin` et `phone-tunnel` : le jeton GitHub chiffré et l'identité Tailscale de l'accès téléphone,
 *   rangés autrefois dans le dossier de Chromium (voir LEGACY_ELECTRON_ENTRIES) ;
 * - `phone-devices.json` : les téléphones appairés ;
 * - `code-conversations.json` : les conversations du mode Code ;
 * - les trois fichiers du bouton « Tester les modèles sans score » (benchmarkRunner.ts et
 *   scripts/benchmark-models.mjs : résultats, traces brutes, registre des modèles téléchargés par le test) ;
 * - `duel-pilotes` : le rapport du duel des pilotes d'écran (étape 249, fonctionnalité retirée, rapport gardé).
 * Restent volontairement dehors, parce que Jaris les reconstruit seul : `searxng-docker` (recopié depuis le
 * programme à chaque démarrage, conteneur recréé s'il pointe ailleurs : searxngHome.ts) et les réglages de confort
 * de la fenêtre (largeur de l'aperçu, durée et qualité de vidéo, dans le stockage local de Chromium : valeurs par
 * défaut sinon).
 */
export const OWNED_ENTRIES = [
  'conversations',
  'conversation-history.json',
  'profile.json',
  'language.json',
  'memory',
  'generated-apps',
  'generated-images',
  'generated-videos',
  'reminders.json',
  'journal-demandes.txt',
  'github-connection.json',
  'github-token.bin',
  'phone-devices.json',
  CODE_CONVERSATIONS_FILE,
  // Copies de secours d'un code-conversations.json illisible (codeConversationsStore.ts) : jamais perdues non plus.
  CODE_CONVERSATIONS_ASIDE_DIR,
  ...MODEL_TEST_ENTRIES,
  'duel-pilotes',
  PHONE_TUNNEL_DIR
]

/**
 * Ce que les versions d'avant rangeaient dans le dossier de CHROMIUM (`app.getPath('userData')`), qui change de place
 * à chaque « Déplacer » et dont l'ancien exemplaire est effacé au démarrage suivant : le jeton GitHub chiffré
 * (github.ts) et l'identité Tailscale de l'accès téléphone (main.ts). Ils vivent désormais avec les autres données ;
 * une installation qui les a encore à l'ancien endroit les y retrouve au démarrage (adoptLegacyEntriesSync).
 */
export const LEGACY_ELECTRON_ENTRIES = ['github-token.bin', PHONE_TUNNEL_DIR]

/**
 * Entrées jamais écrasées quand le démarrage rapatrie le dossier par défaut vers une racine qui les a déjà
 * (moveOwnedEntriesSync) :
 * - le jeton GitHub ne se relit qu'avec la clé de chiffrement du dossier de Chromium de SA racine
 *   (CHROMIUM_KEY_FILE), et sa trace (`github-connection.json`) décrit CE jeton ;
 * - l'identité Tailscale du téléphone et la liste des téléphones appairés à CETTE identité vont ensemble ;
 * - les fichiers du bouton de test des modèles (MODEL_TEST_ENTRIES) : des jours de traces de test, que les quelques
 *   lignes d'une session lancée sur C ne doivent pas remplacer.
 * Cas réel : racine sur D, Jaris démarré disque débranché (il tourne alors sur C), reconnexion à GitHub sur C, disque
 * rebranché. Écrasé, le bon jeton de D était remplacé par celui de C, chiffré avec une autre clé : illisible, Léo
 * était déconnecté de GitHub (et l'identité du téléphone remplacée par une neuve). La copie restée sur C est effacée
 * avec le reste du dossier par défaut (cleanupStaleChromiumData).
 *
 * Les conversations du mode Code et leurs copies de secours ne sont pas dans cette liste : elles sont RÉUNIES avec
 * celles déjà à destination (mergeCodeConversationsFileSync, copyKeepingBothSync), jamais l'un par-dessus l'autre.
 */
export const KEPT_AT_DESTINATION_ENTRIES = [...LEGACY_ELECTRON_ENTRIES, 'github-connection.json', 'phone-devices.json', ...MODEL_TEST_ENTRIES]

/**
 * Fichier de Chromium qui garde la clé de chiffrement de Windows (`os_crypt.encrypted_key`, protégée par DPAPI) :
 * c'est avec elle que `safeStorage` chiffre le jeton GitHub. Un dossier de Chromium neuf en crée une NOUVELLE, et
 * le jeton copié devient illisible : la clé doit suivre chaque déplacement du dossier de Chromium.
 */
export const CHROMIUM_KEY_FILE = 'Local State'

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

/** Suffixe du nom temporaire d'une copie en cours (copyWholeSync). */
const PARTIAL_COPY_SUFFIX = '.jaris-copie'

/**
 * Délais entre deux essais quand Windows refuse un instant un renommage (antivirus ou indexeur qui ouvre le fichier
 * qu'on vient d'écrire) : au plus ~350 ms d'attente, et seulement quand ça échoue. Mêmes valeurs que le store des
 * conversations du mode Code (codeConversationsStore.ts), pour la même raison.
 */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200]
/** Les refus passagers d'un renommage sous Windows. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Attente SYNCHRONE : ce module tourne au chargement, avant que l'application soit prête, sans boucle d'évènements. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * `renameSync` réessayé sur un refus passager. Sans ça, un seul refus d'un antivirus pendant la réunion des
 * conversations du mode Code faisait abandonner toute la racine D pour la session (bootstrap) : Jaris démarrait sur
 * C, comme si le disque était débranché. Toute autre erreur, ou un refus qui dure, remonte telle quelle.
 */
function renameWithRetriesSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has((err as NodeJS.ErrnoException).code ?? '') || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Copie `source` vers `dest` (absent) sans JAMAIS laisser `dest` à moitié écrit : la copie se fait sous un nom
 * temporaire voisin, puis prend son vrai nom d'un seul coup (renommage dans le même dossier). Sur un échec en route
 * (fichier verrouillé, disque plein, coupure de courant), `dest` n'existe toujours pas : la tentative suivante repart
 * de l'original au lieu de prendre une copie incomplète pour la bonne et de ne plus jamais y toucher.
 */
function copyWholeSync(source: string, dest: string): void {
  const partial = `${dest}${PARTIAL_COPY_SUFFIX}`
  rmSync(partial, { recursive: true, force: true })
  try {
    cpSync(source, partial, { recursive: true })
    renameWithRetriesSync(partial, dest)
  } catch (err) {
    try {
      rmSync(partial, { recursive: true, force: true })
    } catch {
      // effacée au prochain essai (début de cette fonction)
    }
    throw err
  }
}

/**
 * Mêmes octets. Une lecture refusée (fichier verrouillé un instant) fait lever : le démarrage suivant réessaie, plutôt
 * que de prendre deux fichiers identiques pour différents et d'en garder une copie de trop.
 */
const sameContentSync = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b))

/**
 * Range `file` dans le dossier `dir` sous le nom `name` sans jamais rien y écraser : un nom pris par un autre contenu
 * passe à `base-2.ext`, `base-3.ext`… ; si l'un de ces fichiers a déjà exactement ce contenu (démarrage interrompu puis
 * repris), rien n'est ajouté. `true` quand une copie a été écrite.
 */
function copyWithoutOverwriteSync(file: string, dir: string, name: string): boolean {
  const extension = extname(name)
  const base = name.slice(0, name.length - extension.length)
  for (let index = 1; ; index++) {
    const candidate = join(dir, index === 1 ? name : `${base}-${index}${extension}`)
    if (!existsSync(candidate)) {
      copyWholeSync(file, candidate)
      return true
    }
    if (sameContentSync(file, candidate)) return false
  }
}

/**
 * Copie le contenu du dossier `source` dans `dest` sans jamais rien y écraser : un fichier identique déjà présent est
 * sauté, un fichier différent du même nom est gardé à côté sous un nom libre (`…-2.json`). Pour les copies de secours
 * datées (CODE_CONVERSATIONS_ASIDE_DIR) : la seule trace d'un fichier abîmé ne doit jamais en remplacer une autre.
 * Chaque fichier arrive d'un seul tenant (copyWholeSync) : un démarrage interrompu reprend sans rien doubler.
 */
function copyKeepingBothSync(source: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    if (entry.isDirectory()) copyKeepingBothSync(from, join(dest, entry.name))
    else copyWithoutOverwriteSync(from, dest, entry.name)
  }
}

/**
 * Garde une copie de `file` parmi les copies de secours datées (CODE_CONVERSATIONS_ASIDE_DIR) du dossier `dataDir` —
 * sauf si une copie identique y est déjà (démarrage interrompu puis repris : rien n'est doublé).
 */
function keepAsideSync(file: string, dataDir: string): void {
  const dir = join(dataDir, CODE_CONVERSATIONS_ASIDE_DIR)
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && sameContentSync(file, join(dir, entry.name))) return
  }
  copyWithoutOverwriteSync(file, dir, codeConversationsAsideName(Date.now()))
}

/**
 * Le contenu d'un `code-conversations.json`, ou `null` s'il est abîmé (pas du JSON, ou pas une liste de conversations).
 * Un fichier qui ne peut pas être LU (verrouillé par un antivirus…) fait lever : rien n'est touché, et le démarrage
 * suivant réessaie — un fichier n'est jamais mis de côté pour un simple refus passager.
 */
function readCodeConversationsSync(file: string): CodeConversationsData | null {
  const raw = readFileSync(file, 'utf-8')
  try {
    return sanitizeCodeConversations(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Écrit `file` d'un seul tenant : contenu forcé sur le disque sous un nom voisin, puis remplacement d'un seul geste. */
function writeWholeFileSync(file: string, content: string): void {
  const partial = `${file}${PARTIAL_COPY_SUFFIX}`
  const fd = openSync(partial, 'w')
  try {
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameWithRetriesSync(partial, file)
  } catch (err) {
    // `file` est intact (le renommage n'a pas eu lieu) : on ne laisse pas la copie temporaire traîner à côté.
    try {
      rmSync(partial, { force: true })
    } catch {
      // réécrite au prochain essai (openSync en écriture)
    }
    throw err
  }
}

/**
 * `code-conversations.json` déjà présent à destination : les deux sont RÉUNIS (combineCodeConversations), jamais l'un
 * par-dessus l'autre. Cas réel : racine sur D, Jaris démarré disque débranché (il tourne alors sur C), une session du
 * mode Code y crée son propre fichier, disque rebranché : recopié avec `force`, le fichier de C remplaçait celui de D,
 * et tout l'historique du mode Code était perdu. Celui de destination passe d'abord : il est d'avant la session sur C.
 *
 * Un fichier abîmé n'est jamais écrasé ni jeté : il rejoint les copies de secours datées (CODE_CONVERSATIONS_ASIDE_DIR),
 * là où le store l'aurait mis lui-même au premier accès, et l'autre fichier sert. Chaque étape peut être rejouée par
 * un démarrage interrompu en route sans rien perdre ni doubler.
 */
function mergeCodeConversationsFileSync(source: string, dest: string): void {
  const older = readCodeConversationsSync(dest)
  const newer = readCodeConversationsSync(source)
  if (older && newer) {
    writeWholeFileSync(dest, JSON.stringify({ version: 1, ...combineCodeConversations(older, newer) }))
  } else if (newer) {
    // Celui de destination est abîmé : gardé de côté, puis remplacé (d'un seul tenant) par celui de C.
    keepAsideSync(dest, dirname(dest))
    rmSync(dest, { force: true })
    copyWholeSync(source, dest)
  } else {
    // Celui de C est abîmé (ou les deux) : gardé de côté, celui de destination reste tel quel.
    keepAsideSync(source, dirname(dest))
  }
}

/**
 * Copie les données de Jaris de `from` vers `to` puis efface les originaux — dans CET ordre, et chaque
 * original n'est effacé qu'une fois TOUTES les copies réussies : une erreur en route laisse les originaux
 * intacts (l'exception remonte). Une source absente est simplement sautée (installation neuve).
 *
 * Une entrée de KEPT_AT_DESTINATION_ENTRIES déjà présente dans `to` n'est jamais écrasée : l'original est laissé
 * (effacé ensuite avec le reste du dossier par défaut), et elle n'est copiée, d'un seul tenant, que si `to` ne l'a pas.
 * Les conversations du mode Code et leurs copies de secours déjà présentes dans `to` sont réunies avec celles de
 * `from`, sans rien perdre ni d'un côté ni de l'autre.
 */
export function moveOwnedEntriesSync(from: string, to: string): void {
  if (from === to) return
  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  for (const entry of OWNED_ENTRIES) {
    const source = join(from, entry)
    if (!existsSync(source)) continue
    const dest = join(to, entry)
    if (KEPT_AT_DESTINATION_ENTRIES.includes(entry)) {
      if (existsSync(dest)) continue
      copyWholeSync(source, dest)
    } else if (entry === CODE_CONVERSATIONS_FILE && existsSync(dest)) {
      mergeCodeConversationsFileSync(source, dest)
    } else if (entry === CODE_CONVERSATIONS_ASIDE_DIR && existsSync(dest)) {
      copyKeepingBothSync(source, dest)
    } else {
      cpSync(source, dest, { recursive: true, force: true })
    }
    copied.push(source)
  }
  for (const source of copied) rmSync(source, { recursive: true, force: true })
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Range dans `dataDir` ce qui était encore dans le dossier de Chromium `electronDir` (LEGACY_ELECTRON_ENTRIES).
 * Jamais par-dessus une donnée déjà rangée. Une entrée qui ne peut pas être déplacée reste où elle est (rien n'efface
 * le dossier de Chromium en service) et sera retentée au prochain démarrage : un échec ici ne doit jamais faire
 * abandonner la racine de stockage.
 */
export function adoptLegacyEntriesSync(electronDir: string, dataDir: string): void {
  if (sameDir(electronDir, dataDir)) return
  for (const entry of LEGACY_ELECTRON_ENTRIES) {
    const source = join(electronDir, entry)
    const dest = join(dataDir, entry)
    if (!existsSync(source) || existsSync(dest)) continue
    try {
      mkdirSync(dataDir, { recursive: true })
      try {
        renameSync(source, dest)
      } catch {
        // Renommage refusé : copie d'abord, d'un seul tenant (une copie interrompue ne laisse rien à `dest`), et
        // original effacé seulement ensuite.
        copyWholeSync(source, dest)
        try {
          rmSync(source, { recursive: true, force: true })
        } catch (err) {
          // La copie est complète et c'est elle qui sert désormais : un reste de l'original n'est plus jamais lu.
          console.error(`[jaris] ${entry} copié avec les données, ancien exemplaire pas entièrement effacé :`, err)
        }
      }
    } catch (err) {
      console.error(`[jaris] ${entry} n'a pas pu rejoindre les données, gardé à son ancien emplacement :`, err)
    }
  }
}

/**
 * Copie la clé de chiffrement de Chromium (CHROMIUM_KEY_FILE) du premier dossier de `sources` qui en a une vers
 * `electronDir`. Sans `overwrite`, une clé déjà présente est gardée (dossier de Chromium déjà en service).
 */
export function carryChromiumKeySync(sources: (string | null)[], electronDir: string, overwrite: boolean): boolean {
  const target = join(electronDir, CHROMIUM_KEY_FILE)
  if (!overwrite && existsSync(target)) return false
  for (const dir of sources) {
    if (!dir || sameDir(dir, electronDir)) continue
    const source = join(dir, CHROMIUM_KEY_FILE)
    if (!existsSync(source)) continue
    mkdirSync(electronDir, { recursive: true })
    copyFileSync(source, target)
    return true
  }
  return false
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
    const electronDir = join(root, ELECTRON_SUBDIR)
    const staleElectronDir = readStaleElectronDir(DEFAULT_USER_DATA)
    // D'abord ce que les versions d'avant rangeaient dans le dossier de Chromium de CETTE racine : chiffré avec SA
    // clé, c'est lui le bon jeton. Rapatrié après le dossier par défaut, il aurait été sauté au profit d'un jeton
    // laissé sur C par une session disque débranché, illisible avec cette clé.
    adoptLegacyEntriesSync(electronDir, join(root, DATA_SUBDIR))
    // Données encore dans le dossier par défaut (première installation sur D d'un Jaris déjà utilisé, ou
    // ancien repère) : rapatriées AVANT que le moindre store ne calcule son chemin.
    moveOwnedEntriesSync(DEFAULT_USER_DATA, join(root, DATA_SUBDIR))
    // Le dossier de Chromium de cette racine n'a pas encore de clé (installation sur D d'un Jaris déjà utilisé) :
    // celle de l'ancien dossier, AVANT que Chromium n'en crée une nouvelle — sinon le jeton GitHub rapatrié ci-dessus
    // ne se relirait plus. Les deux anciens dossiers sont encore là : ils ne sont effacés qu'après `ready`.
    try {
      carryChromiumKeySync([staleElectronDir, DEFAULT_USER_DATA], electronDir, false)
    } catch (err) {
      console.error('[jaris] Clé de chiffrement de Chromium non reprise :', err)
    }
    writeMarker(DEFAULT_USER_DATA, root, staleElectronDir)
    app.setPath('userData', electronDir)
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
