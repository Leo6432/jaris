import { getConversationHistory } from './conversationStore'
import type { OllamaMessage } from './ollama'

/**
 * Derniers échanges (user/assistant) gardés en mémoire courte, pour que Jaris comprenne une
 * correction/précision ("répète juste l'adresse") sans devoir tout redire depuis le début. Une fenêtre
 * glissante plutôt qu'un vrai reset explicite : le contexte ancien sort tout seul au fil des échanges,
 * pas besoin de deviner "quand" une conversation est vraiment terminée.
 */
const MAX_HISTORY_MESSAGES = 12

/**
 * Étape 47 : session PARTAGÉE entre le pipeline vocal et le mode Chat (auparavant deux copies indépendantes,
 * chacune chargée séparément à son propre premier usage — voicePipeline.ts et chatSession.ts avaient chacun
 * leur `private history`). Passer de l'un à l'autre en pleine conversation ne voyait donc pas forcément le
 * tout dernier échange de l'autre canal, alors que les deux écrivent déjà dans le même
 * conversation-history.json. Un seul état ici, partagé par les deux : parler à voix haute puis enchaîner par
 * écrit (ou l'inverse) continue vraiment la même conversation, dans les deux sens, immédiatement.
 */
/** Un échange et son heure : l'âge décide s'il fait encore partie de la conversation vocale (étape 253). */
interface TimedExchange {
  prompt: string
  reply: string
  at: number
}

let exchanges: TimedExchange[] = []
let loaded = false

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  const pastEntries = await getConversationHistory(MAX_HISTORY_MESSAGES / 2)
  exchanges = pastEntries.map((entry) => ({ prompt: entry.transcript, reply: entry.reply, at: Date.parse(entry.timestamp) || 0 }))
}

/**
 * Étape 253, Léo : « dès qu'il y a un peu de conversation en historique, il se focalise sur les anciennes, il me parle
 * de la recette de tiramisu quand je lui demande de cliquer sur la vidéo ». Son journal : la recette datait de 18 h,
 * la vidéo de 21 h 34 — mais les 6 derniers échanges partaient au modèle quel que soit leur âge, rechargés même
 * après un redémarrage, et un petit modèle local s'accroche à ce qu'il voit. À la voix, une conversation est faite
 * d'échanges rapprochés : au-delà de ce délai, l'échange ne lui est plus montré (il reste sur le disque et à
 * l'écran). Le Chat n'est pas concerné : son fil est affiché, l'utilisateur y voit ce qu'il continue.
 */
export const VOICE_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000

/**
 * Amorcée depuis conversation-history.json (déjà tenu à jour par appendConversationEntry, voix comme chat)
 * au premier appel seulement : sans ça, redémarrer l'appli (ou revenir le lendemain) effaçait tout le
 * contexte d'un coup, alors que pour l'utilisateur c'est juste une pause dans la même conversation.
 */
export async function getSessionHistory(options: { maxAgeMs?: number; now?: number } = {}): Promise<OllamaMessage[]> {
  await ensureLoaded()
  const now = options.now ?? Date.now()
  const recent = options.maxAgeMs === undefined ? exchanges : exchanges.filter((e) => now - e.at <= options.maxAgeMs!)
  return recent.flatMap((e): OllamaMessage[] => [
    { role: 'user', content: e.prompt },
    { role: 'assistant', content: e.reply }
  ])
}

/** Ajoute un échange et retaille la fenêtre glissante — appelé par le canal (voix ou chat) qui vient de répondre. */
export function pushSessionExchange(prompt: string, reply: string, at = Date.now()): void {
  exchanges.push({ prompt, reply, at })
  exchanges.splice(0, Math.max(0, exchanges.length - MAX_HISTORY_MESSAGES / 2))
}

/** Vidé en même temps que conversation-history.json (voir clearConversationHistory), depuis le menu Options. */
export function clearSessionHistory(): void {
  exchanges = []
  loaded = false
}
