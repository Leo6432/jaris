import { chatWithOllama, type OllamaMessage } from './ollama'
import { listMemoryTitles } from './memoryStore'
import { TOOLS, createToolExecutor } from './tools'

function buildSystemPrompt(userName: string | null, memoryTitles: string[]): string {
  const addressing = userName
    ? `L'utilisateur s'appelle ${userName} : appelle-le par son prénom de temps en temps, sans exagérer. `
    : ''

  const now = new Date()
  const dateTime = `Nous sommes le ${now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, il est ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. `

  const memory = memoryTitles.length
    ? `Tu as une mémoire locale sous forme de notes markdown liées entre elles (comme Obsidian). Notes déjà ` +
      `connues : ${memoryTitles.join(', ')}. Utilise recall_memory pour relire le contenu complet d'une note ` +
      "avant d'en parler avec précision. "
    : "Tu as une mémoire locale sous forme de notes markdown (comme Obsidian), encore vide. "
  const memoryRule =
    "Dès que l'utilisateur te demande explicitement de retenir/mémoriser quelque chose (\"retiens que...\", " +
    '"n\'oublie pas que...", etc.), ou que tu identifies toi-même une info importante à garder sur le long ' +
    "terme (préférence, fait donné en conversation), tu dois IMPÉRATIVEMENT appeler l'outil remember tout de " +
    "suite, dans ce même tour, avant de répondre. Ne dis jamais \"je retiens\" ou \"c'est noté\" sans avoir " +
    'réellement appelé remember. '

  return (
    "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local sur l'ordinateur de " +
    "l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale. " +
    "Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, " +
    'de listes à puces ni de mise en forme, uniquement du texte normal. ' +
    dateTime +
    addressing +
    memory +
    memoryRule +
    "Tu as accès à des outils pour agir réellement : ouvrir une application, programmer un rappel vocal, " +
    "regarder l'écran de l'utilisateur, chercher sur le web, mémoriser ou relire une information dans ta " +
    "mémoire locale. Pour toute action concrète, tu dois IMPÉRATIVEMENT appeler l'outil correspondant via un " +
    "vrai appel de fonction, immédiatement, sans phrase d'annonce avant. Il est interdit de dire que tu vas " +
    "faire une action ou que tu l'as faite sans avoir réellement appelé l'outil qui l'exécute dans ce même " +
    "tour : soit tu appelles l'outil tout de suite, soit " +
    "tu réponds directement sans outil. Quand tu donnes une information factuelle trouvée sur le web (prix, " +
    "cours, score, statistique...), donne le chiffre précis d'une source fiable, jamais une moyenne ou une " +
    "fourchette entre plusieurs sites : choisis la donnée la plus claire et la plus récente parmi les résultats, " +
    'et précise le nom du site source.'
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
  const memoryTitles = await listMemoryTitles()
  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(userName, memoryTitles) },
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
