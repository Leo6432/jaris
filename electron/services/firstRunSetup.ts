import { installOllamaSilently, isOllamaInstalled } from './dependencyServices'
import { installPythonRuntime, isPythonRuntimeReady } from './pythonRuntime'
import type { RuntimeSetupProgress, RuntimeSetupStatus } from '../../shared/ipc'

/**
 * Met la machine en état de faire tourner Jaris, au premier lancement, sans que l'utilisateur ait la
 * moindre commande à taper (étape 16 du roadmap).
 *
 * Ce que l'installeur `.exe` dépose sur le disque, c'est seulement l'application elle-même : Python et ses
 * dépendances (plusieurs Go à eux seuls, dont PyTorch) et Ollama sont bien trop lourds pour tenir dedans,
 * et surtout ils dépendent de la machine (carte graphique NVIDIA ou non, voir pythonRuntime.ts). Ils sont
 * donc installés ici, au premier démarrage, avec une vraie barre de progression — ce que le roadmap
 * autorise explicitement : "soit embarqués tout faits dans l'installeur, soit l'installeur les installe
 * lui-même, jamais une commande que l'utilisateur doit lancer".
 *
 * Le téléchargement des modèles de conversation, lui, arrive juste après dans l'écran de configuration
 * (runQuickSetup, benchmarkRunner.ts) : il dépend de la VRAM détectée, donc il ne peut pas être fait avant.
 */

/** Ce qui manque encore sur cette machine, pour que l'interface sache s'il faut afficher l'installation. */
export async function getRuntimeSetupStatus(): Promise<RuntimeSetupStatus> {
  const [pythonReady, ollamaReady] = await Promise.all([isPythonRuntimeReady(), isOllamaInstalled()])
  return { pythonReady, ollamaReady, ready: pythonReady && ollamaReady }
}

/**
 * Installe tout ce qui manque. Ollama d'abord, Python ensuite : Ollama est de loin le plus rapide des
 * deux, donc en cas d'échec l'utilisateur le sait tout de suite au lieu d'attendre plusieurs minutes de
 * téléchargement de PyTorch avant de tomber sur l'erreur.
 *
 * Un échec d'Ollama n'interrompt pas Python : les deux sont indépendants, et un Jaris avec seulement l'un
 * des deux est plus utile qu'un Jaris qui refuse de s'installer. Le détail de ce qui a marché ou non
 * revient dans le statut final, jamais un simple "erreur".
 */
export async function runFirstRunSetup(onProgress: (progress: RuntimeSetupProgress) => void): Promise<RuntimeSetupStatus> {
  const status = await getRuntimeSetupStatus()

  if (!status.ollamaReady) {
    onProgress({ step: 'ollama', message: "Installation d'Ollama (le moteur de conversation)…" })
    const installed = await installOllamaSilently((message) => onProgress({ step: 'ollama', message }))
    if (!installed) {
      onProgress({
        step: 'ollama',
        message: "Ollama n'a pas pu s'installer tout seul. Jaris réessaiera, ou tu peux l'installer depuis ollama.com/download.",
        failed: true
      })
    }
  }

  if (!status.pythonReady) {
    onProgress({ step: 'python', message: 'Installation de Python (pour la voix)…', percent: 0 })
    try {
      await installPythonRuntime((message, percent) => onProgress({ step: 'python', message, percent }))
    } catch (err) {
      onProgress({
        step: 'python',
        message: `L'installation de Python a échoué : ${err instanceof Error ? err.message : String(err)}`,
        failed: true
      })
    }
  }

  // Relit l'état réel du disque plutôt que de supposer que tout s'est bien passé : c'est ce statut qui
  // décide si l'interface passe à la suite ou propose de réessayer.
  return getRuntimeSetupStatus()
}
