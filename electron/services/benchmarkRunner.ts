import { spawn } from 'child_process'
import { join } from 'path'
import { config } from '../config'
import { deleteModel } from './ollama'
import { parseLocalBenchmark } from './hardwareScan'
import { getProfile } from './profileStore'

/**
 * Lance scripts/benchmark-models.mjs comme un vrai process Node, en streamant chaque ligne de sa sortie
 * via `onLine` au fur et à mesure — plutôt que d'attendre la fin complète (le benchmark peut prendre
 * 20-40+ minutes avec plusieurs modèles à charger un par un). Réutilise le script tel quel (pas de logique
 * dupliquée) : ce n'est possible que dans un checkout source (le script n'est jamais packagé), mais
 * l'onglet Modèles qui l'appelle est lui-même un outil de dev, pas une fonctionnalité pour un build final.
 */
function spawnBenchmarkScript(onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'benchmark-models.mjs')
    const proc = spawn('node', [scriptPath], {
      windowsHide: true,
      env: { ...process.env, OLLAMA_HOST: config.ollama.host }
    })

    let buffer = ''
    const handleChunk = (chunk: Buffer): void => {
      buffer += chunk.toString()
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
      }
    }

    proc.stdout.on('data', handleChunk)
    proc.stderr.on('data', handleChunk)
    proc.on('error', (err) => reject(new Error(`Impossible de lancer le benchmark : ${err.message}`)))
    proc.on('close', (code) => {
      if (buffer.trim()) onLine(buffer)
      if (code === 0) resolve()
      else reject(new Error(`Le benchmark s'est arrêté avec le code ${code ?? '?'}`))
    })
  })
}

/**
 * Supprime (via l'API Ollama) tout modèle testé par le dernier run — d'après
 * scripts/benchmark-results.md, voir parseLocalBenchmark — qui n'est PAS actuellement retenu par le
 * profil (rapide/médium/puissant/vision) : le benchmark installe tout ce qui manque pour tester à fond,
 * mais rien n'a de raison de rester sur le disque une fois le gagnant de chaque palier connu. Ne touche
 * jamais à un modèle absent de ce fichier (jamais testé par ce script) : uniquement le ménage de ce que le
 * benchmark lui-même a pu faire installer.
 */
async function cleanupUnselectedModels(onLine: (line: string) => void): Promise<void> {
  const tested = [...parseLocalBenchmark().keys()]
  if (!tested.length) return

  const profile = await getProfile()
  const keep = new Set<string>()
  if (profile?.models?.flash) keep.add(profile.models.flash)
  if (profile?.models?.medium) keep.add(profile.models.medium)
  if (profile?.models?.large) keep.add(profile.models.large)
  if (profile?.visionModel) keep.add(profile.visionModel)

  const toRemove = tested.filter((model) => !keep.has(model))
  if (!toRemove.length) {
    onLine('Rien à supprimer : tous les modèles testés sont retenus par le profil actuel.')
    return
  }

  onLine(`Suppression de ${toRemove.length} modèle(s) testé(s) non retenu(s) par le profil actuel...`)
  for (const model of toRemove) {
    try {
      await deleteModel(model)
      onLine(`  Supprimé : ${model}`)
    } catch (err) {
      onLine(`  Échec de la suppression de ${model} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Lance le benchmark complet (installation des modèles manquants, tests, résultats) puis supprime tout
 * ce qui a été testé mais n'est pas retenu par le profil actuel (voir cleanupUnselectedModels). */
export async function runModelBenchmark(onLine: (line: string) => void): Promise<void> {
  await spawnBenchmarkScript(onLine)
  onLine('')
  await cleanupUnselectedModels(onLine)
}
