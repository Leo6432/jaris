import { spawn } from 'child_process'
import { getSystemLoad } from './resourceMonitor'
import { getLiveGpuStatus } from './hardwareScan'

/** Donne l'état actuel de la machine en une phrase, pour l'outil get_system_stats. */
export async function getSystemStatsText(): Promise<string> {
  const [load, gpu] = await Promise.all([getSystemLoad(), getLiveGpuStatus()])
  const parts = [`CPU à ${load.cpuPct}%`, `RAM à ${load.ramPct}%`]
  if (gpu.freeVramGb !== null) parts.push(`${gpu.freeVramGb} Go de VRAM libre`)
  if (gpu.tempC !== null) parts.push(`GPU à ${gpu.tempC} degrés`)
  return parts.join(', ') + '.'
}

/**
 * Éteint ou redémarre la machine via la commande Windows native `shutdown.exe` (pas de dépendance
 * supplémentaire). Le délai de quelques secondes laisse le temps à la réponse orale de Jaris d'être dite en
 * entier avant que l'extinction réelle ne commence — ce n'est PAS une fenêtre d'annulation, juste le même
 * principe que SHUTDOWN_DELAY_MS dans voicePipeline.ts pour l'arrêt de Jaris lui-même. Exécuté directement
 * dès que le modèle appelle cet outil, sans confirmation préalable.
 */
const SHUTDOWN_COMMAND_DELAY_S = 10

/**
 * Étape 218 (Léo : « la possibilité d'éteindre le PC à partir du téléphone ») : extinction programmée dans
 * `seconds`, annulable d'ici là avec cancelScheduledShutdown (`shutdown /a`). Lève une erreur au message
 * lisible si Windows refuse : le téléphone l'affiche tel quel.
 */
export function scheduleShutdown(seconds: number): Promise<void> {
  return runShutdown(['/s', '/t', String(seconds)], "Windows n'a pas accepté l'extinction")
}

/** Annule une extinction programmée. Windows répond par une erreur s'il n'y en avait aucune. */
export function cancelScheduledShutdown(): Promise<void> {
  return runShutdown(['/a'], "Windows n'a pas pu annuler l'extinction (elle a peut-être déjà commencé)")
}

function runShutdown(args: string[], failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('shutdown', args, { windowsHide: true })
    proc.on('error', (err) => reject(new Error(`${failure} : ${err.message}`)))
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${failure} (code ${code}).`))))
  })
}

export function shutdownPc(restart: boolean): Promise<string> {
  return new Promise((resolve) => {
    const flag = restart ? '/r' : '/s'
    const proc = spawn('shutdown', [flag, '/t', String(SHUTDOWN_COMMAND_DELAY_S)], { windowsHide: true })
    proc.on('error', (err) => resolve(`Échec de la commande d'extinction : ${err.message}`))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(restart ? 'Redémarrage en cours.' : 'Extinction en cours.')
      } else {
        resolve(`Échec de la commande d'extinction (code ${code}).`)
      }
    })
  })
}
