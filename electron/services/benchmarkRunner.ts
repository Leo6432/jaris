import { spawn } from 'child_process'
import { join } from 'path'
import { config } from '../config'

/**
 * Lance scripts/benchmark-models.mjs comme un vrai process Node, en streamant chaque ligne de sa sortie
 * via `onLine` au fur et à mesure — plutôt que d'attendre la fin complète (le benchmark peut prendre
 * 20-40+ minutes avec plusieurs modèles à charger un par un). Réutilise le script tel quel (pas de logique
 * dupliquée) : ce n'est possible que dans un checkout source (le script n'est jamais packagé), mais
 * l'onglet Modèles qui l'appelle est lui-même un outil de dev, pas une fonctionnalité pour un build final.
 */
export function runModelBenchmark(onLine: (line: string) => void): Promise<void> {
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
