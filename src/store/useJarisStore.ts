import { create } from 'zustand'
import type { JarisEmotion, VoiceSetupStatusPayload } from '../../shared/ipc'

export type { JarisEmotion }

/** Délai d'inactivité avant que Jaris ne se rendorme (ms), pour les tests manuels. */
const SLEEP_AFTER_MS = 45_000
const MAX_LOGS = 20

interface JarisState {
  emotion: JarisEmotion
  transcript: string | null
  reply: string | null
  logs: string[]
  setupStatus: VoiceSetupStatusPayload | null
  /** Change l'émotion affichée. */
  setEmotion: (emotion: JarisEmotion) => void
  /** À appeler sur toute interaction (voix, clic...) pour repousser l'endormissement. */
  registerActivity: () => void
  setTranscript: (text: string) => void
  setReply: (text: string) => void
  pushLog: (message: string) => void
  setSetupStatus: (status: VoiceSetupStatusPayload) => void
}

let sleepTimer: ReturnType<typeof setTimeout> | undefined

export const useJarisStore = create<JarisState>((set, get) => ({
  emotion: 'idle',
  transcript: null,
  reply: null,
  logs: [],
  setupStatus: null,

  setEmotion: (emotion) => {
    set({ emotion })
    if (sleepTimer) clearTimeout(sleepTimer)
    if (emotion !== 'idle') {
      sleepTimer = setTimeout(() => {
        if (get().emotion !== 'idle') set({ emotion: 'idle' })
      }, SLEEP_AFTER_MS)
    }
  },

  registerActivity: () => {
    const current = get().emotion
    get().setEmotion(current === 'idle' ? 'listening' : current)
  },

  setTranscript: (text) => set({ transcript: text }),
  setReply: (text) => set({ reply: text }),
  pushLog: (message) => set((state) => ({ logs: [...state.logs, message].slice(-MAX_LOGS) })),
  setSetupStatus: (status) => set({ setupStatus: status })
}))
