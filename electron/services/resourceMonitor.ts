import * as os from 'os'

const CPU_OVERLOAD_PCT = 90
const RAM_OVERLOAD_PCT = 90

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

export interface SystemLoad {
  cpuPct: number
  ramPct: number
}

export async function getSystemLoad(): Promise<SystemLoad> {
  return { cpuPct: await getCpuUsagePercent(), ramPct: getRamUsagePercent() }
}

/**
 * Un seul avertissement puis silence pendant ce délai, même si la machine reste chargée : sinon Jaris
 * répéterait le même avertissement à chaque question tant que la charge ne redescend pas, ce qui serait
 * pénible à l'usage sans apporter d'info nouvelle. Ne s'applique qu'au CPU/RAM (juste un ralentissement
 * possible, pas un risque matériel) : voir checkGpuTempSafety plus bas pour la température GPU, qui elle
 * est vérifiée à chaque question sans exception.
 */
const WARNING_COOLDOWN_MS = 2 * 60 * 1000
let lastWarnedAt = 0

/**
 * Vérifie la charge CPU/RAM juste avant que Jaris agisse, et renvoie une phrase à dire à voix haute avant
 * la réponse si la machine est chargée — pour prévenir plutôt que d'insister en silence sur une réponse
 * qui va être lente. `null` si tout va bien ou si on est encore dans le délai après un précédent
 * avertissement. Le GPU n'est volontairement plus jugé sur son % d'utilisation ici (tourner à 90-100% est
 * normal et sans danger pour un GPU, ce n'est pas un signe de surcharge) : sa sécurité passe uniquement par
 * la température réelle, voir checkGpuTempSafety.
 */
export async function checkOverloadWarning(): Promise<string | null> {
  const load = await getSystemLoad()
  const reasons: string[] = []
  if (load.cpuPct >= CPU_OVERLOAD_PCT) reasons.push(`le CPU à ${load.cpuPct}%`)
  if (load.ramPct >= RAM_OVERLOAD_PCT) reasons.push(`la RAM à ${load.ramPct}%`)

  if (!reasons.length) return null
  if (Date.now() - lastWarnedAt < WARNING_COOLDOWN_MS) return null
  lastWarnedAt = Date.now()

  const joined = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(', ')} et ${reasons[reasons.length - 1]}`
  return `Attention, ta machine est assez chargée en ce moment, avec ${joined}, ça risque d'être plus lent que d'habitude.`
}

/**
 * Contrairement au CPU/RAM, la température du GPU est un vrai risque matériel (pas juste une histoire de
 * lenteur) : trois paliers croissants, vérifiés à CHAQUE question, sans le délai anti-spam de
 * checkOverloadWarning ci-dessus — une carte qui reste chaude doit continuer à alerter/agir à chaque fois,
 * pas seulement une fois toutes les 2 minutes.
 */
export const GPU_WARN_TEMP_C = 75
export const GPU_ABORT_TEMP_C = 85
export const GPU_SHUTDOWN_TEMP_C = 90

export type GpuTempAction = 'none' | 'warn' | 'abort' | 'shutdown'

export interface GpuTempStatus {
  action: GpuTempAction
  message: string | null
}

/**
 * `null` (pas de GPU NVIDIA détecté, ou `nvidia-smi` indisponible) : on ne peut rien vérifier, donc pas
 * d'action plutôt qu'un faux positif.
 * - >= GPU_WARN_TEMP_C : Jaris prévient à voix haute mais répond quand même normalement à la question.
 * - >= GPU_ABORT_TEMP_C : la requête est annulée avant même d'appeler le LLM (inutile de charger encore
 *   plus un GPU déjà chaud), Jaris le dit à la place de répondre.
 * - >= GPU_SHUTDOWN_TEMP_C : Jaris s'arrête complètement pour protéger la machine.
 */
export function checkGpuTempSafety(tempC: number | null): GpuTempStatus {
  if (tempC === null) return { action: 'none', message: null }

  if (tempC >= GPU_SHUTDOWN_TEMP_C) {
    return {
      action: 'shutdown',
      message: `${GPU_SHUTDOWN_TEMP_C} degrés dépassés, le GPU est à ${tempC} degrés, je m'arrête automatiquement pour protéger la machine.`
    }
  }
  if (tempC >= GPU_ABORT_TEMP_C) {
    return { action: 'abort', message: `${GPU_ABORT_TEMP_C} degrés dépassés, arrêt de la requête.` }
  }
  if (tempC >= GPU_WARN_TEMP_C) {
    return {
      action: 'warn',
      message: `Attention, le GPU dépasse ${GPU_WARN_TEMP_C} degrés, il est actuellement à ${tempC} degrés.`
    }
  }
  return { action: 'none', message: null }
}
