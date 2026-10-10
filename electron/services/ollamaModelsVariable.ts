import { execFile } from 'child_process'
import { readdir, realpath } from 'fs/promises'
import { homedir } from 'os'
import { join, win32 } from 'path'
import { currentRealDir } from './modelsLocation'

/**
 * Étape 254 — Léo : « tous les modèles ne sont pas installés sauf vidéo et image », même après « Retester » et un
 * redémarrage. Faits relevés sur sa machine, pas supposés : `ollama list` vide ; ses modèles (36,3 Go) bien présents
 * dans D:\jaris\ollama-models, derrière la jonction %USERPROFILE%\.ollama\models posée par Jaris ; mais la variable
 * Windows OLLAMA_MODELS valait D:\ollama-models. Ollama obéit à cette variable AVANT l'emplacement habituel : il
 * regardait un dossier sans ses modèles, et tout ce que Jaris y retéléchargeait finissait là aussi, invisible au
 * reste. La variable n'est jamais écrite par Jaris ; le réglage « emplacement des modèles » de l'appli Ollama l'écrit.
 *
 * Au démarrage, Jaris compare donc le dossier de la variable au sien (la cible de la jonction) et, quand la variable
 * désigne un dossier qui contient MOINS de modèles, la fait pointer vers le sien — puis relance Ollama, qui ne relit
 * ses variables qu'au démarrage. Jamais l'inverse : une variable qui désigne un dossier mieux rempli est un choix
 * de l'utilisateur, on n'y touche pas. Aucun fichier n'est déplacé ni effacé.
 *
 * Étape 289 — Léo, après la mise à jour d'Ollama : « Ollama a répondu 404 : model 'qwen3.8:27b' not found », juste
 * après un téléchargement « réussi » en 2 s, et tous les modèles « pas installés » sauf image et vidéo. Cause lue dans
 * le code source, pas devinée : depuis la 0.40, Ollama vérifie chaque modèle avec `filepath.EvalSymlinks` avant de le
 * lire (manifest.openVerifiedManifestLocked, resolveManifestPath). Or Go 1.23+ ne traverse plus une JONCTION sous
 * Windows : `os.Lstat` la décrit comme « irrégulière » (ni dossier ni lien), et EvalSymlinks s'arrête sur ENOTDIR —
 * qui vaut ERROR_PATH_NOT_FOUND sous Windows, donc « introuvable ». Jaris range justement les modèles derrière la
 * jonction %USERPROFILE%\.ollama\models : Ollama écrit le modèle (Windows suit la jonction), puis ne sait plus le
 * relire. D'où la règle : Ollama doit toujours recevoir le VRAI chemin du dossier, sans jonction (`resolve`).
 */

export interface ModelsVariableDeps {
  readVar: (scope: 'User' | 'Machine') => Promise<string | null>
  writeUserVar: (value: string) => Promise<void>
  /** Le dossier de modèles de Jaris : la cible de %USERPROFILE%\.ollama\models, `null` s'il n'existe pas. */
  jarisModelsDir: () => Promise<string | null>
  /** Chemin réel (jonctions suivies), `null` s'il n'existe pas. */
  realPath: (path: string) => Promise<string | null>
  /** Nombre de modèles installés dans ce dossier (fichiers de manifeste d'Ollama). */
  countModels: (dir: string) => Promise<number>
  /** L'emplacement habituel (%USERPROFILE%\.ollama\models) : celui qu'Ollama prend quand aucune variable n'existe. */
  defaultModelsDir: () => string
}

export type ModelsVariableDecision =
  /** `current` : la valeur réelle dans Windows (`null` si absente), à laquelle Jaris aligne la sienne. */
  | { action: 'none'; current: string | null }
  | { action: 'fix'; from: string; to: string; fromCount: number; toCount: number }
  /** Variable posée pour toute la machine : la changer demande les droits administrateur. */
  | { action: 'warn-machine'; from: string; to: string; fromCount: number; toCount: number }
  /** Le bon dossier, mais atteint à travers une jonction (étape 289) : la variable reçoit son vrai chemin. */
  | { action: 'resolve'; from: string; to: string }

/** Même dossier pour Windows : casse et barre finale ignorées. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export async function decideModelsVariable(deps: ModelsVariableDeps): Promise<ModelsVariableDecision> {
  const user = (await deps.readVar('User'))?.trim() || null
  const machine = (await deps.readVar('Machine'))?.trim() || null
  // Pour un même nom, la variable de l'utilisateur l'emporte sur celle de la machine.
  const effective = user ?? machine
  const none = { action: 'none', current: effective } as const
  const jarisDir = await deps.jarisModelsDir()
  if (!jarisDir) return none
  const jaris = (await deps.realPath(jarisDir)) ?? jarisDir
  // Le dossier qu'Ollama ouvrira : celui de la variable, sinon l'emplacement habituel.
  const used = effective ?? deps.defaultModelsDir()
  const usedReal = await deps.realPath(used)
  if (samePath(usedReal ?? used, jaris)) {
    // Le bon dossier — encore faut-il qu'Ollama l'ouvre par son vrai chemin : il ne relit plus rien à travers une
    // jonction (étape 289).
    return usedReal === null || samePath(used, usedReal) ? none : { action: 'resolve', from: used, to: usedReal }
  }
  if (!effective) return none
  const fromCount = await deps.countModels(effective)
  const toCount = await deps.countModels(jaris)
  // Un dossier qui n'existe plus (déplacé, effacé) est corrigé même sans modèles chez Jaris : Ollama le recréerait,
  // vide, et y rangerait les prochains modèles, invisibles au reste.
  const gone = usedReal === null && fromCount === 0
  if (toCount <= fromCount && !gone) return none
  return { action: user ? 'fix' : 'warn-machine', from: effective, to: jaris, fromCount, toCount }
}

/**
 * Modèles d'un dossier Ollama : un fichier de manifeste par modèle, sous `manifests/` et, depuis Ollama 0.40, sous
 * `manifests-v2/` (un modèle téléchargé depuis n'est QUE là ; ailleurs que sous Windows, c'est un lien vers son blob).
 */
export async function countOllamaModels(dir: string): Promise<number> {
  const walk = async (path: string, depth: number): Promise<number> => {
    if (depth > 6) return 0
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return 0
    }
    let total = 0
    for (const entry of entries) {
      if (entry.isDirectory()) total += await walk(join(path, entry.name), depth + 1)
      else if (entry.isFile() || entry.isSymbolicLink()) total++
    }
    return total
  }
  return (await walk(join(dir, 'manifests'), 0)) + (await walk(join(dir, 'manifests-v2'), 0))
}

/** Lecture/écriture par PowerShell ; la valeur passe par une variable d'environnement, jamais dans le script. */
function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, ...env } }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim())
    )
  })
}

export const windowsModelsVariableDeps: ModelsVariableDeps = {
  readVar: async (scope) => (await powershell(`[Environment]::GetEnvironmentVariable('OLLAMA_MODELS', '${scope}')`)) || null,
  writeUserVar: async (value) => {
    await powershell("[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $env:JARIS_MODELS_DIR, 'User')", { JARIS_MODELS_DIR: value })
  },
  jarisModelsDir: () => currentRealDir(join(homedir(), '.ollama', 'models')),
  realPath: (path) => realpath(path).catch(() => null),
  countModels: countOllamaModels,
  defaultModelsDir: () => join(homedir(), '.ollama', 'models')
}

/**
 * Au démarrage, avant de lancer Ollama. Renvoie vrai si la variable a été corrigée (Ollama a alors été arrêté :
 * l'appelant le relance, avec la nouvelle valeur). Ne lève jamais : un diagnostic impossible ne change rien.
 */
export async function alignOllamaModelsVariable(
  log: (message: string) => void,
  stopOllama: () => Promise<void>,
  deps: ModelsVariableDeps = windowsModelsVariableDeps,
  platform: string = process.platform
): Promise<boolean> {
  if (platform !== 'win32') return false
  let decision: ModelsVariableDecision
  try {
    decision = await decideModelsVariable(deps)
  } catch {
    return false
  }
  if (decision.action === 'none') {
    // Jaris a hérité des variables de Windows à SON lancement : si le réglage a changé depuis (corrigé à la main
    // dans Ollama, par exemple), le Ollama qu'il démarre recevrait encore l'ancienne valeur.
    if (decision.current) process.env.OLLAMA_MODELS = decision.current
    else delete process.env.OLLAMA_MODELS
    return false
  }
  if (decision.action === 'resolve') {
    try {
      await deps.writeUserVar(decision.to)
    } catch (err) {
      // Sans le réglage de Windows, le Ollama que Jaris démarre reçoit quand même le bon chemin (ci-dessous).
      log(`Jaris n'a pas pu enregistrer le dossier des modèles dans Windows : ${err instanceof Error ? err.message : String(err)}`)
    }
    process.env.OLLAMA_MODELS = decision.to
    log(
      `Ollama cherchait tes modèles par un raccourci de dossier (${decision.from}), que ses versions récentes ne savent plus ` +
        `lire : il reçoit maintenant leur vrai emplacement, ${decision.to}, et redémarre. Rien n'a été déplacé ni effacé.`
    )
    await stopOllama()
    return true
  }
  const counts = `${decision.fromCount} modèle(s) là-bas, ${decision.toCount} dans ${decision.to}`
  if (decision.action === 'warn-machine') {
    log(
      `Ollama cherche ses modèles dans ${decision.from} (réglage OLLAMA_MODELS de Windows, pour toute la machine) au lieu de ${decision.to} : ${counts}. ` +
        'Jaris ne peut pas le changer sans droits administrateur : mets le réglage « emplacement des modèles » d’Ollama sur ' +
        `${decision.to}.`
    )
    return false
  }
  try {
    await deps.writeUserVar(decision.to)
  } catch (err) {
    log(`Ollama cherche ses modèles dans ${decision.from} au lieu de ${decision.to} (${counts}), et Jaris n'a pas pu corriger le réglage : ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  // Ollama, et tout ce que Jaris lance ensuite, héritent de la variable de CE processus : elle doit suivre aussi.
  process.env.OLLAMA_MODELS = decision.to
  log(`Ollama cherchait ses modèles dans ${decision.from} (${counts}) : réglage remis sur ${decision.to}, Ollama redémarre. Rien n'a été effacé.`)
  await stopOllama()
  return true
}

/** Ce que la vérification « Ollama voit-il tes modèles ? » consulte (étape 289) ; remplacé dans les tests. */
export interface ModelsViewDeps {
  /** Le dossier où Ollama DOIT trouver les modèles, chemin réel (jonctions suivies) ; `null` s'il n'existe pas. */
  modelsDir: () => Promise<string | null>
  countModels: (dir: string) => Promise<number>
  /** Modèles qu'Ollama annonce (`/api/tags`) ; `null` s'il ne répond pas. */
  serverModelCount: () => Promise<number | null>
  /** Arrête complètement Ollama (l'appli comprise), puis le relance avec les variables de Jaris. */
  restartOllama: () => Promise<void>
}

export const windowsModelsViewDeps: Omit<ModelsViewDeps, 'serverModelCount' | 'restartOllama'> = {
  modelsDir: () => realpath(process.env.OLLAMA_MODELS?.trim() || join(homedir(), '.ollama', 'models')).catch(() => null),
  countModels: countOllamaModels
}

/** Une seule réparation à la fois, et pas plus d'une par minute : jamais une boucle de redémarrages. */
const REPAIR_INTERVAL_MS = 60_000
let lastRepairAt = -Infinity
let repairing: Promise<boolean> | null = null

/**
 * Étape 289 : la vérification du résultat, plutôt que des causes. Ollama peut être lancé par Jaris, mais aussi par
 * son appli (au démarrage de Windows, après sa propre mise à jour), qui lui passe SON réglage d'emplacement — parfois
 * le chemin habituel, donc la jonction. Le symptôme, lui, ne trompe pas : des modèles sur le disque, aucun dans la
 * liste d'Ollama. Jaris arrête alors Ollama et le relance lui-même avec le vrai chemin. Vrai si Ollama voit de
 * nouveau les modèles.
 */
export function repairOllamaModelsView(
  log: (message: string) => void,
  deps: ModelsViewDeps,
  platform: string = process.platform,
  now: number = Date.now()
): Promise<boolean> {
  if (platform !== 'win32') return Promise.resolve(false)
  if (repairing) return repairing
  repairing = (async () => {
    try {
      const dir = await deps.modelsDir()
      if (!dir) return false
      const onDisk = await deps.countModels(dir)
      if (onDisk === 0 || (await deps.serverModelCount()) !== 0) return false
      if (now - lastRepairAt < REPAIR_INTERVAL_MS) return false
      lastRepairAt = now
      log(`Ollama ne voit aucun de tes ${onDisk} modèles, pourtant bien rangés dans ${dir} : Jaris le relance en lui donnant ce dossier…`)
      process.env.OLLAMA_MODELS = dir
      await deps.restartOllama()
      const seen = await deps.serverModelCount()
      if (seen) {
        log(`Ollama voit de nouveau tes modèles (${seen}).`)
        return true
      }
      log(`Ollama ne voit toujours pas tes modèles, rangés dans ${dir}. Redémarre l'ordinateur, puis relance Jaris.`)
      return false
    } catch {
      return false
    } finally {
      repairing = null
    }
  })()
  return repairing
}
