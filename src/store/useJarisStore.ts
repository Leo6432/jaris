import { create } from 'zustand'
import type { JarisEmotion, VoiceSetupStatusPayload } from '../../shared/ipc'

export type { JarisEmotion }

/**
 * Filet de sécurité pour repasser à "idle" tout seul si jamais aucun vrai évènement ne le fait (bug,
 * requête réseau qui reste bloquée...) — ce n'est jamais censé être le chemin normal. Deux durées
 * différentes selon ce qu'on attend :
 * - "listening" : on attend que l'utilisateur parle, ça peut légitimement ne jamais arriver (silence),
 *   donc un délai court a du sens pour se rendormir.
 * - "thinking"/"happy" : Jaris est en train de vraiment travailler (recherche web, plusieurs outils
 *   enchaînés...), ce qui peut prendre largement plus de 45s sur du matériel local pour une question
 *   complexe — un délai aussi court le faisait "s'endormir" en pleine réflexion avant même d'avoir
 *   répondu. Un délai beaucoup plus généreux ici : juste un filet en cas de vrai blocage, pas une limite
 *   de temps de réponse normale.
 */
const LISTENING_SLEEP_AFTER_MS = 45_000
const PROCESSING_SLEEP_AFTER_MS = 3 * 60_000
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
    // De retour à idle (fin de la réponse parlée, une fois le settle delay passé côté pipeline) : on
    // efface la transcription et la réponse affichées, pour ne pas laisser la dernière conversation
    // traîner indéfiniment à l'écran une fois que Jaris a fini de parler.
    set(emotion === 'idle' ? { emotion, transcript: null, reply: null } : { emotion })
    if (sleepTimer) clearTimeout(sleepTimer)
    if (emotion !== 'idle') {
      const delay = emotion === 'listening' ? LISTENING_SLEEP_AFTER_MS : PROCESSING_SLEEP_AFTER_MS
      sleepTimer = setTimeout(() => {
        if (get().emotion !== 'idle') set({ emotion: 'idle' })
      }, delay)
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
