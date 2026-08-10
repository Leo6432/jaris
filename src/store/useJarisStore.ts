import { create } from 'zustand'

export type JarisEmotion = 'idle' | 'listening' | 'thinking' | 'happy' | 'surprised'

/** Délai d'inactivité avant que Jaris ne se rendorme (ms). */
const SLEEP_AFTER_MS = 45_000

interface JarisState {
  emotion: JarisEmotion
  /** Change l'émotion affichée. `manual` désactive le ré-endormissement auto. */
  setEmotion: (emotion: JarisEmotion) => void
  /** À appeler sur toute interaction (voix, clic...) pour repousser l'endormissement. */
  registerActivity: () => void
}

let sleepTimer: ReturnType<typeof setTimeout> | undefined

export const useJarisStore = create<JarisState>((set, get) => ({
  emotion: 'idle',

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
  }
}))
