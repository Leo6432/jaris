import { create } from 'zustand'
import type { JarisEmotion, VoiceSetupStatusPayload } from '../../shared/ipc'

export type { JarisEmotion }

/**
 * Étape 346 : plus de minuteur local qui remet « idle » tout seul. Il le faisait SANS prévenir le processus principal,
 * qui gardait la fenêtre du widget dépliée : une grande zone invisible captait alors les clics en haut de l'écran, et
 * après 3 minutes de vraie réflexion l'orbe s'endormait comme si Jaris s'était arrêté. Le retour au repos vient
 * toujours du processus principal (fin de réponse, erreur, écoute sans phrase, suspension, voir voicePipeline.ts).
 */
const MAX_LOGS = 20

interface JarisState {
  emotion: JarisEmotion
  transcript: string | null
  reply: string | null
  logs: string[]
  setupStatus: VoiceSetupStatusPayload | null
  /** Change l'émotion affichée. */
  setEmotion: (emotion: JarisEmotion) => void
  setTranscript: (text: string) => void
  setReply: (text: string) => void
  pushLog: (message: string) => void
  setSetupStatus: (status: VoiceSetupStatusPayload) => void
}

export const useJarisStore = create<JarisState>((set) => ({
  emotion: 'idle',
  transcript: null,
  reply: null,
  logs: [],
  setupStatus: null,

  setEmotion: (emotion) => {
    // De retour à idle (fin de la réponse parlée, une fois le settle delay passé côté pipeline) : on
    // efface la transcription et la réponse affichées, pour ne pas laisser la dernière conversation
    // traîner indéfiniment à l'écran une fois que Jaris a fini de parler.
    set(emotion === 'idle' ? { emotion, transcript: null, reply: null } : { emotion })
  },

  setTranscript: (text) => set({ transcript: text }),
  setReply: (text) => set({ reply: text }),
  pushLog: (message) => set((state) => ({ logs: [...state.logs, message].slice(-MAX_LOGS) })),
  setSetupStatus: (status) => set({ setupStatus: status })
}))
