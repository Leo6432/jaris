import { chatWithOllama, type OllamaMessage } from './ollama'
import { TOOLS, createToolExecutor } from './tools'

const SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local sur l'ordinateur de " +
  "l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale. " +
  "Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, " +
  "de listes à puces ni de mise en forme, uniquement du texte normal. " +
  "Tu as accès à des outils pour agir réellement : ouvrir une application, programmer un rappel vocal, " +
  "regarder l'écran de l'utilisateur, chercher sur le web. Pour toute action concrète, tu dois " +
  "IMPÉRATIVEMENT appeler l'outil correspondant via un vrai appel de fonction. Il est interdit de dire que " +
  "tu as fait une action sans avoir réellement appelé l'outil qui l'exécute : attends toujours son résultat " +
  "avant de confirmer quoi que ce soit à l'utilisateur."

const MAX_TOOL_ROUNDS = 4

/** Envoie la phrase transcrite à Ollama, exécute les outils qu'il demande, renvoie la réponse finale à dire. */
export async function converse(
  prompt: string,
  onReminderFire: (message: string) => void,
  onLog?: (message: string) => void
): Promise<string> {
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
      onLog?.(`Outil appelé : ${call.function.name}(${JSON.stringify(call.function.arguments)})`)
      const result = await executeTool(call.function.name, call.function.arguments)
      onLog?.(`Résultat de l'outil : ${result}`)

      // La vision tourne sur un modèle séparé qui partage la même VRAM que le
      // modèle de conversation : les deux ne tiennent pas en même temps sur
      // une carte 8 Go, donc repasser par qwen3.5 pour reformuler forcerait un
      // rechargement complet. Le modèle de vision répond déjà comme Jaris.
      if (call.function.name === 'look_at_screen') {
        return result
      }

      messages.push({ role: 'tool', content: result })
    }
  }

  throw new Error("Trop d'actions enchaînées, j'abandonne pour éviter de tourner en rond.")
}
