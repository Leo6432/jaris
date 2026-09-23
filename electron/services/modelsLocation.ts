import { existsSync } from 'fs'
import { cp, lstat, mkdir, readdir, readlink, rename, rm, stat, statfs, unlink } from 'fs/promises'
import { spawn } from 'child_process'
import { dirname, join } from 'path'

/**
 * Les dossiers LOURDS que d'autres logiciels écrivent à leur emplacement Windows habituel (sur C), et comment
 * les faire vivre dans le dossier de Jaris (storageRoot.ts) :
 * - les modèles Ollama (`%USERPROFILE%\.ollama\models`, plusieurs Go par modèle)
 * - le programme Ollama (`%LOCALAPPDATA%\Programs\Ollama`) et ses données (`%LOCALAPPDATA%\Ollama` : journaux
 *   et mises à jour téléchargées, 1,5 Go à chaque fois) — étape 143, « tout, jamais une partie »
 * - l'environnement Python géré par Jaris (`%LOCALAPPDATA%\Jaris\python-runtime`, torch en tête)
 * - le cache HuggingFace (`%USERPROFILE%\.cache\huggingface`) : modèles de transcription et de synthèse vocale
 * - le modèle de la voix, Supertonic (`%USERPROFILE%\.cache\supertonic3`), rangé hors du cache HuggingFace
 *
 * Une JONCTION NTFS remplace chaque emplacement habituel et pointe vers le dossier de Jaris : Ollama, Python
 * et huggingface_hub continuent d'écrire au même chemin qu'avant sans rien savoir du changement, les données
 * vivent physiquement ailleurs. Une jonction ne demande jamais de droits administrateur.
 *
 * Étape 143, Léo : « ça doit tout déplacer, jamais une partie ». Le déplacement est donc TRANSACTIONNEL, en
 * trois temps, au lieu de traiter chaque dossier indépendamment comme avant (un échec isolé laissait un
 * déplacement partiel) :
 *   1. copier : tous les dossiers sont copiés à destination — rien n'est encore touché à l'origine ;
 *   2. basculer : chaque dossier d'origine est renommé en `.jaris-old` et la jonction posée à sa place — un
 *      échec remet tout comme avant, dossier par dossier, dans l'ordre inverse ;
 *   3. finaliser : les `.jaris-old` et les anciens dossiers ne sont effacés que quand TOUT a basculé.
 */

export interface Brick {
  label: string
  link: string
  subdir: string
}

export function bricks(): Brick[] {
  const profile = process.env.USERPROFILE ?? ''
  const local = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? ''
  return [
    { label: 'les modèles Ollama', link: join(profile, '.ollama', 'models'), subdir: 'ollama-models' },
    { label: 'le programme Ollama', link: join(local, 'Programs', 'Ollama'), subdir: 'ollama-app' },
    { label: "les données d'Ollama (journaux, mises à jour)", link: join(local, 'Ollama'), subdir: 'ollama-data' },
    { label: "l'environnement Python (voix)", link: join(local, 'Jaris', 'python-runtime'), subdir: 'python-runtime' },
    { label: 'le cache de reconnaissance et de synthèse vocale', link: join(profile, '.cache', 'huggingface'), subdir: 'huggingface-cache' },
    // Étape 155 (Léo : « C:\Users\happy\.cache\supertonic3\onnx\vector_estimator.onnx, Supertonic c'est pas
    // Jaris ? ») : la voix de Jaris range son modèle HORS du cache HuggingFace, dans ~/.cache/<cache_dir> du
    // modèle par défaut (supertonic/config.py, supertonic==1.3.1 : DEFAULT_MODEL = "supertonic-3" -> "supertonic3").
    // À revoir si requirements.txt change de version de Supertonic (garde-fou : test-models-location.mjs).
    { label: 'la voix de Jaris (Supertonic)', link: join(profile, '.cache', 'supertonic3'), subdir: 'supertonic-cache' }
  ]
}

/**
 * Le VRAI dossier où vivent les données : `link` lui-même s'il s'agit d'un dossier normal, sa cible s'il
 * s'agit d'une jonction, ou `null` s'il n'existe pas encore (rien n'a jamais été installé à cet endroit).
 */
export async function currentRealDir(link: string): Promise<string | null> {
  try {
    const info = await lstat(link)
    return info.isSymbolicLink() ? await readlink(link) : link
  } catch {
    return null
  }
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Retire une jonction SANS toucher à son contenu (un `rm -r` sur une jonction viderait sa cible). */
async function removeLink(path: string): Promise<void> {
  await unlink(path)
}

/** `mklink /J` plutôt que `fs.symlink('junction')`, qui redemande des droits administrateur sur certains Windows. */
export function createJunction(link: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `mklink a échoué (code ${code})`))))
  })
}

/** Taille totale d'un dossier, en octets (les jonctions internes ne sont pas suivies). */
export async function folderSize(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await folderSize(full)
    else total += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}

/** Place libre sur le disque qui contiendra `path` (via son premier parent existant), `null` si illisible. */
export async function freeBytes(path: string): Promise<number | null> {
  let probe = path
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try {
    const info = await statfs(probe)
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

export interface PreparedMove {
  brick: Brick
  /** Où sont les données aujourd'hui (`null` : rien d'installé encore, seule la jonction sera posée). */
  real: string | null
  target: string
  /** Vrai si CE déplacement a créé `target` : lui seul a le droit de l'effacer en cas d'abandon. */
  createdTarget: boolean
}

export interface CommittedMove extends PreparedMove {
  /** L'ancien `link` renommé (dossier normal ou ancienne jonction), `null` s'il n'existait pas. */
  backup: string | null
}

/** Ce qu'il faut déplacer vers `root` : tout dossier qui n'y est pas déjà. */
export async function planMoves(root: string, list: Brick[] = bricks()): Promise<PreparedMove[]> {
  const plans: PreparedMove[] = []
  for (const brick of list) {
    const target = join(root, brick.subdir)
    const real = await currentRealDir(brick.link)
    if (real === target) continue
    plans.push({ brick, real: real && existsSync(real) ? real : null, target, createdTarget: false })
  }
  return plans
}

/** Octets à copier pour ces déplacements. */
export async function bytesToCopy(plans: PreparedMove[]): Promise<number> {
  let total = 0
  for (const plan of plans) if (plan.real) total += await folderSize(plan.real)
  return total
}

/**
 * Étape 1 : copie tout vers la destination, sans rien toucher à l'origine. En cas d'échec, les dossiers créés
 * par CETTE copie sont effacés et l'erreur remonte — tout reste exactement comme avant.
 */
export async function copyAll(plans: PreparedMove[], onProgress: (message: string) => void): Promise<void> {
  try {
    for (const plan of plans) {
      plan.createdTarget = !existsSync(plan.target)
      await mkdir(plan.target, { recursive: true })
      if (plan.real) {
        onProgress(`Copie de ${plan.brick.label}…`)
        await cp(plan.real, plan.target, { recursive: true, force: true })
      }
    }
  } catch (err) {
    await discardCopies(plans)
    throw err
  }
}

export async function discardCopies(plans: PreparedMove[]): Promise<void> {
  for (const plan of plans) {
    if (plan.createdTarget) await rm(plan.target, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Étape 2 : bascule chaque emplacement habituel vers sa copie. Un échec défait les bascules déjà faites, dans
 * l'ordre inverse, puis l'erreur remonte (les copies restent : à l'appelant de les effacer).
 */
export async function switchAll(plans: PreparedMove[]): Promise<CommittedMove[]> {
  const done: CommittedMove[] = []
  try {
    for (const plan of plans) {
      let backup: string | null = null
      if (await exists(plan.brick.link)) {
        backup = `${plan.brick.link}.jaris-old`
        if (await exists(backup)) {
          // Reste d'un essai interrompu : une jonction est retirée seule, un vrai dossier effacé.
          if (await isLink(backup)) await removeLink(backup)
          else await rm(backup, { recursive: true, force: true })
        }
        await rename(plan.brick.link, backup)
      }
      try {
        // `mklink /J` ne crée jamais le dossier PARENT (ex: %USERPROFILE%\.cache sur une machine neuve).
        await mkdir(dirname(plan.brick.link), { recursive: true })
        await createJunction(plan.brick.link, plan.target)
      } catch (err) {
        if (backup) await rename(backup, plan.brick.link)
        throw new Error(`${plan.brick.label} : ${err instanceof Error ? err.message : String(err)}`)
      }
      done.push({ ...plan, backup })
    }
    return done
  } catch (err) {
    await undoSwitches(done)
    throw err
  }
}

export async function undoSwitches(done: CommittedMove[]): Promise<void> {
  for (const move of [...done].reverse()) {
    await removeLink(move.brick.link).catch(() => {})
    if (move.backup) await rename(move.backup, move.brick.link).catch(() => {})
  }
}

/**
 * Étape 3 : tout a basculé, les anciens emplacements peuvent disparaître. Un effacement qui échoue (fichier
 * verrouillé) ne remet rien en cause : les données sont déjà à destination, il ne reste qu'un résidu, renvoyé
 * pour être signalé.
 */
export async function finalizeAll(done: CommittedMove[]): Promise<string[]> {
  const leftovers: string[] = []
  for (const move of done) {
    try {
      if (move.backup && (await isLink(move.backup))) {
        await removeLink(move.backup)
        // L'ancienne jonction pointait vers `real` (un ancien dossier de Jaris) : c'est lui qu'on efface.
        if (move.real && move.real !== move.target) await rm(move.real, { recursive: true, force: true })
      } else if (move.backup) {
        await rm(move.backup, { recursive: true, force: true })
      }
    } catch {
      leftovers.push(move.backup ?? move.brick.link)
    }
  }
  return leftovers
}

/**
 * Les trois temps d'un coup, pour la réconciliation au démarrage (storageRoot.ts a une racine, mais un
 * dossier n'y est pas encore : Ollama installé depuis sur C, machine neuve où rien n'existe…). Tout ou rien.
 */
export async function moveBricksInto(root: string, onProgress: (message: string) => void): Promise<string[]> {
  const plans = await planMoves(root)
  if (!plans.length) return []
  await copyAll(plans, onProgress)
  let done: CommittedMove[]
  try {
    done = await switchAll(plans)
  } catch (err) {
    await discardCopies(plans)
    throw err
  }
  return finalizeAll(done)
}

/** État affiché dans Options : où vit réellement chaque dossier, lu sur le disque. */
export async function listBrickLocations(): Promise<{ label: string; path: string }[]> {
  const out: { label: string; path: string }[] = []
  for (const brick of bricks()) out.push({ label: brick.label, path: (await currentRealDir(brick.link)) ?? brick.link })
  return out
}
