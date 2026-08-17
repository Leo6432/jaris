import { config } from '../config'
import { chatWithOllama, type OllamaMessage, type ThinkLevel } from './ollama'
import { listMemoryTitles } from './memoryStore'
import { getProfile } from './profileStore'
import { TOOLS, createToolExecutor } from './tools'
import { GPU_TEMP_LIMIT_C, getLiveGpuStatus, pickSafeModel } from './hardwareScan'
import { checkOverloadWarning } from './resourceMonitor'

interface ModelTiers {
  flash: string
  medium: string
  large: string
}

type Tier = keyof ModelTiers

// Sur du matériel contraint, plusieurs paliers peuvent pointer vers le même modèle (pas assez de VRAM
// pour un vrai modèle "puissant" séparé) : on les différencie quand même via l'effort de réflexion
// d'Ollama (think: low/medium/high), qui ne coûte pas de VRAM supplémentaire.
const THINK_LEVEL: Record<Tier, ThinkLevel> = {
  flash: 'low',
  medium: 'medium',
  large: 'high'
}

// Un appel d'outil (ouvrir une appli, rappel, recherche web, mémoire, mail...) doit toujours passer par
// le palier "medium" : c'est le seul dont la fiabilité d'appel d'outils a été éprouvée en conditions
// réelles. Le "flash" est réservé aux échanges sans action ni raisonnement poussé, le "large" aux
// questions qui demandent explicitement une réflexion approfondie.
const TOOL_SIGNAL_WORDS = [
  'ouvre', 'ouvrir', 'lance', 'lancer', 'rappelle', 'rappel', 'cherche', 'recherche', 'regarde', "l'écran",
  'écran', 'retiens', 'retenir', 'mémorise', 'souviens', 'rappelle-toi', 'envoie', 'envoyer', 'mail', 'email', 'mémoire'
]
const COMPLEX_SIGNAL_WORDS = ['pourquoi', 'explique', 'explique-moi', 'compare', 'analyse', 'différence', 'avantages', 'inconvénients', 'résume', 'détaille']

/** Choisit le palier de complexité le plus adapté à la question, sans appel LLM supplémentaire (juste des mots-clés). */
function pickTier(prompt: string): Tier {
  const lower = prompt.toLowerCase()
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length

  if (TOOL_SIGNAL_WORDS.some((w) => lower.includes(w))) return 'medium'
  if (COMPLEX_SIGNAL_WORDS.some((w) => lower.includes(w)) || wordCount > 25) return 'large'
  if (wordCount <= 8) return 'flash'
  return 'medium'
}

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
    "réellement appelé remember. Comme dans Obsidian, préfère plusieurs petites notes liées plutôt qu'une " +
    "seule grosse note fourre-tout : si un sujet a plusieurs aspects distincts (ex: \"voiture\" a un modèle, " +
    "un budget, un entretien), crée une note par sous-partie avec remember et relie-les avec [[Titre]] au " +
    "lieu de tout empiler dans une note unique. "

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
    "mémoire locale, envoyer un mail. Pour toute action concrète, tu dois IMPÉRATIVEMENT appeler l'outil correspondant via un " +
    "vrai appel de fonction, immédiatement, sans phrase d'annonce avant. Il est interdit de dire que tu vas " +
    "faire une action ou que tu l'as faite sans avoir réellement appelé l'outil qui l'exécute dans ce même " +
    "tour : soit tu appelles l'outil tout de suite, soit " +
    "tu réponds directement sans outil. Quand tu donnes une information factuelle trouvée sur le web (prix, " +
    "cours, score, statistique...), donne le chiffre précis d'une source fiable, jamais une moyenne ou une " +
    "fourchette entre plusieurs sites : choisis la donnée la plus claire et la plus récente parmi les résultats, " +
    "et précise le nom du site source. N'appelle send_email que si l'utilisateur vient de dicter, dans sa " +
    "phrase, une adresse mail précise pour le destinataire, ainsi que le contenu à envoyer. Ne mets JAMAIS " +
    "ta propre adresse d'envoi (celle configurée dans .env, que tu ne connais pas) comme destinataire, et " +
    "n'invente et ne déduis jamais une adresse toi-même : si l'adresse ou le contenu manque ou est ambigu, " +
    "n'appelle pas send_email, demande une précision à la place."
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
  const profile = await getProfile()
  const models = profile?.models ?? { flash: config.ollama.model, medium: config.ollama.model, large: config.ollama.model }
  let tier = pickTier(prompt)

  // Les paliers (flash/médium/puissant) sont figés par le scan de capacité (VRAM totale, déterministe).
  // Ici on vérifie juste, question par question, que l'état réel du GPU à l'instant présent (température,
  // VRAM effectivement libre) permet encore de lancer le modèle normalement prévu pour ce palier — sans
  // jamais changer les paliers eux-mêmes, seulement ce qui est effectivement invoqué pour cette question.
  const [live, overloadWarning] = await Promise.all([getLiveGpuStatus(), checkOverloadWarning()])
  if (overloadWarning) onLog?.(`Avertissement machine chargée : ${overloadWarning}`)

  if (live.tempC !== null && live.tempC >= GPU_TEMP_LIMIT_C && tier !== 'flash') {
    onLog?.(`GPU à ${live.tempC}°C (seuil ${GPU_TEMP_LIMIT_C}°C) : passage au palier rapide le temps qu'elle refroidisse.`)
    tier = 'flash'
  }

  let model = models[tier]
  const think = THINK_LEVEL[tier]

  if (live.freeVramGb !== null) {
    const safeModel = pickSafeModel(tier, live.freeVramGb)
    if (safeModel !== model) {
      onLog?.(`VRAM libre actuelle : ${live.freeVramGb} Go (insuffisant pour ${model}) : repli sur ${safeModel}.`)
      model = safeModel
    }
  }

  onLog?.(`Modèle choisi : ${model} (réflexion : ${think})`)

  /** Si la machine est surchargée, l'avertissement précède la vraie réponse dans la même phrase parlée. */
  const withOverloadWarning = (text: string): string => (overloadWarning ? `${overloadWarning} ${text}` : text)

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(userName, memoryTitles) },
    { role: 'user', content: prompt }
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await chatWithOllama(messages, TOOLS, model, think)
    if (!message.tool_calls?.length) {
      return withOverloadWarning(message.content.trim())
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
        return withOverloadWarning(result)
      }

      messages.push({ role: 'tool', content: result })
    }
  }

  throw new Error("Trop d'actions enchaînées, j'abandonne pour éviter de tourner en rond.")
}
