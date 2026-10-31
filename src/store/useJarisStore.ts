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

/** Ce qu'un écran est en train de faire (Chat, Code, Image, Vidéo, Duel) : réfléchit, ou répond déjà. */
export type ActivityState = 'thinking' | 'happy'

interface JarisState {
  emotion: JarisEmotion
  /**
   * Étape 392 (Léo : « dès qu'il y a l'orbe, tu fais ça n'importe où ») : ce que fait chaque écran en ce moment.
   * Les orbes hors du mode vocal (barre d'icônes, barre de titre) prennent leur couleur ici (voir `shownEmotion`).
   */
  activity: Record<string, ActivityState>
  setActivity: (source: string, state: ActivityState | null) => void
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
  activity: {},
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

  setActivity: (source, next) =>
    set((state) => {
      if ((state.activity[source] ?? null) === next) return state
      const activity = { ...state.activity }
      if (next) activity[source] = next
      else delete activity[source]
      return { activity }
    }),

  setTranscript: (text) => set({ transcript: text }),
  setReply: (text) => set({ reply: text }),
  pushLog: (message) => set((state) => ({ logs: [...state.logs, message].slice(-MAX_LOGS) })),
  setSetupStatus: (status) => set({ setupStatus: status })
}))

/**
 * Couleur d'une orbe qui représente Jaris en général : la voix d'abord (elle a ses propres états), sinon ce que
 * font les écrans (« répond » l'emporte sur « réfléchit »), sinon le repos.
 */
export function shownEmotion(emotion: JarisEmotion, activity: Record<string, ActivityState>): JarisEmotion {
  if (emotion !== 'idle') return emotion
  const states = Object.values(activity)
  if (states.includes('happy')) return 'happy'
  if (states.includes('thinking')) return 'thinking'
  return 'idle'
}
