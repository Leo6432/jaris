import { runWithOllamaHost } from '../config'
import { parseRemoteMachine, savedRemoteMachine, type MachineView, type RemoteMachineSettings } from '../../shared/machine'
import { t } from '../../shared/i18n'
import { fetchOllamaVersion } from './ollama'
import { getProfile, patchProfile } from './profileStore'

/**
 * Étape 437 (Léo : « un bouton Machine à gauche… si je vais dans Analyse et que je lance, ça se fait sur le VPS, et après
 * je peux déconnecter ») : la machine louée connectée.
 *
 * - Connecter : l'adresse est revérifiée et son Ollama doit répondre. Étape 439 (Léo : « pour pas que ça installe des
 *   modèles dès qu'on met la machine, il met que quand il fait duel classement, pas direct ») : RIEN n'y est téléchargé à
 *   la connexion, et seuls le Duel et l'Analyse y tournent (chacun télécharge, teste puis supprime ses modèles) ; Chat,
 *   Vocal et Code restent sur ce PC. Avant, ses 6 modèles de Jaris remplissaient le disque d'une machine Hostinger.
 * - Déconnecter : les prochains duels et tests se font sur ce PC.
 * - Jamais pendant un test (il a choisi sa machine au départ).
 * - Jamais connectée au démarrage : seule l'adresse est gardée (une machine supprimée depuis laisserait Jaris muet).
 */

/** Place que le système et Ollama prennent eux-mêmes sur le disque de la machine (estimation prudente). */
export const MACHINE_DISK_RESERVED_GB = 10

let connected: RemoteMachineSettings | null = null
let connecting = false
let version: string | null = null
let error: string | null = null
let freeDiskGb: number | null = null
let saved: RemoteMachineSettings | null = null
let savedLoaded = false

type BusySource = () => MachineView['busy']
let busySource: BusySource = () => null
/** Branché par main.ts : un test de modèles en cours bloque la connexion et la déconnexion. */
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
  return { saved: connected ?? saved, connected: connected !== null, connecting, version, error, freeDiskGb, busy: busySource() }
}

export async function loadMachineView(): Promise<MachineView> {
  if (!savedLoaded) {
    saved = savedRemoteMachine(await getProfile().catch(() => null))
    savedLoaded = true
  }
  return machineView()
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

/** Un test en cours bloque connexion et déconnexion (il a choisi sa machine au départ). */
function refuseWhileBusy(): void {
  if (busySource() === 'test') throw new Error(t('machine.busyTest'))
}

export async function connectMachine(value: unknown): Promise<MachineView> {
  refuseWhileBusy()
  const settings = parseRemoteMachine(value)
  if (!settings) throw new Error(t('machine.badSettings'))
  if (connecting) return machineView()
  connecting = true
  error = null
  emit()
  try {
    // Vérifiée AVANT de basculer : une adresse qui ne répond pas ne doit jamais laisser Jaris sans modèles.
    const reached = await runWithOllamaHost(settings.host, () => fetchOllamaVersion(15_000))
    // Revérifié APRÈS l'attente (jusqu'à 15 s) : un test lancé entre-temps garde sa machine.
    refuseWhileBusy()
    disconnectQuietly()
    connected = settings
    version = reached
    saved = settings
    savedLoaded = true
    // Gardée seulement une fois la machine jointe : une faute de frappe ne remplace pas la bonne adresse.
    await patchProfile({ remoteMachine: settings }).catch(() => null)
  } catch (err) {
    // Déjà connectée à une autre machine : elle reste connectée, avec sa version ; seule l'erreur s'affiche.
    error = err instanceof Error ? err.message : String(err)
  } finally {
    connecting = false
  }
  emit()
  if (connected === settings) void refreshFreeDisk(settings)
  return machineView()
}

function disconnectQuietly(): void {
  connected = null
}

export function disconnectMachine(): MachineView {
  refuseWhileBusy()
  disconnectQuietly()
  version = null
  error = null
  freeDiskGb = null
  emit()
  return machineView()
}

/** La place libre affichée, relue une fois connectée ; rien n'est écrit si la machine a changé entre-temps. */
async function refreshFreeDisk(machine: RemoteMachineSettings): Promise<void> {
  const free = await machineFreeDiskGb(machine)
  if (connected !== machine) return
  freeDiskGb = free
  emit()
}
