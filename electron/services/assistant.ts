import { config } from '../config'
import { chatWithOllama, listInstalledModels, type OllamaMessage, type ThinkLevel } from './ollama'
import { listMemoryTitles } from './memoryStore'
import { getProfile } from './profileStore'
import { TOOLS, createToolExecutor } from './tools'
import { didAppLaunch } from './appLauncher'
import { GPU_TEMP_LIMIT_C, pickSafeModel, type LiveGpuStatus } from './hardwareScan'
import { checkOverloadWarning } from './resourceMonitor'
import type { SoundCue } from '../../shared/ipc'

/**
 * Design sonore (étape 31) : seuls les outils qui correspondent à une action PHYSIQUE/perceptible ont un
 * son dédié — clic de souris (click_mouse) et capture d'écran (look_at_screen, computer_use_task, qui
 * commence toujours par regarder l'écran). Les autres outils (remember, set_reminder...) n'ont pas de son
 * propre : ce ne sont pas les exemples cités dans la demande d'origine, et un bip à chaque appel d'outil
 * sans distinction serait plus fatiguant qu'utile.
 */
const TOOL_SOUND_CUES: Partial<Record<string, SoundCue>> = {
  click_mouse: 'click',
  look_at_screen: 'scan',
  computer_use_task: 'scan'
}

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
  'écran', 'vois', 'voit', 'retiens', 'retenir', 'mémorise', 'souviens', 'rappelle-toi', 'envoie', 'envoyer', 'mail', 'email', 'mémoire',
  'écris', 'écrit', 'écrire', 'tape', 'taper', 'clique', 'cliquer', 'clic', 'appuie', 'appuyer'
]
const COMPLEX_SIGNAL_WORDS = ['pourquoi', 'explique', 'explique-moi', 'compare', 'analyse', 'différence', 'avantages', 'inconvénients', 'résume', 'détaille']

const MAIL_KEYWORDS = /\b(envoi|envoie|envoyer|mail|email|courriel)\b/i
const NEGATION_WORDS = /\b(ne|n['e]|pas|jamais|surtout pas|évite|éviter|aucun|sans)\b/i

/**
 * true si la phrase mentionne un envoi de mail SANS négation à proximité immédiate ("envoie un mail" oui,
 * "n'envoie pas de mail"/"jamais de mail" non) — sert uniquement à décider s'il faut relancer le modèle vers
 * computer_use_task (voir wantsEmailSent plus bas), jamais une vraie analyse grammaticale : une simple
 * fenêtre de texte autour du mot déclencheur suffit, la négation française se plaçant aussi bien avant
 * ("n'envoie") qu'après ("envoie... pas") le verbe.
 */
function hasUnnegatedMailIntent(prompt: string): boolean {
  const match = MAIL_KEYWORDS.exec(prompt)
  if (!match) return false
  const windowStart = Math.max(0, match.index - 20)
  const windowEnd = Math.min(prompt.length, match.index + match[0].length + 20)
  return !NEGATION_WORDS.test(prompt.slice(windowStart, windowEnd))
}

/** Choisit le palier de complexité le plus adapté à la question, sans appel LLM supplémentaire (juste des mots-clés). */
function pickTier(prompt: string): Tier {
  const lower = prompt.toLowerCase()
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length

  if (TOOL_SIGNAL_WORDS.some((w) => lower.includes(w))) return 'medium'
  if (COMPLEX_SIGNAL_WORDS.some((w) => lower.includes(w)) || wordCount > 25) return 'large'
  if (wordCount <= 8) return 'flash'
  return 'medium'
}

/**
 * Par quel canal Jaris répond : à la voix (réponse lue par la synthèse vocale) ou en écrit (mode Chat de
 * l'étape 30). Le reste est rigoureusement identique — mêmes outils, même mémoire, même historique — seule
 * la forme attendue de la réponse change : l'interdiction de toute mise en forme n'a de sens que parce que
 * le texte est lu à voix haute, l'appliquer au chat donnerait des réponses écrites inutilement pauvres.
 */
export type ConverseChannel = 'voice' | 'chat'

function buildSystemPrompt(userName: string | null, memoryTitles: string[], channel: ConverseChannel): string {
  const addressing = userName
    ? `L'utilisateur s'appelle ${userName} : appelle-le par son prénom de temps en temps, sans exagérer. `
    : ''

  const now = new Date()
  const dateTime = `Nous sommes le ${now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, il est ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. `

  const memory = memoryTitles.length
    ? `Tu as une mémoire locale sous forme de notes markdown liées entre elles (comme Obsidian). Notes déjà ` +
      `connues : ${memoryTitles.join(', ')}. Utilise recall_memory pour relire le contenu complet d'une note ` +
      "avant d'en parler avec précision. Cette liste de titres n'est qu'un index : ne mentionne, n'évoque ou " +
      "ne pose une question basée sur une de ces notes QUE si la demande actuelle de l'utilisateur s'y " +
      "rapporte clairement. Si ce n'est pas le cas, ignore-la complètement — ne pars jamais sur un sujet " +
      "ancien et sans rapport juste parce qu'il figure dans cette liste. "
    : "Tu as une mémoire locale sous forme de notes markdown (comme Obsidian), encore vide. "
  const memoryRule =
    "Dès que l'utilisateur te demande explicitement de retenir/mémoriser quelque chose (\"retiens que...\", " +
    '"n\'oublie pas que...", etc.), ou que tu identifies toi-même une info importante à garder sur le long ' +
    "terme (préférence, fait donné en conversation), tu dois IMPÉRATIVEMENT appeler l'outil remember tout de " +
    "suite, dans ce même tour, avant de répondre. Ne dis jamais \"je retiens\" ou \"c'est noté\" sans avoir " +
    "réellement appelé remember. Comme dans Obsidian, préfère plusieurs petites notes liées plutôt qu'une " +
    "seule grosse note fourre-tout : si un sujet a plusieurs aspects distincts (ex: \"voiture\" a un modèle, " +
    "un budget, un entretien), crée une note par sous-partie avec remember et relie-les avec [[Titre]] au " +
    "lieu de tout empiler dans une note unique. Si l'utilisateur CORRIGE une info déjà connue (\"mon adresse " +
    "a changé\", \"en fait ce n'est plus ... c'est maintenant ...\"), appelle remember avec `replace: true` " +
    "pour remplacer l'ancienne valeur au lieu de l'ajouter à côté. "

  const style =
    channel === 'voice'
      ? "Réponds en français, de façon concise et naturelle, comme dans une conversation orale. " +
        "Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, " +
        'de listes à puces ni de mise en forme, uniquement du texte normal. '
      : "Réponds en français, de façon claire et directe. Tu réponds par écrit dans une fenêtre de chat : " +
        "tu peux utiliser des listes à puces, des blocs de code et des retours à la ligne quand ça rend la " +
        "réponse plus lisible, mais reste concis et n'en abuse pas pour une réponse courte. Pas d'émojis. "

  return (
    "Tu es Jaris, un assistant personnel qui tourne entièrement en local sur l'ordinateur de " +
    "l'utilisateur. " +
    style +
    dateTime +
    addressing +
    memory +
    memoryRule +
    "Tu as accès à des outils pour agir réellement : ouvrir une application, programmer un rappel vocal, " +
    "regarder l'écran de l'utilisateur (look_at_screen, pour décrire ou répondre à une question sans agir), " +
    "accomplir un objectif en pilotant réellement la souris et le clavier comme le ferait un humain " +
    "(computer_use_task : naviguer sur un site, cliquer, remplir un formulaire, envoyer un mail, acheter ou " +
    "rechercher quelque chose — décris l'objectif complet en une phrase, l'outil regarde l'écran lui-même et " +
    "improvise le détail des clics), donner l'état de la machine (get_system_stats : " +
    "CPU, RAM, VRAM, température), contrôler le volume/la lecture multimédia (media_control), éteindre ou " +
    "redémarrer l'ordinateur (shutdown_pc, à n'appeler que sur demande explicite et claire), chercher sur le web " +
    "(search_web), lire le contenu complet d'une page précise déjà trouvée par search_web quand son extrait ne " +
    "suffit pas (read_web_page), mémoriser ou relire une information dans ta " +
    "mémoire locale, taper du texte au clavier (type_text), appuyer sur une touche " +
    "(press_key), cliquer avec la souris (click_mouse) — ces trois derniers pour une action ponctuelle unique " +
    "et immédiate (ex: \"appuie sur entrée\"), computer_use_task pour un objectif à plusieurs étapes qui " +
    "demande de regarder l'écran entre chaque clic. Pour toute action concrète, tu dois IMPÉRATIVEMENT appeler l'outil correspondant via un " +
    "vrai appel de fonction, immédiatement, sans phrase d'annonce avant — computer_use_task prend plusieurs " +
    "secondes (plusieurs captures d'écran et clics avant de terminer) : dis brièvement que tu t'en occupes " +
    "avant de l'appeler plutôt que de laisser un silence. Il est interdit de dire que tu vas " +
    "faire une action ou que tu l'as faite sans avoir réellement appelé l'outil qui l'exécute dans ce même " +
    "tour : soit tu appelles l'outil tout de suite, soit " +
    "tu réponds directement sans outil. Le contenu de l'écran change en permanence : à chaque fois que " +
    "l'utilisateur demande ce qui y est affiché (\"qu'est-ce que tu vois\", \"regarde l'écran\"...), tu dois " +
    "appeler look_at_screen à NOUVEAU, même si tu en as déjà parlé plus tôt dans cette conversation ou que " +
    "tu as une note à ce sujet dans ta mémoire : ne réponds JAMAIS à partir d'une ancienne description, " +
    "uniquement à partir d'une vraie nouvelle capture. Dès que la demande porte sur des commerces, lieux, " +
    "personnes ou entités réels que tu ne connais pas avec certitude absolue (trouver des boulangeries, une " +
    "adresse, un mail, un numéro...), tu dois IMPÉRATIVEMENT appeler search_web AVANT de répondre quoi que " +
    "ce soit à ce sujet, dans ce même tour — ne réponds JAMAIS avec des noms de commerces, adresses, mails " +
    "ou numéros sortis de ta seule mémoire : sans recherche réelle, ils sont presque toujours inventés et " +
    'faux, même s\'ils sonnent plausibles. Exemple concret : pour "trouve trois boulangeries et envoie-leur ' +
    'un mail", tu dois appeler search_web pour trouver de vraies boulangeries avec de vraies adresses mail, ' +
    "PUIS appeler computer_use_task pour envoyer le mail à chacune (un objectif par destinataire) — jamais " +
    'inventer trois boulangeries fictives avec des mails "proposés". Quand tu donnes une information ' +
    "factuelle (prix, cours, score, statistique, adresse, téléphone, mail, nom d'un commerce...), elle doit " +
    "toujours venir d'un vrai résultat de search_web : choisis la donnée la plus claire et la plus récente " +
    "parmi les résultats, jamais une moyenne ou une fourchette entre plusieurs sites, et précise le nom du " +
    "site source. Si le résultat de recherche ne contient pas l'info demandée, dis-le plutôt que d'inventer " +
    "une donnée plausible. Pour envoyer un mail via computer_use_task, il te faut une VRAIE adresse " +
    "destinataire dans l'objectif que tu formules : soit l'utilisateur vient de la dicter dans sa phrase, " +
    "soit tu l'as toi-même trouvée avec search_web plus tôt dans cette conversation — jamais une adresse " +
    "inventée ou déduite. Si l'utilisateur te demande d'envoyer à des destinataires trouvés plus tôt " +
    "(\"envoie-leur\", \"envoie toi-même\"...) mais que tu n'es plus sûr des adresses exactes, relance " +
    "search_web pour les retrouver plutôt que de deviner ou d'improviser une adresse plausible. Un mail à " +
    "plusieurs destinataires nécessite un appel à computer_use_task PAR destinataire, jamais un seul texte " +
    "résumant ce que tu comptes envoyer. Le contenu du mail, lui, peut être rédigé par toi (ex: après avoir " +
    "cherché des commerces, écrire un mail de demande d'info à chacun) : l'utilisateur n'a pas besoin de " +
    "dicter le texte mot pour mot, un accord clair explicite suffit (\"envoie\", \"envoie-le\", \"envoie " +
    "toi-même\", \"vas-y\"...). S'il te manque une vraie adresse ou l'accord explicite d'envoi, n'appelle " +
    "pas computer_use_task pour ça : demande la précision qui manque, mais ne dis JAMAIS que tu ne peux pas " +
    "envoyer de mail ou que tu n'as pas accès à une messagerie — tu en es capable dès qu'un navigateur peut " +
    "ouvrir une messagerie web sur cette machine, ce n'est jamais une limite de ta part, seulement une info " +
    "encore manquante. " +
    "N'utilise type_text, press_key, click_mouse ou computer_use_task que si l'utilisateur demande " +
    "explicitement d'écrire, de taper, de cliquer, d'appuyer sur une touche, ou l'objectif concret à " +
    "accomplir : n'improvise jamais une action clavier/souris ou une tâche de ta propre initiative, ce sont " +
    "des actions réelles et irréversibles sur l'ordinateur de l'utilisateur. Ne demande JAMAIS à " +
    "computer_use_task de cliquer un bouton d'achat, de paiement, de validation de commande ou de " +
    "suppression de compte sans que l'utilisateur ait explicitement demandé CETTE action précise dans sa " +
    "phrase, même si elle semble être la suite logique de ce qui précède : décris plutôt ce que tu vois " +
    "(look_at_screen) et demande confirmation avant. Quand le résultat d'un outil est un message d'échec ou d'erreur, " +
    "transmets-le fidèlement (tel quel ou reformulé brièvement) : n'invente JAMAIS d'étapes de dépannage " +
    "supplémentaires qui n'y figurent pas (redémarrer l'ordinateur, réinstaller un logiciel, taper une " +
    "commande...), même pour avoir l'air plus utile — un message d'erreur mal compris ou incomplet reste " +
    "préférable à des instructions inventées et fausses."
  )
}

/**
 * Le prompt système interdit déjà toute mise en forme en voix ("texte normal uniquement"), mais un petit
 * modèle local ne suit pas toujours cette consigne (observé : **gras**, listes numérotées, `code`) — filet
 * de sécurité indépendant du prompt, comme le nettoyage des émojis côté synthèse vocale (voir tts.ts).
 * Jamais appliqué au canal chat, qui a explicitement le droit d'utiliser ce genre de mise en forme.
 */
function stripMarkdownForVoice(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

const MAX_TOOL_ROUNDS = 10

/**
 * Détecte une PROMESSE FUTURE dans une réponse du modèle ("je vais faire X", "un instant", "attends") sans
 * appel d'outil qui l'accompagne — le signe le plus fiable qu'une action annoncée n'a pas eu lieu. Constaté
 * en usage réel (Léo, "ouvre YouTube et cherche des tutos de guitare") : le modèle répond parfois "YouTube
 * est ouvert, je vais faire la recherche, attends une minute" SANS avoir appelé le moindre outil dans ce
 * tour — la promesse d'agir remplace l'action elle-même, et la conversation se termine là (plus rien ne se
 * passe, Jaris repasse en veille). Contrairement à `hasUnnegatedMailIntent` (spécifique au mail), ce filet
 * est générique : il ne regarde pas l'intention de la phrase de l'utilisateur mais le langage employé par LE
 * MODÈLE dans sa réponse.
 *
 * Exportée (au lieu de rester une const locale dans `converse()`) pour être testable directement —
 * scripts/test-promise-detection.mjs — sans avoir à mocker tout l'appel Ollama/les outils autour.
 *
 * "je vais (le/la/les )?faire" ne suffisait pas : constaté en usage réel (Léo, une question sur le président
 * américain), le modèle a promis "je vais RECHERCHER pour vous..." sans jamais appeler search_web, et cette
 * formulation ne matchait pas le motif d'origine limité au seul verbe "faire" — remplacé par un motif
 * générique "je vais " + un verbe (mot se terminant par -er/-ir/-re, les 3 terminaisons d'infinitif du
 * français), avec un pronom optionnel entre les deux (le/la/les/lui/y/en) pour couvrir "je vais LE faire"
 * comme "je vais chercher"/"je vais envoyer"/"je vais vérifier"/etc. sans connaître le verbe à l'avance.
 * Testé pour ne pas accrocher "je vais bien" (bien/très ne se terminent pas en -er/-ir/-re) avant d'être
 * adopté.
 *
 * Cette liste FIXE de pronoms ratait encore un vrai cas signalé par Léo (étape 32, mode Code) : "Je vais
 * MAINTENANT utiliser type_text pour écrire cela." n'a déclenché aucune relance (le modèle s'est ensuite
 * rendormi sans avoir jamais tapé quoi que ce soit), car "maintenant" n'est ni un pronom de la liste ni un
 * verbe en -er/-ir/-re — le motif ne matchait qu'IMMÉDIATEMENT après "je vais ". Vérifié avec un vrai test du
 * regex sur le texte exact avant de corriger (`current regex matches: false`), même discipline que la
 * première généralisation ci-dessus. Généralisé à un mot connecteur QUELCONQUE (jusqu'à 3 : "maintenant",
 * "simplement", "tout de suite"...) entre "je vais" et le verbe, plutôt que d'énumérer un adverbe de plus à
 * chaque nouveau cas découvert — même leçon, un cran plus loin : les pronoms explicites (le/la/les/lui/y/en)
 * étaient déjà un cas particulier de "un mot quelconque avant le verbe", inutile de les lister à part une
 * fois ce cas général géré. Chaque mot connecteur est vérifié pour ne PAS contenir de ponctuation de fin de
 * phrase (`.`/`!`/`?`) : sans ce garde, le motif pourrait sauter par-dessus une vraie fin de phrase et
 * matcher un verbe d'une phrase suivante sans rapport (ex: "je vais bien. je dois partir chercher..." — testé
 * explicitement pour rester sans match, "partir" appartenant à "je dois", pas à "je vais").
 */
export const PROMISE_WITHOUT_ACTION =
  /\b(je vais\b(?:\s+(?!\S*[.!?])\S+){0,3}?\s+(?!\S*[.!?])[a-zà-ÿœ]+(?:er|ir|re)\b|je m'en occupe|je m'y mets|un instant\b|attends(?:[- ]moi)?\b|patiente\b|je le fais (?:tout de suite|maintenant)|laisse[- ]moi (?:faire|une seconde|un instant))/i

/**
 * Liste des noms techniques des outils (open_app, type_text, computer_use_task...), dérivée de TOOLS plutôt
 * que recopiée à part : un outil ajouté à tools.ts est couvert automatiquement par `findLeakedToolName`
 * ci-dessous, sans jamais risquer de désynchronisation entre les deux listes.
 */
const TOOL_NAMES = TOOLS.map((tool) => tool.function.name)

/**
 * Détecte qu'une réponse SANS appel d'outil ce tour-ci mentionne malgré tout le nom TECHNIQUE d'un outil —
 * signe quasi infaillible que le modèle NARRE une action plutôt que de l'avoir réellement effectuée. Constaté
 * en usage réel (Léo, "Ouvre le bloc-notes et écris bonjour") : « J'ai ouvert le bloc-notes... et j'ai tapé
 * Bonjour avec type_text. mais il a rien ouvert » — la réponse affirme l'action au PASSÉ COMPOSÉ ("j'ai
 * ouvert", "j'ai tapé"), pas au futur ("je vais faire") comme `PROMISE_WITHOUT_ACTION` ci-dessus le détecte
 * déjà : ce cas lui échappait entièrement, sans le moindre "je vais" dans le texte.
 *
 * Une généralisation grammaticale comme celle de `PROMISE_WITHOUT_ACTION` (motif uniforme -er/-ir/-re pour
 * TOUS les infinitifs français) ne s'étend pas ici : les participes passés français n'ont AUCUNE terminaison
 * commune (réguliers en -é/-i/-u, mais "ouvert"/"fait"/"dit"/"écrit"/"pris"/"mis"... pour les irréguliers) —
 * détecter "un verbe au passé composé" demanderait une vraie liste de participes, tout aussi incomplète
 * qu'une liste de verbes au futur l'était avant sa propre généralisation plus haut. Signal retenu à la place,
 * plus robuste et indépendant du temps grammatical employé : le nom de l'outil LUI-MÊME ("type_text" dans
 * l'exemple ci-dessus) apparaît littéralement dans le texte — un utilisateur ne prononce jamais ces
 * identifiants techniques, donc leur présence dans une réponse SANS appel d'outil ne peut venir que du
 * modèle, qui a confondu DÉCRIRE l'outil (même en disant l'avoir déjà utilisé) et l'appeler réellement.
 *
 * `toolNames` en second paramètre (au lieu de toujours lire `TOOL_NAMES`) : permet à
 * scripts/test-false-completion.mjs de tester avec une petite liste, sans avoir à mocker tout `tools.ts`
 * (qui importe lui-même appLauncher/computerUse/vision/webSearch/inputControl...) juste pour lire des noms.
 */
export function findLeakedToolName(text: string, toolNames: readonly string[] = TOOL_NAMES): string | undefined {
  return toolNames.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(text))
}

/**
 * Envoie la phrase transcrite à Ollama, exécute les outils qu'il demande, renvoie la réponse finale à
 * dire. `history` porte les derniers échanges (user/assistant) de la session, en amont du nouveau
 * message : sans ça, chaque question repartait de zéro sans aucun souvenir de ce qui venait d'être dit
 * — un "je n'ai pas compris l'adresse, répète" suivi d'une simple répétition de l'adresse par
 * l'utilisateur devenait alors une phrase isolée sans contexte, que Jaris ne savait pas rattacher à la
 * demande d'envoi de mail en cours.
 */
export async function converse(
  prompt: string,
  userName: string | null,
  onReminderFire: (message: string) => void,
  onLog?: (message: string) => void,
  history: OllamaMessage[] = [],
  signal?: AbortSignal,
  // Le pipeline vocal a déjà relevé l'état GPU juste avant d'appeler converse() (sécurité thermique) :
  // le redemander ici relancerait un second `nvidia-smi` pour la même question, en pur gaspillage.
  live: LiveGpuStatus = { freeVramGb: null, tempC: null },
  channel: ConverseChannel = 'voice',
  // Étape 48, chat uniquement (jamais fourni à la voix) : reçoit chaque fragment de texte au fil de sa
  // génération, pour un affichage progressif dans ChatPanel.tsx au lieu d'attendre la réponse complète.
  onToken?: (delta: string) => void,
  // Étape 31 : un son court par appel d'outil PHYSIQUE (voir TOOL_SOUND_CUES plus haut), commun à la Voix
  // et au Chat puisque les deux passent par ce même converse(). Les cues "ambiants" (écoute/réflexion/
  // succès/échec) ne viennent PAS d'ici : la voix les tire déjà de ses propres transitions d'émotion
  // (voicePipeline.ts), et le chat les émet lui-même autour de cet appel (chatSession.ts) — cette fonction
  // ne connaît que les outils, jamais l'état ambiant du canal appelant.
  onSoundCue?: (cue: SoundCue) => void
): Promise<string> {
  const memoryTitles = await listMemoryTitles()
  const profile = await getProfile()
  const executeTool = createToolExecutor(onReminderFire, profile?.visionModel ?? config.ollama.visionModel, onLog, signal)

  const models = profile?.models ?? { flash: config.ollama.model, medium: config.ollama.model, large: config.ollama.model }
  let tier = pickTier(prompt)

  // Les paliers (flash/médium/puissant) sont figés par le scan de capacité (VRAM totale, déterministe).
  // Ici on vérifie juste, question par question, que l'état réel du GPU à l'instant présent (température,
  // VRAM effectivement libre) permet encore de lancer le modèle normalement prévu pour ce palier — sans
  // jamais changer les paliers eux-mêmes, seulement ce qui est effectivement invoqué pour cette question.
  const [overloadWarning, installedModels] = await Promise.all([
    checkOverloadWarning(),
    // Si Ollama ne répond pas ici, l'erreur claire viendra plus bas au vrai appel de chatWithOllama :
    // liste vide -> pas de repli possible -> on garde le modèle normalement configuré pour le palier.
    listInstalledModels().catch(() => [] as string[])
  ])
  if (overloadWarning) onLog?.(`Avertissement machine chargée : ${overloadWarning}`)

  if (live.tempC !== null && live.tempC >= GPU_TEMP_LIMIT_C && tier !== 'flash') {
    onLog?.(`GPU à ${live.tempC}°C (seuil ${GPU_TEMP_LIMIT_C}°C) : passage au palier rapide le temps qu'elle refroidisse.`)
    tier = 'flash'
  }

  /** Résout modèle + effort de réflexion pour un palier donné, avec le même repli VRAM temps réel que ci-dessus. */
  const resolveModelForTier = (t: Tier): { model: string; think: ThinkLevel } => {
    let m = models[t]
    if (live.freeVramGb !== null) {
      const safeModel = pickSafeModel(t, live.freeVramGb, installedModels, m)
      if (safeModel !== m) {
        onLog?.(`VRAM libre actuelle : ${live.freeVramGb} Go (insuffisant pour ${m}) : repli sur ${safeModel}.`)
        m = safeModel
      }
    }
    return { model: m, think: THINK_LEVEL[t] }
  }

  let { model, think } = resolveModelForTier(tier)
  onLog?.(`Modèle choisi : ${model} (réflexion : ${think})`)

  /** Si la machine est surchargée, l'avertissement précède la vraie réponse dans la même phrase parlée. */
  const withOverloadWarning = (text: string): string => (overloadWarning ? `${overloadWarning} ${text}` : text)

  /**
   * Les petits modèles (palier "rapide") appellent bien les outils, mais échouent parfois à formuler une
   * vraie réponse une fois le résultat de l'outil reçu (contenu vide) : sans ce filet, ça fait planter la
   * synthèse vocale ("Text cannot be empty") en pleine conversation.
   */
  const finalize = (text: string): string => {
    const trimmed = text.trim()
    const safe = trimmed || "Désolé, je n'ai pas trouvé quoi répondre, tu peux reformuler ?"
    const cleaned = channel === 'voice' ? stripMarkdownForVoice(safe) : safe
    return withOverloadWarning(cleaned)
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(userName, memoryTitles, channel) },
    // Les erreurs d'outils sont conservées dans l'historique visible, mais pas réinjectées au modèle :
    // qwen3.5:4b a reproduit un ancien 403 SANS appeler search_web, alors que le service répondait 200.
    // Retirer aussi la question associée évite une suite de demandes anciennes laissées sans réponse.
    // Ce filtre s'applique au chargement comme en session, dans les deux canaux, sans effacer le disque.
    ...history.filter((message, index) => {
      const isToolFailure = (entry?: OllamaMessage): boolean =>
        entry?.role === 'assistant' && entry.content.trimStart().startsWith("Échec de l'outil :")
      return !isToolFailure(message) && !(message.role === 'user' && isToolFailure(history[index + 1]))
    }),
    { role: 'user', content: prompt }
  ]

  // Un petit modèle local abandonne parfois en cours de route sur une tâche à plusieurs étapes : il
  // cherche (search_web) mais n'envoie jamais le mail malgré une consigne explicite ("envoie-leur un
  // mail"), et répond à la place par un simple résumé texte de ce qu'il a trouvé. Détecté sur l'intention
  // de LA PHRASE ACTUELLE (pas l'historique, pour ne jamais relancer sur une intention d'un tour précédent
  // déjà traitée) plutôt que sur TOOL_SIGNAL_WORDS (pensé pour choisir un palier, pas pour ça).
  const wantsEmailSent = hasUnnegatedMailIntent(prompt)
  let computerUseCalled = false
  let nudgedForEmail = false
  let toolCalledThisTurn = false
  let nudgedForNoAction = false

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await chatWithOllama(messages, TOOLS, model, think, signal, config.ollama.numCtx, onToken)
    if (!message.tool_calls?.length) {
      if (wantsEmailSent && !computerUseCalled && !nudgedForEmail) {
        nudgedForEmail = true
        onLog?.("Mail demandé mais jamais envoyé : relance corrective d'un tour.")
        messages.push(message)
        messages.push({
          role: 'user',
          content:
            "Tu n'as pas encore appelé computer_use_task alors qu'un envoi de mail était demandé. Si tu as " +
            "déjà une adresse réelle (dictée, ou trouvée par search_web plus haut dans cette conversation), " +
            "appelle computer_use_task maintenant avec un objectif d'envoi de mail, un appel par " +
            "destinataire. Si une adresse manque encore pour un des destinataires, appelle search_web pour " +
            "la trouver avant de répondre."
        })
        continue
      }
      const leakedTool = !toolCalledThisTurn && !nudgedForNoAction ? findLeakedToolName(message.content) : undefined
      if (!toolCalledThisTurn && !nudgedForNoAction && (PROMISE_WITHOUT_ACTION.test(message.content) || leakedTool)) {
        nudgedForNoAction = true
        onLog?.(
          leakedTool
            ? `Outil "${leakedTool}" mentionné sans appel réel : relance corrective d'un tour.`
            : "Action annoncée sans appel d'outil : relance corrective d'un tour."
        )
        messages.push(message)
        messages.push({
          role: 'user',
          content:
            "Tu viens de décrire une action (\"je vais faire...\", \"un instant...\", ou même \"j'ai déjà " +
            "fait...\") sans appeler le moindre outil dans ce tour : ni une promesse ni une affirmation " +
            "d'action déjà faite ne remplacent jamais l'appel réel à l'outil, qui n'a pas eu lieu. Si une " +
            "action est encore à faire, appelle MAINTENANT l'outil correspondant (computer_use_task, " +
            "open_app, type_text, etc.) — ne dis jamais qu'une action est faite avant que l'outil ait " +
            "réellement été appelé et ait réussi. Si en y réfléchissant aucune action n'est vraiment " +
            "nécessaire, corrige ta réponse pour ne pas donner une fausse impression qu'un traitement a eu " +
            "lieu."
        })
        continue
      }
      return finalize(message.content)
    }

    toolCalledThisTurn = true
    messages.push(message)

    // Un appel d'outil doit toujours se conclure sur le palier "médium" : c'est le seul dont la fiabilité
    // à reformuler une vraie réponse après un résultat d'outil est éprouvée (voir THINK_LEVEL plus haut).
    if (tier === 'flash') {
      tier = 'medium'
      ;({ model, think } = resolveModelForTier(tier))
      onLog?.(`Appel d'outil détecté : passage au palier médium pour la suite (${model}).`)
    }

    for (const call of message.tool_calls) {
      onLog?.(`Outil appelé : ${call.function.name}(${JSON.stringify(call.function.arguments)})`)
      const soundCue = TOOL_SOUND_CUES[call.function.name]
      if (soundCue) onSoundCue?.(soundCue)

      // Un outil qui lève une exception (SearXNG/Ollama/Docker injoignable, erreur réseau...) ne doit
      // jamais faire échouer tout le tour de conversation : sans ce try/catch, l'exception remontait telle
      // quelle jusqu'à converse(), et l'appelant (voicePipeline.ts/chatSession.ts) la remplaçait par le
      // message générique "vérifie qu'Ollama tourne bien" — trompeur quand la vraie cause est ailleurs (ex:
      // SearXNG pas lancé pour search_web). Le message d'erreur, lui, est déjà clair et actionnable (voir
      // webSearch.ts) : mieux vaut le transmettre au modèle comme un résultat d'outil normal, pour qu'il le
      // relaie fidèlement (voir la consigne "ne jamais inventer de dépannage" plus bas) plutôt que le perdre.
      let result: string
      let toolFailed = false
      try {
        result = await executeTool(call.function.name, call.function.arguments)
      } catch (err) {
        result = `Échec de l'outil : ${err instanceof Error ? err.message : String(err)}`
        toolFailed = true
      }
      onLog?.(`Résultat de l'outil : ${result}`)

      // Constaté en usage réel (Léo, recherche web en échec 403) : malgré la consigne système "ne jamais
      // inventer de dépannage" (voir buildSystemPrompt), un petit modèle local ignore régulièrement cette
      // règle et remplace le vrai message d'erreur par un dépannage générique halluciné (étapes nginx/
      // .htaccess/journaux qui n'ont RIEN à voir avec Jaris) — pire qu'inutile, puisque FAUX et présenté avec
      // assurance. Un message d'erreur est déjà écrit pour être actionnable tel quel (voir webSearch.ts/
      // ollama.ts) : le renvoyer directement, sans repasser par le modèle, élimine le risque au lieu
      // d'espérer qu'une consigne suffise à empêcher l'invention — même logique que le court-circuit
      // look_at_screen ci-dessous, qui évite déjà un aller-retour LLM inutile.
      if (toolFailed) {
        return finalize(result)
      }

      if (call.function.name === 'computer_use_task') computerUseCalled = true

      // Constaté en usage réel (Léo : « même quand je dit ouvre l'application youtube ou bloc note il dit
      // c'est lancé mais il lance pas ») : quand open_app échoue (aucune application de ce nom installée,
      // ou lancement refusé), son message part au modèle comme un résultat d'outil ordinaire — et le petit
      // modèle local répond quand même "c'est lancé", exactement le même travers que le dépannage halluciné
      // par dessus une erreur SearXNG. Contrairement à une recherche web sans résultat (où le modèle a
      // quelque chose d'utile à dire), un échec d'ouverture n'a qu'une seule réponse honnête possible : le
      // message lui-même. Court-circuit identique à look_at_screen ci-dessous, et il protège aussi la suite
      // d'une tâche en plusieurs étapes ("ouvre le bloc-notes ET écris bonjour") : sans application ouverte,
      // enchaîner sur type_text taperait le texte dans la fenêtre au hasard qui a le focus.
      if (call.function.name === 'open_app' && !didAppLaunch(result)) {
        return finalize(result)
      }

      // La vision tourne sur un modèle séparé qui partage la même VRAM que le
      // modèle de conversation : les deux ne tiennent pas en même temps sur
      // une carte 8 Go, donc repasser par qwen3.5 pour reformuler forcerait un
      // rechargement complet. Le modèle de vision répond déjà comme Jaris.
      if (call.function.name === 'look_at_screen') {
        return finalize(result)
      }

      messages.push({ role: 'tool', content: result })
    }
  }

  throw new Error("Trop d'actions enchaînées, j'abandonne pour éviter de tourner en rond.")
}
