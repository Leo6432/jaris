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
let history: OllamaMessage[] = []
let loaded = false

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  const pastEntries = await getConversationHistory(MAX_HISTORY_MESSAGES / 2)
  history = pastEntries.flatMap((entry): OllamaMessage[] => [
    { role: 'user', content: entry.transcript },
    { role: 'assistant', content: entry.reply }
  ])
}

/**
 * Amorcée depuis conversation-history.json (déjà tenu à jour par appendConversationEntry, voix comme chat)
 * au premier appel seulement : sans ça, redémarrer l'appli (ou revenir le lendemain) effaçait tout le
 * contexte d'un coup, alors que pour l'utilisateur c'est juste une pause dans la même conversation.
 */
export async function getSessionHistory(): Promise<OllamaMessage[]> {
  await ensureLoaded()
  return history
}

/** Ajoute un échange et retaille la fenêtre glissante — appelé par le canal (voix ou chat) qui vient de répondre. */
export function pushSessionExchange(prompt: string, reply: string): void {
  history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply })
  history.splice(0, Math.max(0, history.length - MAX_HISTORY_MESSAGES))
}

/** Vidé en même temps que conversation-history.json (voir clearConversationHistory), depuis le menu Options. */
export function clearSessionHistory(): void {
  history = []
  loaded = false
}
