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
}

export type ModelsVariableDecision =
  /** `current` : la valeur réelle dans Windows (`null` si absente), à laquelle Jaris aligne la sienne. */
  | { action: 'none'; current: string | null }
  | { action: 'fix'; from: string; to: string; fromCount: number; toCount: number }
  /** Variable posée pour toute la machine : la changer demande les droits administrateur. */
  | { action: 'warn-machine'; from: string; to: string; fromCount: number; toCount: number }

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
  if (!effective) return none
  const jaris = await deps.jarisModelsDir()
  if (!jaris) return none
  const target = (await deps.realPath(effective)) ?? effective
  if (samePath(target, jaris)) return none
  const fromCount = await deps.countModels(effective)
  const toCount = await deps.countModels(jaris)
  if (toCount <= fromCount) return none
  return { action: user ? 'fix' : 'warn-machine', from: effective, to: jaris, fromCount, toCount }
}

/** Modèles d'un dossier Ollama : un fichier de manifeste par modèle, sous `manifests/`. */
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
      else if (entry.isFile()) total++
    }
    return total
  }
  return walk(join(dir, 'manifests'), 0)
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
  countModels: countOllamaModels
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
