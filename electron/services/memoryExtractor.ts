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
      'vient juste de se dérouler. Ton seul travail : décider si cet échange contient un FAIT nouveau, ' +
      "concret et durable, que Jaris devrait se rappeler d'une conversation à l'autre (une préférence, une " +
      "adresse, un projet en cours, un rendez-vous, un fait donné sur la vie de l'utilisateur...).\n\n" +
      "Si oui, appelle IMPÉRATIVEMENT l'outil remember. Règles strictes pour le contenu de la note :\n" +
      '- Écris UNIQUEMENT le fait lui-même, comme une phrase de connaissance, à la troisième personne ' +
      '(bon exemple : "Adresse email de Léo : xxx@gmail.com.").\n' +
      "- N'écris JAMAIS de commentaire sur ce qui manque, ce qu'il faudrait redemander, ou ton propre " +
      'raisonnement (interdit : "il n\'a pas encore dit...", "il faudrait demander...", "il est ' +
      'nécessaire de..."). Si une info manque dans l\'échange, ignore-la simplement, n\'en parle pas ' +
      'dans la note.\n' +
      '- Le titre de la note désigne le sujet ou la personne concernée (ex: le prénom de ' +
      "l'utilisateur pour une info personnelle), jamais l'action en cours (pas de titre comme " +
      '"Réponse mail" ou "Question posée").\n\n' +
      'Si cet échange ne contient aucun fait nouveau et concret à garder (bavardage, question ' +
      "factuelle ponctuelle, demande d'action sans info personnelle, ou juste une incertitude sur une " +
      "info encore manquante), n'appelle aucun outil et ne réponds rien. " +
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
