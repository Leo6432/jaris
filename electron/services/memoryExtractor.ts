import { config } from '../config'
import { chatWithOllama, type OllamaMessage } from './ollama'
import { TOOLS } from './tools'
import { listMemoryTitles, rememberNote } from './memoryStore'
import { getProfile } from './profileStore'

const REMEMBER_TOOL = TOOLS.find((t) => t.function.name === 'remember')
if (!REMEMBER_TOOL) {
  throw new Error("Outil 'remember' introuvable dans TOOLS : ne devrait jamais arriver.")
}

/**
 * Passe d'extraction en arrière-plan, après chaque échange : décide si la conversation qui vient d'avoir
 * lieu contient un fait à retenir sur le long terme, sans attendre que l'utilisateur dise explicitement
 * "retiens que..." — en pratique, personne ne pense à le dire systématiquement, donc la mémoire ne
 * s'enrichissait presque jamais toute seule. Tourne toujours sur le palier médium (le seul dont la
 * fiabilité d'appel d'outils est éprouvée) avec un effort de réflexion bas (tâche de classification
 * simple, pas une vraie question) ; appelée sans attendre son résultat (fire-and-forget) depuis
 * voicePipeline, donc ne retarde jamais la réponse déjà dite à l'utilisateur. Toute erreur est avalée :
 * un souci ici ne doit jamais faire échouer la vraie conversation.
 */
export async function extractMemoryFromExchange(
  transcript: string,
  reply: string,
  onLog?: (message: string) => void
): Promise<void> {
  try {
    const [memoryTitles, profile] = await Promise.all([listMemoryTitles(), getProfile()])
    const model = profile?.models?.medium ?? config.ollama.model

    const systemPrompt =
      'Tu es le module de mémoire de Jaris, un assistant vocal. On te donne un échange de conversation qui ' +
      'vient juste de se dérouler. Ton seul travail : décider si cet échange contient une information ' +
      "personnelle durable, qui vaut la peine d'être gardée d'une conversation à l'autre (préférence de " +
      "l'utilisateur, projet en cours, rendez-vous, fait donné sur sa vie...). Si oui, appelle " +
      "IMPÉRATIVEMENT l'outil remember pour la sauvegarder, avec un titre de note court et clair. Si " +
      "l'échange ne contient rien de tel (bavardage, question factuelle ponctuelle, simple demande " +
      "d'action sans info personnelle...), n'appelle aucun outil et ne réponds rien. " +
      (memoryTitles.length
        ? `Notes déjà en mémoire : ${memoryTitles.join(', ')} — n'appelle pas remember pour une info déjà connue.`
        : '')

    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Utilisateur : ${transcript}\nJaris : ${reply}` }
    ]

    // Vérifié non-undefined au chargement du module (throw ci-dessus sinon) : le cast est sûr ici.
    const message = await chatWithOllama(messages, [REMEMBER_TOOL!], model, 'low')
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== 'remember') continue
      const title = String(call.function.arguments.title ?? '').trim()
      const content = String(call.function.arguments.content ?? '').trim()
      if (!title || !content) continue
      await rememberNote(title, content)
      onLog?.(`Mémoire enrichie automatiquement : "${title}"`)
    }
  } catch (err) {
    onLog?.(`Extraction mémoire ignorée (erreur) : ${err instanceof Error ? err.message : String(err)}`)
  }
}
