import { runWithOllamaHost, setMachineOllamaHost } from '../config'
import { parseRemoteMachine, savedRemoteMachine, type MachineView, type RemoteMachineSettings } from '../../shared/machine'
import { remoteThreadsFor } from '../../shared/duel'
import type { Profile } from '../../shared/ipc'
import { t } from '../../shared/i18n'
import { fetchOllamaVersion, listInstalledModels, pullModelIfMissing } from './ollama'
import { getProfile, patchProfile } from './profileStore'

/**
 * Étape 437 (Léo : « un bouton Machine à gauche… tout Jaris tourne sur le VPS, si je vais dans Analyse et que je lance,
 * ça se fait sur le VPS, et après je peux déconnecter ») : la machine louée connectée.
 *
 * - Connecter : l'adresse est revérifiée, son Ollama doit répondre, puis elle devient l'Ollama de tout Jaris
 *   (setMachineOllamaHost, config.ts) — Chat, Vocal, Code, Duel, Analyse. Les modèles de Jaris y sont téléchargés
 *   (préparation), un par un, avec l'avancement à l'écran.
 * - Déconnecter : Jaris revient tout de suite à l'Ollama de ce PC ; le téléchargement en cours s'arrête.
 * - Jamais pendant un test (il a choisi sa machine au départ) ; pas de connexion pendant une session de duels sur ce PC.
 * - Jamais connectée au démarrage : seule l'adresse est gardée (une machine supprimée depuis laisserait Jaris muet).
 */

/** Place que le système et Ollama prennent eux-mêmes sur le disque de la machine (estimation prudente). */
export const MACHINE_DISK_RESERVED_GB = 10

let connected: RemoteMachineSettings | null = null
let connecting = false
let version: string | null = null
let error: string | null = null
let models: MachineView['models'] = []
let pulling: MachineView['pulling'] = null
let freeDiskGb: number | null = null
let preparing: AbortController | null = null
let saved: RemoteMachineSettings | null = null
let savedLoaded = false

/**
 * Taille d'un modèle (Go), branchée par main.ts sur la liste des modèles de Jaris : un modèle qui tient entier sur la
 * carte de la machine demande peu de fils de calcul (étape 387, remoteThreadsFor) — sans ça, chacun en lançait un par
 * cœur visible du serveur (192 sur RunPod) et la carte restait à 25 %.
 */
let modelSizeGb: (model: string) => number | undefined = () => undefined
export function setMachineModelSizeSource(source: (model: string) => number | undefined): void {
  modelSizeGb = source
}

type BusySource = () => MachineView['busy']
let busySource: BusySource = () => null
/** Branché par main.ts : un test de modèles ou un duel en cours bloque la connexion et la déconnexion. */
export function setMachineBusySource(source: BusySource): void {
  busySource = source
}

const listeners = new Set<(view: MachineView) => void>()
export function onMachineChanged(listener: (view: MachineView) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(): void {
  const view = machineView()
  for (const listener of listeners) listener(view)
}

/** La machine connectée, ou `null` : ce PC fait tourner les modèles. */
export function connectedMachine(): RemoteMachineSettings | null {
  return connected
}

export function machineView(): MachineView {
  return { saved: connected ?? saved, connected: connected !== null, connecting, version, error, models, pulling, freeDiskGb, busy: busySource() }
}

export async function loadMachineView(): Promise<MachineView> {
  if (!savedLoaded) {
    saved = savedRemoteMachine(await getProfile().catch(() => null))
    savedLoaded = true
  }
  return machineView()
}

/** Les modèles que Jaris utilise (rôles, voix, vision, code, pilotage, choix de Léo), chacun une fois. */
export function jarisModelsOf(profile: Profile | null): string[] {
  const all = [
    ...Object.values(profile?.models ?? {}),
    ...Object.values(profile?.voiceModels ?? {}),
    profile?.visionModel,
    profile?.codeModel,
    profile?.pilotModel,
    ...Object.values(profile?.modelChoices ?? {})
  ].filter((m): m is string => typeof m === 'string' && m.length > 0)
  return [...new Set(all)]
}

/**
 * Place libre sur le disque de la machine : sa taille (donnée par Léo) moins ce que ses modèles occupent (lu sur son
 * Ollama) et la part du système. `null` si son Ollama ne répond pas.
 */
export async function machineFreeDiskGb(machine: RemoteMachineSettings): Promise<number | null> {
  try {
    const response = await fetch(`${machine.host}/api/tags`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const data = (await response.json()) as { models?: { size?: number }[] }
    const usedGb = (data.models ?? []).reduce((sum, m) => sum + (typeof m.size === 'number' ? m.size : 0), 0) / 1024 ** 3
    return Math.max(0, Math.round((machine.diskGb - MACHINE_DISK_RESERVED_GB - usedGb) * 10) / 10)
  } catch {
    return null
  }
}

/** Un test en cours bloque connexion et déconnexion ; une session de duels sur CE PC bloque seulement la connexion. */
function refuseWhileBusy(action: 'connect' | 'disconnect'): void {
  const busy = busySource()
  if (busy === 'test') throw new Error(t('machine.busyTest'))
  if (busy === 'duel' && action === 'connect') throw new Error(t('machine.busyDuel'))
}

export async function connectMachine(value: unknown): Promise<MachineView> {
  refuseWhileBusy('connect')
  const settings = parseRemoteMachine(value)
  if (!settings) throw new Error(t('machine.badSettings'))
  if (connecting) return machineView()
  connecting = true
  error = null
  emit()
  try {
    // Vérifiée AVANT de basculer : une adresse qui ne répond pas ne doit jamais laisser Jaris sans modèles.
    const reached = await runWithOllamaHost(settings.host, () => fetchOllamaVersion(15_000))
    // Revérifié APRÈS l'attente (jusqu'à 15 s) : un test ou une session de duels lancé entre-temps garde sa machine.
    refuseWhileBusy('connect')
    disconnectQuietly()
    connected = settings
    version = reached
    saved = settings
    savedLoaded = true
    const vramGb = settings.vramGb
    setMachineOllamaHost({ host: settings.host, threadsFor: (model) => remoteThreadsFor(modelSizeGb(model) ?? Number.NaN, vramGb) })
    // Gardée seulement une fois la machine jointe : une faute de frappe ne remplace pas la bonne adresse.
    await patchProfile({ remoteMachine: settings }).catch(() => null)
  } catch (err) {
    // Déjà connectée à une autre machine : elle reste connectée, avec sa version ; seule l'erreur s'affiche.
    error = err instanceof Error ? err.message : String(err)
  } finally {
    connecting = false
  }
  emit()
  if (connected === settings) void prepareMachine(settings)
  return machineView()
}

function disconnectQuietly(): void {
  preparing?.abort()
  preparing = null
  pulling = null
  connected = null
  setMachineOllamaHost(null)
}

export function disconnectMachine(): MachineView {
  refuseWhileBusy('disconnect')
  disconnectQuietly()
  version = null
  error = null
  models = []
  freeDiskGb = null
  emit()
  return machineView()
}

/**
 * Télécharge sur la machine les modèles de Jaris qui n'y sont pas, un par un. Épinglé à SON adresse : une déconnexion
 * en route arrête le téléchargement et ne fait jamais télécharger la suite sur ce PC.
 */
async function prepareMachine(machine: RemoteMachineSettings): Promise<void> {
  const controller = new AbortController()
  preparing = controller
  const stillThisMachine = (): boolean => !controller.signal.aborted && connected === machine
  await runWithOllamaHost(machine.host, async () => {
    const wanted = jarisModelsOf(await getProfile().catch(() => null))
    let installed: string[] = []
    try {
      installed = await listInstalledModels()
    } catch (err) {
      if (stillThisMachine()) error = err instanceof Error ? err.message : String(err)
    }
    const has = (m: string): boolean => installed.some((i) => i === m || i === `${m}:latest` || `${i}:latest` === m)
    const list: MachineView['models'] = wanted.map((model) => ({ model, installed: has(model), error: null }))
    const free = await machineFreeDiskGb(machine)
    // Rien n'est écrit pour une machine qui n'est plus celle connectée (déconnectée, ou remplacée entre-temps).
    if (!stillThisMachine()) return
    models = list
    freeDiskGb = free
    emit()
    for (const entry of list) {
      if (entry.installed) continue
      if (!stillThisMachine()) return
      pulling = { model: entry.model, percent: null }
      emit()
      try {
        await pullModelIfMissing(
          entry.model,
          undefined,
          (progress) => {
            if (!stillThisMachine()) return
            pulling = { model: entry.model, percent: progress ? progress.percent : null }
            emit()
          },
          controller.signal
        )
        entry.installed = true
      } catch (err) {
        if (!stillThisMachine()) return
        entry.error = err instanceof Error ? err.message : String(err)
      }
      const nowFree = await machineFreeDiskGb(machine)
      if (!stillThisMachine()) return
      freeDiskGb = nowFree
    }
    pulling = null
    emit()
  }).catch(() => {})
  if (preparing === controller) preparing = null
}
