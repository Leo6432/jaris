import { spawn } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'
import { pythonScriptsDir } from '../paths'
import { resolvePythonBin } from './pythonRuntime'
import type { SttBenchmarkResult, SttBenchmarkRow } from '../../shared/ipc'

/**
 * Étape 156, Léo : « la reconnaissance de la voix prend 4,5 Go sur la carte [...] fais un test de vitesse quand
 * on la met sur la VRAM et sur la RAM, avec la RAM prise, la VRAM et la vitesse ». Lance python/stt_benchmark.py,
 * qui mesure chaque façon de comprendre la voix SUR la machine de l'utilisateur — la seule façon d'avoir de
 * vrais chiffres carte contre RAM, impossibles à mesurer sans sa carte graphique.
 */

/**
 * Délai d'INACTIVITÉ, jamais de durée totale (étape 98) : le premier test télécharge jusqu'à 3 Go de modèles, et
 * Cohere en RAM peut mettre plusieurs minutes à se charger sur une petite machine. Seul un silence complet de
 * 20 minutes (aucune ligne du script) fait abandonner.
 */
const IDLE_TIMEOUT_MS = 20 * 60 * 1000

export type SttBenchmarkEvent =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; gpu: string | null; rows: SttBenchmarkRow[] }
  | null

/** Lit une ligne de sortie du script. Pure, pour être testée sans Python. */
export function parseSttBenchmarkLine(line: string): SttBenchmarkEvent {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  const event = payload as { event?: unknown; message?: unknown; gpu?: unknown; rows?: unknown }
  if (event.event === 'progress' && typeof event.message === 'string') return { kind: 'progress', message: event.message }
  if (event.event === 'result' && Array.isArray(event.rows)) {
    return { kind: 'result', gpu: typeof event.gpu === 'string' ? event.gpu : null, rows: event.rows as SttBenchmarkRow[] }
  }
  return null
}

export function runSttBenchmark(onProgress: (message: string) => void): Promise<SttBenchmarkResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: SttBenchmarkResult): void => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      resolve(result)
    }
    const proc = spawn(resolvePythonBin(), ['-u', join(pythonScriptsDir(), 'stt_benchmark.py')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderrTail = ''
    let idle = setTimeout(() => undefined, 0)
    const armIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        proc.kill()
        finish({ ok: false, message: "Le test ne répond plus depuis 20 minutes : il a été arrêté.", rows: [] })
      }, IDLE_TIMEOUT_MS)
    }
    armIdle()
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      armIdle() // les téléchargements de modèles écrivent leur avancement ici
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
    createInterface({ input: proc.stdout }).on('line', (line) => {
      armIdle()
      const event = parseSttBenchmarkLine(line)
      if (event?.kind === 'progress') onProgress(event.message)
      if (event?.kind === 'result') finish({ ok: true, gpu: event.gpu, rows: event.rows })
    })
    proc.on('error', (err) => finish({ ok: false, message: `Impossible de lancer Python : ${err.message}`, rows: [] }))
    proc.on('close', (code) => {
      const last = stderrTail.trim().split('\n').pop() ?? ''
      finish({
        ok: false,
        message: `Le test s'est arrêté avant la fin (code ${code})${last ? ` : ${last}` : ''}. La voix de Jaris est peut-être encore en cours d'installation.`,
        rows: []
      })
    })
  })
}
