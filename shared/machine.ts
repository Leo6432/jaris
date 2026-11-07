import { DUEL_REMOTE_MAX_RAM_GB, DUEL_REMOTE_MAX_VRAM_GB, normalizeRemoteOllamaHost } from './duel'

/**
 * Étape 437 (Léo : « un bouton Machine à gauche, il explique, tu lui dis combien de stockage, de VRAM, etc. ; et
 * maintenant tout Jaris tourne sur le VPS ») : la machine louée (Hostinger, RunPod…) dont l'Ollama fait tourner les
 * modèles du Duel et de l'Analyse tant qu'elle est connectée (étape 439 : plus Chat, Vocal ni Code, qui obligeaient à y
 * télécharger les modèles de Jaris). Jaris, ses outils, la voix, l'image et la vidéo restent sur ce PC.
 * Mémoire et disque sont donnés par Léo : Ollama ne dit ni la carte ni le disque de la machine qui le fait tourner.
 */
export interface RemoteMachineSettings {
  host: string
  vramGb: number
  ramGb: number
  diskGb: number
}

export const MACHINE_MAX_DISK_GB = 100_000

/** Réglages venus de l'écran ou du profil, revérifiés ; `null` s'ils ne sont pas utilisables (jamais crus tels quels). */
export function parseRemoteMachine(value: unknown): RemoteMachineSettings | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const host = typeof raw.host === 'string' ? normalizeRemoteOllamaHost(raw.host) : null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)
  const vramGb = num(raw.vramGb)
  const ramGb = num(raw.ramGb)
  const diskGb = num(raw.diskGb)
  if (!host) return null
  // 0 : une machine sans carte graphique (les modèles tournent alors sur son processeur), comme l'ancien réglage du Duel.
  if (!(vramGb >= 0 && vramGb <= DUEL_REMOTE_MAX_VRAM_GB)) return null
  if (!(ramGb >= 1 && ramGb <= DUEL_REMOTE_MAX_RAM_GB)) return null
  if (!(diskGb >= 10 && diskGb <= MACHINE_MAX_DISK_GB)) return null
  return { host, vramGb, ramGb, diskGb }
}

/**
 * Les réglages enregistrés : ceux de la page Machine, sinon (une fois) l'adresse de l'ancienne « autre machine » des
 * duels (étape 377, retirée du Duel à l'étape 437) — pour ne pas la retaper. Son disque n'y était pas : 100 Go par défaut.
 */
export function savedRemoteMachine(profile: { remoteMachine?: unknown; duelRemote?: unknown } | null | undefined): RemoteMachineSettings | null {
  const saved = parseRemoteMachine(profile?.remoteMachine)
  if (saved) return saved
  const old = profile?.duelRemote as { host?: unknown; vramGb?: unknown; ramGb?: unknown } | undefined
  return old ? parseRemoteMachine({ host: old.host, vramGb: old.vramGb, ramGb: old.ramGb, diskGb: 100 }) : null
}

/** Ce que la page Machine affiche (main → écran). */
export interface MachineView {
  /** Les derniers réglages enregistrés (pré-remplis), connectés ou non. */
  saved: RemoteMachineSettings | null
  /** Connectée : le Duel et l'Analyse y font tourner leurs modèles (étape 439 : Chat, Vocal et Code restent sur ce PC). */
  connected: boolean
  /** Connexion en cours (vérification de l'adresse). */
  connecting: boolean
  /** Version d'Ollama de la machine, une fois connectée. */
  version: string | null
  /** Pourquoi la dernière action n'a pas marché (adresse injoignable, disque plein…), rédigé pour Léo. */
  error: string | null
  /** Place libre estimée sur son disque (Go), d'après sa taille et les modèles qu'elle a. */
  freeDiskGb: number | null
  /** Un test de modèles tourne : connecter ou déconnecter attend sa fin. */
  busy: 'test' | null
}
