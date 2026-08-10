import { chatWithOllama, type OllamaMessage } from './ollama'
import { TOOLS, createToolExecutor } from './tools'

const SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local sur l'ordinateur de " +
  "l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale. " +
  "Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, " +
  "de listes à puces ni de mise en forme, uniquement du texte normal. " +
  "Tu peux ouvrir des applications et programmer des rappels vocaux grâce aux outils disponibles."

const MAX_TOOL_ROUNDS = 4

/** Envoie la phrase transcrite à Ollama, exécute les outils qu'il demande, renvoie la réponse finale à dire. */
export async function converse(prompt: string, onReminderFire: (message: string) => void): Promise<string> {
  const executeTool = createToolExecutor(onReminderFire)
  const messages: OllamaMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await chatWithOllama(messages, TOOLS)
    if (!message.tool_calls?.length) {
      return message.content.trim()
    }

    messages.push(message)
    for (const call of message.tool_calls) {
      const result = await executeTool(call.function.name, call.function.arguments)
      messages.push({ role: 'tool', content: result })
    }
  }

  throw new Error("Trop d'actions enchaînées, j'abandonne pour éviter de tourner en rond.")
}
