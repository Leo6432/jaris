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
  // Étape 293 (24 langues) : la demande arrive dans la langue choisie dans Jaris — jamais supposée française.
  "La description peut être écrite dans n'importe quelle langue (français, allemand, espagnol, russe, grec, polonais…) : traduis-la toujours vers l'anglais, jamais vers une autre langue.",
  'Réponds UNIQUEMENT par la traduction anglaise, sur une seule ligne, sans guillemets, sans explication.',
  "Garde exactement le sens : n'ajoute aucun détail, n'en retire aucun.",
  'Attention aux faux amis : « chat » = cat, « chien » = dog, « coin » = corner, « pain » = bread, « car » = because ; en allemand « Gift » = poison, « Rock » = skirt ; en espagnol « carpeta » = folder.',
  'Si la description est déjà en anglais, recopie-la telle quelle.',
  'Exemples : « un chat » → a cat ; « un phare au crépuscule, aquarelle » → a lighthouse at dusk, watercolor ; « ein Hund im Schnee » → a dog in the snow ; « кот на диване » → a cat on a sofa.'
].join('\n')

export interface TranslateDeps {
  chat: (messages: OllamaMessage[], model: string, signal?: AbortSignal) => Promise<string>
  model: () => Promise<string>
}

/**
 * Sans le moindre fragment d'Ollama pendant ce temps (chargement du modèle compris), la traduction est abandonnée et le
 * dessin part avec la demande telle quelle. Relecture croisée : c'était une limite de 60 s au TOTAL (une traduction qui
 * avançait était coupée) ; c'est maintenant une limite d'INACTIVITÉ.
 */
export const TRANSLATE_IDLE_MS = 60_000

/** Seule la première ligne sert (cleanTranslation) : dès qu'elle est complète, inutile d'attendre la suite. */
export function firstLineComplete(text: string): boolean {
  return /\S[^\n]*\n/.test(text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ''))
}

/**
 * La traduction par Ollama, en flux. Relecture croisée :
 * - fenêtre de contexte AUTOMATIQUE, la même que les autres demandes au modèle rapide : la fenêtre fixe de 2048 obligeait
 *   Ollama à recharger ce modèle (avant le dessin, puis de nouveau à la question suivante) ;
 * - surveillée par inactivité (TRANSLATE_IDLE_MS), et arrêtée par « Arrêter » (le signal de l'appelant) ;
 * - arrêtée dès que la première ligne est complète : un petit modèle qui se met à raconter ne tourne pas sans fin.
 */
export async function translateWithOllama(
  messages: OllamaMessage[],
  model: string,
  signal?: AbortSignal,
  request: typeof chatWithOllama = chatWithOllama,
  idleMs = TRANSLATE_IDLE_MS
): Promise<string> {
  const controller = new AbortController()
  let text = ''
  let enough = false
  let idle: ReturnType<typeof setTimeout> | undefined
  const alive = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), idleMs)
  }
  const stop = (): void => controller.abort()
  if (signal?.aborted) stop()
  signal?.addEventListener('abort', stop, { once: true })
  alive()
  try {
    // Sans réflexion : une traduction d'une ligne n'en a pas besoin, et la réflexion d'un petit modèle peut durer
    // plus longtemps que le dessin lui-même.
    const reply = await request(messages, [], model, false, controller.signal, undefined, (delta) => {
      alive()
      text += delta
      if (firstLineComplete(text)) {
        enough = true
        controller.abort()
      }
    }, alive)
    return reply.content ?? text
  } catch (err) {
    if (enough) return text
    throw err
  } finally {
    clearTimeout(idle)
    signal?.removeEventListener('abort', stop)
  }
}

const defaultDeps: TranslateDeps = {
  chat: (messages, model, signal) => translateWithOllama(messages, model, signal),
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

/**
 * La demande en anglais, ou telle quelle si la traduction est impossible (Ollama arrêté, réponse inexploitable, plus de
 * signe de vie). `signal` : « Arrêter » du dessin en cours, qui arrête aussi la traduction.
 */
export async function toEnglishPrompt(prompt: string, signal?: AbortSignal, deps: TranslateDeps = defaultDeps): Promise<{ text: string; translated: boolean }> {
  try {
    const model = await deps.model()
    const raw = await deps.chat(
      [
        { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      model,
      signal
    )
    const text = cleanTranslation(raw, prompt)
    return text ? { text, translated: true } : { text: prompt, translated: false }
  } catch {
    return { text: prompt, translated: false }
  }
}
