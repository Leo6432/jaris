import { existsSync } from 'fs'
import { cp, lstat, mkdir, readlink, rm } from 'fs/promises'
import { spawn } from 'child_process'
import { join } from 'path'

/**
 * Où vivent les téléchargements lourds de Jaris (Options → Modèles → "Choisir un dossier"), et comment les
 * déplacer vers un autre disque. Trois briques, chacune avec son propre emplacement Windows habituel, que
 * ni Ollama ni Python/huggingface_hub ne permettent de choisir depuis Jaris directement :
 * - les modèles Ollama (`%USERPROFILE%\.ollama\models`, plusieurs Go par palier)
 * - l'environnement Python géré par Jaris (`%LOCALAPPDATA%\Jaris\python-runtime`, torch en tête, voir
 *   pythonRuntime.ts)
 * - le cache HuggingFace (`%USERPROFILE%\.cache\huggingface`), où atterrissent le modèle de transcription
 *   ET celui de synthèse vocale (tous deux téléchargés via `huggingface_hub`)
 *
 * Plutôt que d'apprendre à chaque outil un nouvel emplacement (variable d'environnement différente pour
 * chacun, config à modifier séparément, risque de casser un usage en dehors de Jaris), une JONCTION NTFS
 * redirige chaque emplacement habituel vers le dossier choisi par l'utilisateur : totalement transparent
 * pour Ollama/Python/huggingface_hub, qui continuent de lire/écrire au même chemin qu'avant sans rien
 * savoir du changement — les données, elles, vivent physiquement sur le disque choisi. Une jonction ne
 * demande jamais de droits administrateur (contrairement à un lien symbolique Windows, qui en a besoin
 * sauf le mode développeur activé) et fonctionne aussi bien entre deux disques différents que sur le même
 * disque.
 */
export interface ModelsLocationStatus {
  ollamaModelsDir: string
  pythonRuntimeDir: string
  hfCacheDir: string
}

function ollamaModelsLink(): string {
  return join(process.env.USERPROFILE ?? '', '.ollama', 'models')
}

function hfCacheLink(): string {
  return join(process.env.USERPROFILE ?? '', '.cache', 'huggingface')
}

function pythonRuntimeLink(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '', 'Jaris', 'python-runtime')
}

/**
 * Le VRAI dossier où vivent les données actuellement : `link` lui-même s'il s'agit d'un dossier normal, sa
 * cible s'il s'agit d'une jonction déjà posée par un changement d'emplacement précédent, ou `null` s'il
 * n'existe pas encore (rien n'a jamais été téléchargé à cet endroit).
 */
async function currentRealDir(link: string): Promise<string | null> {
  try {
    const stat = await lstat(link)
    return stat.isSymbolicLink() ? await readlink(link) : link
  } catch {
    return null
  }
}

/** État actuel, lu en direct sur le disque (jamais un simple champ de profil qui pourrait dériver de la réalité). */
export async function getModelsLocationStatus(): Promise<ModelsLocationStatus> {
  const [ollama, python, hf] = await Promise.all([
    currentRealDir(ollamaModelsLink()),
    currentRealDir(pythonRuntimeLink()),
    currentRealDir(hfCacheLink())
  ])
  return {
    ollamaModelsDir: ollama ?? ollamaModelsLink(),
    pythonRuntimeDir: python ?? pythonRuntimeLink(),
    hfCacheDir: hf ?? hfCacheLink()
  }
}

/** `mklink /J` plutôt que l'API `fs.symlink('junction', ...)` de Node, pour éviter un bug connu où cette
 * dernière redemande des droits administrateur sur certaines versions de Windows alors que la vraie
 * commande Windows, elle, n'en a jamais eu besoin pour une jonction. */
function createJunction(link: string, target: string): Promise<void> {
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

/**
 * Redirige `link` vers `target`. Copie d'abord entièrement vers `target` AVANT de toucher à `link` : si la
 * copie échoue en cours de route (disque de destination plein, par exemple), l'exception remonte sans que
 * rien n'ait été supprimé — la brique reste exactement comme avant l'essai, jamais dans un état à moitié
 * déplacé.
 */
async function redirectFolder(link: string, target: string, onProgress: (message: string) => void): Promise<void> {
  const real = await currentRealDir(link)
  if (real === target) return // déjà à la bonne destination

  await mkdir(target, { recursive: true })
  if (real && existsSync(real)) {
    onProgress(`Déplacement de ${link}...`)
    await cp(real, target, { recursive: true, force: true })
    // `real` était la cible d'une jonction posée par un déplacement précédent (donc différente de `link`
    // lui-même) : ses données viennent d'être copiées dans `target`, les garder en double sur l'ancien
    // disque ne ferait que gaspiller de la place.
    if (real !== link) await rm(real, { recursive: true, force: true })
  }
  await rm(link, { recursive: true, force: true })
  await createJunction(link, target)
}

/**
 * Déplace les trois briques vers `newDir` (Options → Modèles). Chacune est traitée indépendamment : l'échec
 * de l'une (ex: rien à voir avec Ollama, juste un souci sur le cache HuggingFace) n'empêche pas les autres
 * de réussir — un déplacement partiel reste plus utile qu'un échec total pour un problème isolé.
 */
export async function moveModelsLocation(newDir: string, onProgress: (message: string) => void): Promise<{ success: boolean; message: string }> {
  if (process.platform !== 'win32') {
    return { success: false, message: "Cette fonctionnalité n'est disponible que sur Windows pour l'instant." }
  }

  const steps: { label: string; link: string; subdir: string }[] = [
    { label: 'les modèles Ollama', link: ollamaModelsLink(), subdir: 'ollama-models' },
    { label: "l'environnement Python (voix)", link: pythonRuntimeLink(), subdir: 'python-runtime' },
    { label: 'le cache de reconnaissance vocale et de synthèse vocale', link: hfCacheLink(), subdir: 'huggingface-cache' }
  ]

  const failures: string[] = []
  for (const step of steps) {
    try {
      await redirectFolder(step.link, join(newDir, step.subdir), onProgress)
    } catch (err) {
      failures.push(`${step.label} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (failures.length === 0) {
    return { success: true, message: `Tout a été déplacé vers ${newDir}.` }
  }
  return { success: false, message: `Déplacement partiel vers ${newDir} — échec sur ${failures.join(' ; ')}` }
}
