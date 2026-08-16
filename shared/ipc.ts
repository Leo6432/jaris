/** Types partagés entre le process principal (electron/) et le renderer (src/). */

export type JarisEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

export interface VoiceReplyPayload {
  transcript: string
  reply: string
  /** WAV brut (converti en Blob côté renderer pour la lecture). */
  audio: ArrayBuffer
}

export interface VoiceSetupStatusPayload {
  ready: boolean
  missing: string[]
}

export interface Profile {
  name: string
}

export interface MemoryGraphNode {
  id: string
}

export interface MemoryGraphLink {
  source: string
  target: string
}

/** Notes de la mémoire de Jaris et leurs liens [[...]], pour la vue graphe 3D (étape 10). */
export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  links: MemoryGraphLink[]
}

/** Canaux IPC main -> renderer pour piloter le visage et afficher la conversation. */
export const IPC_CHANNELS = {
  emotion: 'jaris:emotion',
  transcript: 'jaris:transcript',
  reply: 'jaris:reply',
  log: 'jaris:log',
  setupStatus: 'jaris:setup-status',
  /** renderer -> main : déclenche l'écoute manuellement (sans dire le mot d'activation). */
  triggerWake: 'jaris:trigger-wake',
  /** renderer <-> main : profil utilisateur (prénom), demandé une seule fois au premier lancement. */
  getProfile: 'jaris:get-profile',
  saveProfile: 'jaris:save-profile',
  /** renderer -> main : ouvre le dossier de mémoire markdown de Jaris dans l'explorateur de fichiers. */
  openMemoryFolder: 'jaris:open-memory-folder',
  /** renderer <-> main : récupère les notes de la mémoire et leurs liens, pour la vue graphe 3D. */
  getMemoryGraph: 'jaris:get-memory-graph',
  /** renderer <-> main : récupère le contenu markdown complet d'une note (clic sur un nœud du graphe). */
  getMemoryNoteContent: 'jaris:get-memory-note-content',
  /** renderer -> main : la lecture audio de la dernière réponse est terminée, on peut repasser en idle. */
  audioEnded: 'jaris:audio-ended'
} as const
