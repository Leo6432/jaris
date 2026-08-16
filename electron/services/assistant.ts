import { chatWithOllama, type OllamaMessage } from './ollama'
import { TOOLS, createToolExecutor } from './tools'

function buildSystemPrompt(userName: string | null): string {
  const addressing = userName
    ? `L'utilisateur s'appelle ${userName} : appelle-le par son prénom de temps en temps, sans exagérer. `
    : ''

  const now = new Date()
  const dateTime = `Nous sommes le ${now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, il est ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. `

  return (
    "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local sur l'ordinateur de " +
    "l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale. " +
    "Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, " +
    'de listes à puces ni de mise en forme, uniquement du texte normal. ' +
    dateTime +
    addressing +
    "Tu as accès à des outils pour agir réellement : ouvrir une application, programmer un rappel vocal, " +
    "regarder l'écran de l'utilisateur, chercher sur le web. Pour toute action concrète, tu dois " +
    "IMPÉRATIVEMENT appeler l'outil correspondant via un vrai appel de fonction, immédiatement, sans phrase " +
    "d'annonce avant. Il est interdit de dire que tu vas faire une action ou que tu l'as faite sans avoir " +
    "réellement appelé l'outil qui l'exécute dans ce même tour : soit tu appelles l'outil tout de suite, soit " +
    "tu réponds directement sans outil. Quand tu donnes une information factuelle trouvée sur le web (prix, " +
    "cours, score, statistique...), donne le chiffre précis d'une source fiable, jamais une moyenne ou une " +
    'fourchette entre plusieurs sites : choisis la donnée la plus claire et la plus récente parmi les résultats.'
  )
}

const MAX_TOOL_ROUNDS = 4

/** Envoie la phrase transcrite à Ollama, exécute les outils qu'il demande, renvoie la réponse finale à dire. */
export async function converse(
  prompt: string,
  userName: string | null,
  onReminderFire: (message: string) => void,
  onLog?: (message: string) => void
): Promise<string> {
  const executeTool = createToolExecutor(onReminderFire)
  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(userName) },
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
