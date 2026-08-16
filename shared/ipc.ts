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
  /** true une fois l'écran "connecter Gmail ou ignorer" affiché après le premier lancement. */
  gmailOnboardingDone?: boolean
}

export interface MemoryGraphNode {
  id: string
  /** true pour le nœud central représentant l'utilisateur (pas une vraie note markdown). */
  isCenter?: boolean
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

/** État de la connexion Gmail (étape 11), pour le menu Options. */
export interface GmailStatus {
  connected: boolean
  email: string | null
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
  /** renderer -> main : marque l'écran de connexion Gmail comme vu (après connexion ou "Ignorer"). */
  markGmailOnboardingDone: 'jaris:mark-gmail-onboarding-done',
  /** renderer -> main : ouvre le dossier de mémoire markdown de Jaris dans l'explorateur de fichiers. */
  openMemoryFolder: 'jaris:open-memory-folder',
  /** renderer <-> main : récupère les notes de la mémoire et leurs liens, pour la vue graphe 3D. */
  getMemoryGraph: 'jaris:get-memory-graph',
  /** renderer <-> main : récupère le contenu markdown complet d'une note (clic sur un nœud du graphe). */
  getMemoryNoteContent: 'jaris:get-memory-note-content',
  /** renderer -> main : la lecture audio de la dernière réponse est terminée, on peut repasser en idle. */
  audioEnded: 'jaris:audio-ended',
  /** renderer <-> main : état de la connexion Gmail. */
  getGmailStatus: 'jaris:get-gmail-status',
  /** renderer <-> main : lance le flux de connexion Gmail (ouvre le navigateur système). */
  connectGmail: 'jaris:connect-gmail',
  /** renderer -> main : déconnecte le compte Gmail. */
  disconnectGmail: 'jaris:disconnect-gmail'
} as const
