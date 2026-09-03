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
 * supplémentaire). Le délai de quelques secondes laisse le temps à la confirmation orale d'être dite en
 * entier avant que l'extinction réelle ne commence — ce n'est PAS une fenêtre d'annulation exposée à
 * l'utilisateur (voir toolSecurity.ts : la confirmation a déjà eu lieu avant d'appeler cette fonction),
 * juste le même principe que SHUTDOWN_DELAY_MS dans voicePipeline.ts pour l'arrêt de Jaris lui-même.
 */
const SHUTDOWN_COMMAND_DELAY_S = 10

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
