import { config } from '../config'
import { chatWithOllama, type OllamaMessage } from './ollama'
import { getProfile } from './profileStore'

/**
 * Étape 292 (Léo, capture à l'appui : « je lui ai envoyé "chat" comme prompt, voici ce qu'il m'a fait » — le portrait
 * d'un homme souriant derrière un bureau). Le modèle de dessin (FLUX.2 klein) a appris sur des légendes ANGLAISES :
 * il a lu « un chat » comme « a chat », une conversation. Le mode Image envoyait la demande telle quelle, alors que
 * l'outil du Chat demande déjà au modèle de conversation d'écrire la description en anglais. Une demande tapée dans
 * le mode Image (ou envoyée depuis le téléphone) est donc d'abord traduite par le modèle rapide, puis dessinée.
 */
export const TRANSLATE_SYSTEM_PROMPT = [
  "Tu traduis en anglais la description d'une image à dessiner, pour un modèle de dessin qui ne comprend que l'anglais.",
  'Réponds UNIQUEMENT par la traduction anglaise, sur une seule ligne, sans guillemets, sans explication.',
  "Garde exactement le sens : n'ajoute aucun détail, n'en retire aucun.",
  'Attention aux faux amis : « chat » = cat, « chien » = dog, « coin » = corner, « pain » = bread, « car » = because.',
  'Si la description est déjà en anglais, recopie-la telle quelle.',
  'Exemples : « un chat » → a cat ; « un phare au crépuscule, aquarelle » → a lighthouse at dusk, watercolor.'
].join('\n')

export interface TranslateDeps {
  chat: (messages: OllamaMessage[], model: string) => Promise<string>
  model: () => Promise<string>
}

const defaultDeps: TranslateDeps = {
  // Sans réflexion : une traduction d'une ligne n'en a pas besoin, et la réflexion d'un petit modèle peut durer
  // plus longtemps que le dessin lui-même.
  chat: async (messages, model) => (await chatWithOllama(messages, [], model, false, AbortSignal.timeout(60_000), 2048)).content ?? '',
  // Le modèle rapide : celui qui se charge le plus vite, et largement assez bon pour traduire une phrase.
  model: async () => (await getProfile())?.models?.flash ?? config.ollama.model
}

/**
 * La première vraie ligne de la réponse, débarrassée de ce qu'un petit modèle ajoute parfois malgré la consigne :
 * réflexion, « Translation: », guillemets. `null` si elle est vide ou sans rapport de longueur avec la demande (un
 * modèle qui se met à raconter) : mieux vaut alors dessiner la demande telle quelle qu'une invention.
 */
export function cleanTranslation(raw: string, original: string): string | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  const cleaned = line
    .replace(/^(?:english\s+)?(?:translation|traduction)\s*:\s*/i, '')
    .replace(/^["'«“\s]+|["'»”\s]+$/g, '')
    .trim()
  if (!cleaned) return null
  if (cleaned.length > original.length * 4 + 120) return null
  return cleaned
}

/** La demande en anglais, ou telle quelle si la traduction est impossible (Ollama arrêté, réponse inexploitable). */
export async function toEnglishPrompt(prompt: string, deps: TranslateDeps = defaultDeps): Promise<{ text: string; translated: boolean }> {
  try {
    const model = await deps.model()
    const raw = await deps.chat(
      [
        { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      model
    )
    const text = cleanTranslation(raw, prompt)
    return text ? { text, translated: true } : { text: prompt, translated: false }
  } catch {
    return { text: prompt, translated: false }
  }
}
