import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const CPU_OVERLOAD_PCT = 90
const RAM_OVERLOAD_PCT = 90
const GPU_OVERLOAD_PCT = 95

/** Le CPU n'a pas d'usage "instantané" : il faut comparer deux relevés des compteurs de chaque coeur. */
const CPU_SAMPLE_INTERVAL_MS = 200

function sumCpuTimes(cpu: os.CpuInfo): { idle: number; total: number } {
  const t = cpu.times
  return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
}

async function getCpuUsagePercent(): Promise<number> {
  const before = os.cpus().map(sumCpuTimes)
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_INTERVAL_MS))
  const after = os.cpus().map(sumCpuTimes)

  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < before.length; i++) {
    idleDelta += after[i].idle - before[i].idle
    totalDelta += after[i].total - before[i].total
  }
  if (totalDelta <= 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 100)
}

function getRamUsagePercent(): number {
  return Math.round((1 - os.freemem() / os.totalmem()) * 100)
}

async function getGpuUsagePercent(): Promise<number | null> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits')
    const value = parseInt(stdout.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export interface SystemLoad {
  cpuPct: number
  ramPct: number
  gpuPct: number | null
}

export async function getSystemLoad(): Promise<SystemLoad> {
  const [cpuPct, gpuPct] = await Promise.all([getCpuUsagePercent(), getGpuUsagePercent()])
  return { cpuPct, ramPct: getRamUsagePercent(), gpuPct }
}

/**
 * Un seul avertissement puis silence pendant ce délai, même si la machine reste chargée : sinon Jaris
 * répéterait le même avertissement à chaque question tant que la charge ne redescend pas, ce qui serait
 * pénible à l'usage sans apporter d'info nouvelle.
 */
const WARNING_COOLDOWN_MS = 2 * 60 * 1000
let lastWarnedAt = 0

/**
 * Vérifie l'état de la machine (CPU, RAM, GPU) juste avant que Jaris agisse, et renvoie une phrase à dire
 * à voix haute avant la réponse si elle est surchargée — pour prévenir plutôt que d'insister en silence
 * sur une réponse qui va être lente. `null` si tout va bien ou si on est encore dans le délai après un
 * précédent avertissement.
 */
export async function checkOverloadWarning(): Promise<string | null> {
  const load = await getSystemLoad()
  const reasons: string[] = []
  if (load.cpuPct >= CPU_OVERLOAD_PCT) reasons.push(`le CPU à ${load.cpuPct}%`)
  if (load.ramPct >= RAM_OVERLOAD_PCT) reasons.push(`la RAM à ${load.ramPct}%`)
  if (load.gpuPct !== null && load.gpuPct >= GPU_OVERLOAD_PCT) reasons.push(`le GPU à ${load.gpuPct}%`)

  if (!reasons.length) return null
  if (Date.now() - lastWarnedAt < WARNING_COOLDOWN_MS) return null
  lastWarnedAt = Date.now()

  const joined = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(', ')} et ${reasons[reasons.length - 1]}`
  return `Attention, ta machine est assez chargée en ce moment, avec ${joined}, ça risque d'être plus lent que d'habitude.`
}
