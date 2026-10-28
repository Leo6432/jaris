import { resolveChosenModel } from './modelChoice'
import { notepadRequest, openNotepadText } from './notepad'
import { config } from '../config'
import { chatWithOllama, getModelThinking, listInstalledModels, loadedOllamaModels, type ChatMetrics, type OllamaMessage, type ThinkLevel } from './ollama'
import { chosenThink, thinkLabel, type ThinkValue } from '../../shared/effort'
import { listMemoryTitles } from './memoryStore'
import { getProfile } from './profileStore'
import { TOOLS, createToolExecutor, type ImageHandler, type WebActivityHandler } from './tools'
import { didAppLaunch, launchedAppName } from './appLauncher'
import { GPU_TEMP_LIMIT_C, isScreenQuestion, pickSafeModel, type LiveGpuStatus } from './hardwareScan'
import { checkOverloadWarning } from './resourceMonitor'
import type { SoundCue } from '../../shared/ipc'
import { buildSystemPrompt, dateTimeNote, type ConverseChannel } from './systemPrompt'
import { describeModelCall, startJournalEntry, type JournalEntry } from './requestJournal'
import { directBrowserSearch, openBrowserSearch } from './browserSearch'
import { allTranslations, currentLanguage, currentLocale, t } from '../../shared/i18n'
import { languageInfo } from '../../shared/i18n/languages'

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

/** Commande simple explicite : exécuter l'outil sans dépendre d'une décision du modèle. */
export function directAppRequest(prompt: string): string | undefined {
  const match = prompt.trim().match(/^ouvre\s+(?:l[’']application\s+)?([\p{L}\p{N}][\p{L}\p{N} .’'_-]{0,79}?)[.!]?$/iu)
  const name = match?.[1].trim()
  // Les demandes composées, négations et explications restent dans la conversation normale. Étape 346 : une seconde
  // phrase aussi (« ouvre le bloc-notes. Écris bonjour ») — sinon tout passait pour un nom d'application.
  if (!name || /\b(?:et|puis|ensuite|mais|sans|pas|jamais|si|pour|avec)\b/i.test(name) || /\.\s/.test(name)) return undefined
  return name
}

/**
 * Étape 252 : « clique sur la première vidéo » — une action à l'écran, explicite, qui ne peut aller qu'au pilotage.
 * Journal de Léo (06/10/2026) : le modèle de conversation réfléchissait 40 s à 2 min avant de choisir l'outil, sans
 * rien montrer ; il a abandonné au bout d'une minute, le pilotage n'ayant même pas commencé. La phrase entière
 * devient l'objectif du pilotage. Elle doit COMMENCER par le verbe : « ne clique pas… » ne peut pas correspondre.
 */
export function directScreenTask(prompt: string): string | undefined {
  const text = prompt.trim().replace(/\s+/g, ' ')
  // « sur » ou « dans » doit suivre directement le verbe : « clique pas sur… » ne correspond donc pas non plus.
  // Étape 255 : un lieu peut précéder, séparé par une virgule — « Sur YouTube, clique sur la barre de recherche… »
  // (phrase réelle de Léo, qui passait sinon par 1 min de réflexion du modèle de conversation).
  if (!/^(?:(?:sur|dans)\s+[^,]{1,40},\s*)?(?:double[- ]?)?(?:clique|cliques|clic|cliquer)\s+(?:sur|dans)\s+\S/iu.test(text) || text.length > 200) return undefined
  return text
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

// Étape 261 : un VERBE d'envoi, plus le seul mot « mail » — « Reformule ce mail : … » n'est pas une demande d'envoi.
const SEND_MAIL_VERBS = /\b(envoi|envoie|envoies|envoyer|envoyez|expédie|expédier)\b/i
const NEGATION_WORDS = /\b(ne|n['e]|pas|jamais|surtout pas|évite|éviter|aucun|sans)\b/i
// Étape 346 : l'envoi doit porter sur un mail ou un message (« envoie-moi un rappel » n'en est pas un), et ni un rappel,
// ni une note, ni un envoi déjà fait, ni une question sur la façon d'envoyer ne demandent d'envoyer quoi que ce soit.
const MAIL_OBJECT = /\b(?:mail|mails|e-mail|e-mails|email|emails|courriel|courriels|message|messages)\b/i
const NOT_A_SEND_REQUEST =
  /^\s*(?:rappelle[- ]moi|retiens|n['’]oublie pas|mémorise|memorise|note que|(?:est-ce que )?tu sais|sais-tu|comment|explique(?:[- ]moi)?)\b|\b(?:viens|vient|venons|venez|viennent) d['’]envoyer\b/i

/**
 * Étape 262 : la demande est-elle de RÉDIGER un texte (reformuler, corriger, répondre à un client…) ? Le texte rédigé
 * peut alors contenir lui-même « je vais… » — « Je vais personnellement suivre son acheminement. Cordialement, Marc » —
 * que le filet « promesse sans action » prenait pour une action annoncée et non faite (vérifié avec le vrai détecteur) :
 * la relance faisait répondre au modèle une justification à la place du mail. Seule la CONSIGNE est lue (avant « : »,
 * « « » ou un retour à la ligne), sans accents ni majuscules : « Aide moi a repondre a ce client » compte aussi.
 */
const WRITING_REQUEST =
  /^\s*(?:(?:peux|pourrais|pourrait|peut)[- ]tu |tu peux |stp |s'il te plait )?(?:reformule|reecris|redige|corrige|traduis|ameliore|rends(?:[- ]moi)? (?:ce|cet|cette|mon|ma|mes|le|la|les|son|sa) (?:mail|e-?mail|message|texte|lettre|courrier|phrase|paragraphe|reponse)\b|resume|aide[- ]moi a (?:repondre|ecrire|rediger|reformuler|formuler)|reponds? a (?:ce|cet|cette|mon|ma|mes|son|sa|ses|un|une)\b|ecris(?:[- ]moi)? (?:un|une|le|la|mon|ma|ce|cette)\s+(?:mail|e-?mail|message|lettre|courrier|reponse|texte|sms|post|discours|invitation|annonce|compte rendu|resume|cv|lettre de motivation)\b)/

function isWritingRequest(prompt: string): boolean {
  const instruction = prompt.split(/[:«\n]/)[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return WRITING_REQUEST.test(instruction)
}

/**
 * true si la phrase mentionne un envoi de mail SANS négation à proximité immédiate ("envoie un mail" oui,
 * "n'envoie pas de mail"/"jamais de mail" non) — sert uniquement à décider s'il faut relancer le modèle vers
 * computer_use_task (voir wantsEmailSent plus bas), jamais une vraie analyse grammaticale : une simple
 * fenêtre de texte autour du mot déclencheur suffit, la négation française se plaçant aussi bien avant
 * ("n'envoie") qu'après ("envoie... pas") le verbe.
 */
function hasUnnegatedMailIntent(prompt: string): boolean {
  // Seule la CONSIGNE compte, pas le texte collé après « : » ou « « » : « Reformule ce mail : … merci de m'envoyer le
  // devis » ne demande aucun envoi (étape 261, mesuré : la relance renvoyait le modèle vers l'envoi par le pilote).
  const instruction = prompt.split(/[:«\n]/)[0]
  if (!MAIL_OBJECT.test(instruction) || NOT_A_SEND_REQUEST.test(instruction)) return false
  const match = SEND_MAIL_VERBS.exec(instruction)
  if (!match) return false
  const windowStart = Math.max(0, match.index - 20)
  const windowEnd = Math.min(instruction.length, match.index + match[0].length + 20)
  return !NEGATION_WORDS.test(instruction.slice(windowStart, windowEnd))
}

// Léo : "fait en sorte qu'il regarde tout le temps sur le web ... il ne doit pas répondre depuis sa base de
// données car les modèles sont trop vieux" — le prompt système (voir plus bas) le demande déjà explicitement,
// mais exactement comme pour wantsEmailSent ci-dessous, une simple consigne ne suffit pas toujours à un petit
// modèle local : une relance corrective mécanique rattrape les cas où il répond quand même de mémoire.
const QUESTION_START_WORDS =
  /^(qui|que|qu['’]|quoi|quel|quelle|quels|quelles|quand|où|comment|pourquoi|combien|c['’]est quoi|est-ce que|est-ce qu['’])\b/i
// Une demande d'info peut aussi être une commande à l'impératif plutôt qu'une vraie question — l'exemple
// même déjà présent dans le prompt système ("trouve trois boulangeries") n'a ni mot interrogatif ni "?".
const INFO_SEEKING_IMPERATIVE = /^(trouve|trouve[- ]moi|cherche|cherche[- ]moi|recherche|dis[- ]moi|donne[- ]moi)\b/i
// Exclus explicitement : l'heure/la date (déjà données dans le prompt système, jamais une question de
// "connaissance" au sens où ce filet est pensé) et tout ce qui porte sur Jaris/l'utilisateur lui-même
// (fonctionnement, mémoire locale) — une relance search_web y serait à la fois inutile et hors sujet.
const NOT_A_KNOWLEDGE_QUESTION =
  /\b(quelle heure|quel jour|quelle date|tu t['’]appelles|ton nom|comment tu vas|comment ça va|qui es-tu|je m['’]appelle|mon nom|retiens|retenir|souviens|rappelle-toi|n['’]oublie pas|mémorise)\b/i
// Étape 346 : une question adressée à Jaris lui-même (« tu m'entends ? »), sur ce qui a déjà été dit (« je t'ai dit
// quoi ? »), sur la date, ou une demande explicite de ne pas chercher : aucune donnée du monde à aller lire sur internet.
// Pas de \b après un mot accentué (« là ») : en JavaScript, \b ne connaît que les lettres sans accent.
const ABOUT_THIS_CONVERSATION =
  /(?:^|[\s,;:!?.'’])(?:tu m['’](?:entends|écoutes|ecoutes)|tu es là|tu es la|t['’]es là|t['’]es la|tu sais faire|tu peux faire|tu fais quoi|que sais-tu faire|qu['’]est-ce que tu (?:sais|peux) faire|tu es qui|t['’]es qui|tu te souviens|tu as compris|t['’]as compris|je t['’]ai dit|je t['’]avais dit|mon prénom|mon prenom|le combien|on est quel jour|la date d['’]aujourd['’]hui|ne cherche pas|cherche pas|sans chercher|sans internet|sans recherche|de m[ée]moire(?=\s*[,.!?;:]|\s*$)|pas besoin de chercher)/i
// Les petites questions sociales adressées à Jaris ne demandent aucune donnée extérieure. Le motif est
// volontairement ancré sur la phrase entière : « Pourquoi ça va mal dans l'économie ? » reste ainsi une
// vraie question factuelle, tandis que « tu vas bien ? » ne déclenche plus une recherche web absurde.
// Étape 346 : aussi avec une salutation et le prénom (« Salut Jaris, ça va ? »), qui partait sinon chercher sur internet.
const SOCIAL_CHECK_IN =
  /^(?:(?:salut|bonjour|bonsoir|coucou|hey|hello)[, !]*)?(?:jaris[, !]*)?(?:tu vas bien|vas-tu bien|est-ce que tu vas bien|comment vas-tu|comment tu vas|ça va|ca va)(?:[, !]*jaris)?\s*[?!.]*$/i
const SIMPLE_GREETING = /^(?:salut|bonjour|bonsoir|coucou|hello|hey)(?:\s+jaris)?\s*[!?.,]*$/iu

/**
 * Les salutations très simples n'ont besoin ni d'un modèle ni d'un outil. En usage réel, le modèle rapide
 * a interprété son propre paramètre interne `think` comme si Léo avait tapé une commande `/think`, puis lui
 * a expliqué cette commande imaginaire après un simple « salut ». Court-circuiter le modèle rend cette
 * confusion impossible, comme les autres garde-fous mécaniques de ce fichier.
 */
export function directSocialReply(prompt: string): string | undefined {
  const trimmed = prompt.trim()
  if (SIMPLE_GREETING.test(trimmed)) return t('reply.greeting')
  if (SOCIAL_CHECK_IN.test(trimmed)) return t('reply.checkIn')
  return undefined
}

// Bêta de l'étape 324 : « Combien font 12 fois 7 ? » passait pour une question de connaissance. Le modèle répondait
// 84, juste, puis la relance l'obligeait à chercher sur internet ; si la recherche échouait (SearXNG absent, fréquent
// au premier lancement), « Échec de l'outil » remplaçait la bonne réponse. Un calcul ne demande aucune donnée du
// monde : une demande faite UNIQUEMENT de nombres, d'opérations et de quelques mots de liaison n'en est pas une.
// Tout autre mot la laisse question de connaissance : « pommes », « habitants », « TVA », « France », mais aussi une
// unité ou une monnaie (« 100 dollars en euros » demande un taux de change, donc une donnée du monde).
// Français seulement, comme le reste de ce filet ; une demande en chiffres et symboles seuls (« 12*7 ») vaut partout.
const CALC_NUMBER_WORDS = new Set([
  'zero', 'un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
  'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'vingts', 'trente', 'quarante', 'cinquante', 'soixante',
  'septante', 'octante', 'huitante', 'nonante', 'cent', 'cents', 'mille', 'million', 'millions', 'milliard',
  'milliards', 'demi', 'demie'
])
const CALC_OPERATORS = new Set([
  '+', '-', '−', 'x', '×', '*', '/', '÷', '=', '^', '%', 'plus', 'moins', 'fois', 'multiplie', 'multipliee',
  'multiplies', 'multipliees', 'multiplier', 'divise', 'divisee', 'divises', 'divisees', 'diviser', 'sur', 'pourcent',
  'pourcentage', 'carre', 'carree', 'carres', 'carrees', 'cube', 'racine', 'puissance', 'exposant', 'modulo', 'somme',
  'produit', 'difference', 'quotient', 'moyenne', 'double', 'triple', 'moitie', 'tiers', 'quart'
])
// Mots qui annoncent un calcul : avec eux, « Combien font 3 et 4 ? » suffit, sans opération écrite.
const CALC_LEAD_WORDS = new Set(['combien', 'calcule', 'calcul', 'calculer', 'font', 'fait', 'vaut', 'valent', 'egal', 'egale', 'resultat'])
// Mots de liaison qui ne demandent rien par eux-mêmes (« c'est quoi », « le carré de », « dis-moi »).
const CALC_FILLER_WORDS = new Set([
  'ca', 'c', 'est', 'ce', 'que', 'qu', 'quoi', 'quel', 'quelle', 'le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'a',
  'au', 'aux', 'et', 'par', 'virgule', 'moi', 'tu', 'peux', 'pourrais', 'dis', 'donne', 'stp', 'svp', 'jaris', '(', ')'
])

/**
 * true si la demande n'est QU'UN calcul (« 12 fois 7 », « Combien font 12,5 fois 3 ? », « racine carrée de 144 »,
 * « 12*7 ») : au moins un nombre, une opération ou un mot comme « combien », et aucun autre mot que des liaisons.
 */
export function isPureCalculation(prompt: string): boolean {
  const text = prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/s'il (?:te|vous) plait/g, ' ')
    .replace(/\bpour ?cents?\b/g, ' pourcent ')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 x ')
    .replace(/([a-z])-(?=[a-z])/g, '$1 ')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
    .replace(/[+\-−×*\/÷=^%()]/g, ' $& ')
    .replace(/['?!;:«»"…]/g, ' ')
  let numbers = 0
  let operations = 0
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (/^\d+(?:[.,]\d+)*$/.test(word) || CALC_NUMBER_WORDS.has(word)) numbers++
    else if (CALC_OPERATORS.has(word) || CALC_LEAD_WORDS.has(word)) operations++
    else if (!CALC_FILLER_WORDS.has(word)) return false
  }
  return numbers > 0 && operations > 0
}

/**
 * Étape 346 : `work` mis en concurrence avec l'annulation — rejette aussitôt avec une AbortError quand `signal` est
 * annulé, sans attendre `work` (qui continue en arrière-plan ; son résultat ou son erreur sont alors ignorés).
 */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  const aborted = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(aborted())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined)
      reject(aborted())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/**
 * true si la phrase RESSEMBLE à une demande d'information (question de connaissance générale — fait,
 * personne, entreprise, définition, événement... — ou demande à l'impératif du même genre) plutôt qu'une
 * commande d'action ou une question sur Jaris/l'utilisateur lui-même — sert uniquement à décider s'il faut
 * relancer le modèle vers search_web (voir wantsWebInfo plus bas), jamais une vraie analyse de langage : un
 * début de phrase interrogatif/impératif ou un simple "?" final suffit, exactement le niveau de rigueur déjà
 * utilisé pour `hasUnnegatedMailIntent` juste au-dessus. Un simple calcul n'en est pas une (isPureCalculation).
 */
export function looksLikeKnowledgeQuestion(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (
    !trimmed ||
    NOT_A_KNOWLEDGE_QUESTION.test(trimmed) ||
    ABOUT_THIS_CONVERSATION.test(trimmed) ||
    SOCIAL_CHECK_IN.test(trimmed) ||
    isPureCalculation(trimmed)
  ) return false
  return QUESTION_START_WORDS.test(trimmed) || INFO_SEEKING_IMPERATIVE.test(trimmed) || trimmed.endsWith('?')
}

/**
 * Outils qui vont chercher une information réelle (internet, page web, mémoire, état du PC) : après l'un d'eux, une
 * réponse n'est pas « de mémoire du modèle », la relance vers search_web n'a pas lieu d'être.
 */
export const LOOKUP_TOOLS = new Set(['search_web', 'read_web_page', 'recall_memory', 'get_system_stats'])

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
export type { ConverseChannel } from './systemPrompt'

/**
 * Étape 214 (téléphone) : un tour de conversation où seuls certains outils existent. `note` est ajoutée au
 * prompt système pour que le modèle sache pourquoi certaines actions manquent ; `refusal` est la réponse
 * donnée quand une action interdite est quand même demandée.
 */
export interface ConverseRestrictions {
  allowedTools: ReadonlySet<string>
  /** Ajoutée aux consignes ; vide = consignes inchangées (Duel : le modèle doit répondre comme d'habitude). */
  note: string
  refusal: string
  /**
   * Étape 355 (Duel) : CE modèle répond, sans repli ni réglage de réflexion choisi pour un autre modèle — les deux
   * modèles d'un duel sont traités exactement pareil.
   */
  model?: string
  /**
   * Étape 355 (Duel) : aucun raccourci de Jaris (salutation, « ouvre X », Bloc-notes, recherche dans le navigateur,
   * clic direct) — sinon c'est Jaris qui répond à la place du modèle, et les deux réponses d'un duel sont identiques.
   */
  modelOnly?: boolean
  /** Nom du canal dans le journal des demandes (« téléphone » par défaut). */
  journalLabel?: string
  /**
   * Étape 355 (Duel) : prévenu quand un outil échoue (exception), avec l'erreur d'origine. Le Duel s'en sert pour ne
   * pas compter contre un modèle une panne de Jaris ou d'internet (recherche bloquée, vision injoignable…).
   */
  onToolFailure?: (tool: string, error: unknown) => void
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

/**
 * Nettoie les artefacts de présentation que les petits modèles laissent parfois dans leur texte malgré le
 * prompt : entités numériques HTML affichées littéralement (`&#x20;`) et émojis ajoutés spontanément. Les
 * émojis restent autorisés quand la question de l'utilisateur en contient elle-même, afin de pouvoir les
 * expliquer sans effacer le sujet de la réponse.
 */
export function normalizeAssistantText(text: string, userPrompt: string): string {
  const userUsedEmoji = /\p{Extended_Pictographic}/u.test(userPrompt)
  // Étape 328 : le code d'une réponse (blocs ``` et `…`) reste tel quel. Avant, son indentation était réduite à une
  // espace (du Python devenait faux), ses entités HTML décodées et ses émojis retirés : du code recopié depuis le
  // Chat ne marchait plus. Dans le texte, seuls les blancs AU MILIEU d'une ligne sont resserrés : le retrait en
  // début de ligne garde les sous-listes.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/)
    .map((part, index) => (index % 2 === 1 ? part : normalizeProse(part, userUsedEmoji)))
    .join('')
    .trim()
}

function normalizeProse(text: string, userUsedEmoji: boolean): string {
  const decoded = text
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10)
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity
    })
    .replace(/&nbsp;/gi, ' ')

  const withoutUnrequestedEmoji = userUsedEmoji
    ? decoded
    : decoded.replace(/\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?)*/gu, '')

  return withoutUnrequestedEmoji.replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/[ \t]+\n/g, '\n')
}

/**
 * Rédige le texte demandé pour le Bloc-notes (« un poème sur la mer ») : le modèle moyen, sans outils ni réflexion —
 * il n'y a rien à décider, seulement à écrire. Le texte rendu est mis tel quel dans un nouveau document.
 */
async function composeNotepadText(
  request: string,
  profile: Awaited<ReturnType<typeof getProfile>>,
  signal: AbortSignal | undefined,
  journal: JournalEntry
): Promise<string> {
  const model = profile?.models?.medium ?? config.ollama.model
  const askedAt = Date.now()
  let metrics: ChatMetrics | undefined
  const message = await chatWithOllama(
    [
      {
        role: 'system',
        content:
          `Write exactly the text the user asks for, in ${languageInfo(currentLanguage()).english}, ready to be pasted into a ` +
          'document: no introduction, no comment before or after, no Markdown, no title unless asked.'
      },
      { role: 'user', content: request }
    ],
    undefined,
    model,
    false,
    signal,
    profile?.contextLength ?? config.ollama.numCtx,
    undefined,
    undefined,
    (measured) => (metrics = measured)
  )
  journal.timed(describeModelCall(model, message, metrics), askedAt)
  const text = message.content.trim()
  if (!text) throw new Error(t('reply.empty'))
  return text
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
 *
 * **Faux positif signalé par Léo (« Qui a créé ChatGPT ? »)** : le modèle avait déjà répondu correctement,
 * juste précédé d'un préambule poli — « Je vais vous répondre : ChatGPT a été créé par OpenAI. » — et ce
 * simple préambule suffisait à déclencher la relance corrective, qui n'existe QUE pour les vraies promesses
 * sans suite. Vérifié avec le vrai regex avant de corriger : `PROMISE_WITHOUT_ACTION.test("Je vais vous
 * répondre : ChatGPT a été créé par OpenAI.")` → `true` (faux). Pire, le petit modèle local, recevant cette
 * relance sur une réponse déjà correcte, ne savait pas quoi "corriger" et a fini par PARAPHRASER la consigne
 * de correction elle-même comme si c'était sa réponse — c'est ce texte confus, pas une vraie réponse, qui
 * partait à l'écran (un seul essai de relance, aucune vérification après).
 *
 * Le regex seul ne peut pas distinguer une promesse SÈCHE ("je vais envoyer le mail", rien d'autre) d'un
 * préambule suivi d'une vraie réponse : les deux ont la même forme grammaticale. Le signal qui les distingue
 * n'est pas grammatical mais de SUBSTANCE — après le verbe promis, une promesse sèche n'a presque rien
 * derrière (au plus l'objet direct : "le mail", "ça"), alors qu'une vraie réponse a plusieurs mots de contenu
 * (faits, noms propres...). D'où `PROMISE_WITHOUT_ACTION` devenue une fonction plutôt qu'un simple regex :
 * elle rejette un match si CE QUI SUIT compte plus de quelques mots, et ne se déclenche que si TOUS les
 * matches de la phrase sont de vraies promesses sèches.
 *
 * Limite assumée, pas résolue : une réponse très courte après un préambule ("Je vais répondre : Paris.")
 * reste indiscernable d'une promesse sèche par ce seul critère de longueur — seul le cas réellement rapporté
 * (une réponse avec plusieurs mots de contenu) est couvert, faute de pouvoir observer la vraie sortie du
 * modèle local pour affiner plus précisément.
 */
const PROMISE_PHRASE =
  /\b(je vais\b(?:\s+(?!\S*[.!?])\S+){0,3}?\s+(?!\S*[.!?])[a-zà-ÿœ]+(?:er|ir|re)\b|je m'en occupe|je m'y mets|un instant\b|attends(?:[- ]moi)?\b|patiente\b|je le fais (?:tout de suite|maintenant)|laisse[- ]moi (?:faire|une seconde|un instant))/gi

/** Nombre de mots "de contenu" (lettres/chiffres) au-delà duquel ce qui suit une promesse n'est plus son
 * simple objet direct ("le mail", "ça") mais une vraie réponse ("ChatGPT a été créé par OpenAI"). */
const SUBSTANTIAL_CONTENT_WORDS = 5

function countContentWords(text: string): number {
  return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0
}

export function PROMISE_WITHOUT_ACTION(text: string): boolean {
  const regex = new RegExp(PROMISE_PHRASE.source, PROMISE_PHRASE.flags)
  let match: RegExpExecArray | null
  while ((match = regex.exec(text))) {
    const rest = text.slice(match.index + match[0].length).replace(/^[\s,:.]+/, '')
    if (countContentWords(rest) < SUBSTANTIAL_CONTENT_WORDS) return true
  }
  return false
}

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
export function findLeakedToolName(
  text: string,
  toolNames: readonly string[] = TOOL_NAMES,
  english: boolean = currentLanguage() === 'en'
): string | undefined {
  return toolNames.find((name) => new RegExp(leakPattern(name, english), 'i').test(text))
}

/**
 * Étape 328 : en anglais, un nom d'outil sans « _ » est aussi un mot ordinaire (« remember ») — « I'll remember
 * that » relançait le modèle comme s'il avait décrit une action sans la faire, et la réponse d'après était confuse.
 * Ce nom-là ne compte alors que sous sa forme de code : `remember`, remember(…) ou "remember". Les autres langues
 * gardent la règle d'avant (le mot seul suffit) : « remember » n'y est jamais un mot de la phrase.
 */
function leakPattern(name: string, english: boolean): string {
  if (!english || name.includes('_')) return `\\b${name}\\b`
  return `(?:\`${name}\`|"${name}"|\\b${name}\\s*\\()`
}

/**
 * Envoie la phrase transcrite à Ollama, exécute les outils qu'il demande, renvoie la réponse finale à
 * dire. `history` porte les derniers échanges (user/assistant) de la session, en amont du nouveau
 * message : sans ça, chaque question repartait de zéro sans aucun souvenir de ce qui venait d'être dit
 * — un "je n'ai pas compris l'adresse, répète" suivi d'une simple répétition de l'adresse par
 * l'utilisateur devenait alors une phrase isolée sans contexte, que Jaris ne savait pas rattacher à la
 * demande d'envoi de mail en cours.
 */
export async function converse(...args: ConverseArgs): Promise<string> {
  const forwarded = [...args] as ConverseArgs
  const [prompt, , , onLog, , signal, , channel = 'voice', , , , restrictions] = args
  // Étape 245 : chaque étape annoncée à l'écran (onLog, outils compris) est aussi écrite dans le journal des
  // demandes, avec le temps écoulé — pour savoir où passent les minutes sur la machine de Léo.
  const journal = startJournalEntry(restrictions ? restrictions.journalLabel ?? 'téléphone' : channel, prompt)
  forwarded[3] = (message: string) => {
    journal.line(message)
    onLog?.(message)
  }
  try {
    const reply = await conversation(journal, ...forwarded)
    void journal.end(`réponse donnée — ${reply}`)
    return reply
  } catch (err) {
    void journal.end(signal?.aborted ? 'annulée (nouvelle phrase ou arrêt)' : `erreur — ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

/** Le message d'un outil qui a échoué, tel que l'utilisateur le lit (et tel qu'il reste dans l'historique). */
function toolFailure(err: unknown): string {
  return t('reply.toolFailed', { error: err instanceof Error ? err.message : String(err) })
}

/**
 * Étape 293 : un échec déjà enregistré peut avoir été écrit dans une AUTRE langue (l'utilisateur a changé de langue
 * entre-temps) — on reconnaît le début de la phrase dans toutes les langues connues, pas seulement l'actuelle.
 */
export function isToolFailureText(content: string): boolean {
  const text = content.trimStart()
  return allTranslations('reply.toolFailed').some((template) => {
    const prefix = template.split('{error}')[0].trim()
    return prefix.length > 0 && text.startsWith(prefix)
  })
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never
type ConverseArgs = Tail<Parameters<typeof conversation>>

async function conversation(
  journal: JournalEntry,
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
  onSoundCue?: (cue: SoundCue) => void,
  // Étape 173 : reçoit l'image dessinée par generate_image (voir ImageHandler, tools.ts).
  onImage?: ImageHandler,
  // Étape 214 : message venu du téléphone — seuls certains outils existent pour ce tour (voir phoneAccess.ts).
  restrictions?: ConverseRestrictions,
  // Étape 273, chat uniquement : chaque recherche web et page lue, pour le bloc dépliable au-dessus de la réponse.
  onWebActivity?: WebActivityHandler
): Promise<string> {
  // Étape 355 (Duel) : sans raccourci, le modèle fait tout lui-même — c'est lui qu'on juge.
  const shortcuts = !restrictions?.modelOnly
  const socialReply = shortcuts ? directSocialReply(prompt) : undefined
  if (socialReply) {
    onLog?.('Réponse sociale courte, sans appel au modèle.')
    return socialReply
  }

  const memoryTitles = await listMemoryTitles()
  const profile = await getProfile()
  const runTool = createToolExecutor(onReminderFire, profile?.visionModel ?? config.ollama.visionModel, onLog, signal, onImage, onWebActivity)
  const isToolAllowed = (name: string): boolean => !restrictions || restrictions.allowedTools.has(name)
  // Deux barrières plutôt qu'une : les outils interdits ne sont même pas présentés au modèle (plus bas), ET
  // l'exécution les refuse quand même — un modèle peut inventer un appel à un outil qu'on ne lui a pas donné.
  const executeTool: typeof runTool = async (name, args) => {
    if (!isToolAllowed(name)) throw new Error(restrictions?.refusal ?? t('reply.unavailable'))
    return runTool(name, args)
  }
  const tools = restrictions ? TOOLS.filter((tool) => isToolAllowed(tool.function.name)) : TOOLS

  const note = shortcuts ? notepadRequest(prompt) : null
  // Le Bloc-notes écrit sur le PC : jamais depuis le téléphone (Léo : « pas taper à ta place »).
  if (note && restrictions) return restrictions.refusal
  if (note) {
    onLog?.(t('log.notepad.preparing'))
    try {
      // Étape 346 : « écris un poème sur la mer » — le texte est d'abord rédigé par le modèle, puis ouvert par le même
      // chemin sûr (un nouveau fichier, jamais une frappe dans la fenêtre qui a le focus).
      const text = note.kind === 'literal' ? note.text : await composeNotepadText(note.request, profile, signal, journal)
      return await openNotepadText(text, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      return t('reply.notepad.failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Étape 248 : « ouvre Firefox et cherche X » — la page de résultats ouverte directement, sans réflexion du modèle ni
  // pilotage d'écran (journal de Léo : 2 min de réflexion, puis des clics dans la barre des tâches).
  const browserSearch = shortcuts ? directBrowserSearch(prompt) : null
  if (browserSearch) {
    if (!isToolAllowed('open_app')) return restrictions?.refusal ?? t('reply.unavailable')
    if (signal?.aborted) return t('reply.searchCancelled')
    onLog?.(
      browserSearch.browser
        ? t('log.browserSearch.in', { query: browserSearch.query, browser: browserSearch.browser.name })
        : t('log.browserSearch', { query: browserSearch.query })
    )
    return openBrowserSearch(browserSearch)
  }

  const screenTask = shortcuts ? directScreenTask(prompt) : null
  if (screenTask && isToolAllowed('computer_use_task')) {
    if (signal?.aborted) return t('reply.taskCancelled')
    onLog?.(`Action à l'écran demandée : pilotage direct, sans réflexion préalable du modèle.`)
    onSoundCue?.('scan')
    try {
      return await executeTool('computer_use_task', { goal: screenTask })
    } catch (err) {
      return toolFailure(err)
    }
  }

  const requestedApp = shortcuts ? directAppRequest(prompt) : null
  if (requestedApp) {
    if (signal?.aborted) return t('reply.openCancelled')
    onLog?.(t('log.opening', { app: requestedApp }))
    try {
      const result = await executeTool('open_app', { app_name: requestedApp })
      // Explorer accuse réception avant que l'application ait nécessairement une fenêtre visible. Étape 346 : le nom
      // de l'application réellement lancée, pas celui qui a été dit (« Blocknote » → « Bloc-notes »).
      const launched = launchedAppName(result)
      return launched ? t('reply.openSent', { app: launched }) : result
    } catch (err) {
      return toolFailure(err)
    }
  }

  // Étape 355 : la voix a ses propres modèles quand les votes des duels « Vocal » en ont choisi d'autres.
  const models = (channel === 'voice' ? profile?.voiceModels : undefined) ??
    profile?.models ?? { flash: config.ollama.model, medium: config.ollama.model, large: config.ollama.model }
  // Curseur de longueur de contexte (Options -> Modèles) : `undefined` tant que Léo n'y a jamais touché,
  // Jaris garde alors exactement le comportement d'avant ce réglage (OLLAMA_NUM_CTX, config.ts).
  const numCtx = profile?.contextLength ?? config.ollama.numCtx
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
  if (overloadWarning) onLog?.(t('log.overload', { warning: overloadWarning }))

  if (live.tempC !== null && live.tempC >= GPU_TEMP_LIMIT_C && tier !== 'flash') {
    onLog?.(`GPU à ${live.tempC}°C (seuil ${GPU_TEMP_LIMIT_C}°C) : passage au palier rapide le temps qu'elle refroidisse.`)
    tier = 'flash'
  }

  // Étape 141 : un modèle choisi à la main pour ce mode (sélecteur du Chat / de l'écran vocal) remplace le
  // choix par palier. Le palier garde son rôle pour l'effort de réflexion, mais pas de repli VRAM automatique :
  // c'est un choix explicite de Léo, pas à défaire en silence. `null` = Auto, strictement comme avant.
  const chosenModel = restrictions?.model ?? resolveChosenModel(profile, channel, installedModels)
  if (!chosenModel && profile?.modelChoices?.[channel]) {
    onLog?.(t('log.chosenModelGone', { model: profile.modelChoices[channel] ?? '' }))
  }

  // Étape 346 : la mémoire vidéo que les modèles déjà chargés par Ollama occupent est rendue dès qu'un autre modèle en
  // a besoin — la compter comme « prise » faisait remplacer le modèle du rôle par un plus petit à presque chaque phrase
  // (le modèle de la réponse précédente reste chargé quelques minutes). Et un modèle déjà chargé n'a rien à charger.
  const ownLoaded = live.freeVramGb !== null ? await loadedOllamaModels() : null
  const usableVramGb = live.freeVramGb === null ? null : live.freeVramGb + (ownLoaded ?? []).reduce((sum, m) => sum + m.vramGb, 0)
  const sameModel = (a: string, b: string): boolean => a.replace(/:latest$/, '') === b.replace(/:latest$/, '')
  const isInstalled = (name: string): boolean => installedModels.some((installed) => sameModel(installed, name))

  /** Résout modèle + effort de réflexion pour un palier donné, avec le même repli VRAM temps réel que ci-dessus. */
  const resolveModelForTier = (t: Tier): { model: string; think: ThinkLevel | ThinkValue } => {
    if (chosenModel) return { model: chosenModel, think: THINK_LEVEL[t] }
    let m = models[t]
    // Étape 346 : le modèle du rôle n'est pas installé (téléchargement refusé : disque plein, trop gros…) — un autre
    // modèle de Jaris déjà installé plutôt qu'une erreur « modèle introuvable » à chaque phrase.
    if (installedModels.length && !isInstalled(m)) {
      const fallback =
        [models.medium, models.flash, models.large].find(isInstalled) ?? pickSafeModel(Number.MAX_SAFE_INTEGER, installedModels, m)
      if (fallback !== m && isInstalled(fallback)) {
        onLog?.(`Modèle ${m} pas installé : repli sur ${fallback}.`)
        m = fallback
      }
    }
    if (usableVramGb !== null && !ownLoaded?.some((loaded) => sameModel(loaded.model, m))) {
      const safeModel = pickSafeModel(usableVramGb, installedModels, m)
      if (safeModel !== m) {
        onLog?.(`VRAM utilisable actuelle : ${usableVramGb.toFixed(1)} Go (insuffisant pour ${m}) : repli sur ${safeModel}.`)
        m = safeModel
      }
    }
    return { model: m, think: THINK_LEVEL[t] }
  }

  // Étape 192 : la réflexion choisie à côté du modèle remplace celle du palier, seulement pour le modèle pour
  // lequel Léo l'a choisie et s'il l'accepte vraiment (shared/effort.ts). Pas de choix = comportement d'avant.
  // Étape 355 : jamais en duel — le réglage choisi pour un modèle avantagerait un seul des deux.
  const thinkChoice = restrictions?.model ? undefined : profile?.thinkChoices?.[channel]
  const withEffort = async (r: { model: string; think: ThinkLevel | ThinkValue }): Promise<{ model: string; think: ThinkLevel | ThinkValue }> => {
    if (!thinkChoice) return r
    const think = chosenThink(thinkChoice, r.model, await getModelThinking(r.model))
    return think === undefined ? r : { model: r.model, think }
  }

  let { model, think } = await withEffort(resolveModelForTier(tier))
  onLog?.(`Modèle ${chosenModel ? 'choisi à la main' : 'choisi'} : ${model} (réflexion : ${typeof think === 'boolean' ? thinkLabel(think) : think})`)

  /** Si la machine est surchargée, l'avertissement précède la vraie réponse dans la même phrase parlée. */
  // Étape 234 (bêta) : à l'écrit, un paragraphe à part — collé d'un espace, il se mêlait à la réponse et cassait
  // un bloc de code placé en tête (un « ``` » n'est reconnu qu'en début de ligne). À voix haute, un espace suffit.
  const withOverloadWarning = (text: string): string =>
    overloadWarning ? `${overloadWarning}${channel === 'voice' ? ' ' : '\n\n'}${text}` : text

  /**
   * Les petits modèles (palier "rapide") appellent bien les outils, mais échouent parfois à formuler une
   * vraie réponse une fois le résultat de l'outil reçu (contenu vide) : sans ce filet, ça fait planter la
   * synthèse vocale ("Text cannot be empty") en pleine conversation.
   */
  const finalize = (text: string): string => {
    const trimmed = text.trim()
    const fallback = t('reply.empty')
    const normalized = normalizeAssistantText(trimmed || fallback, prompt) || fallback
    const cleaned = channel === 'voice' ? stripMarkdownForVoice(normalized) : normalized
    return withOverloadWarning(cleaned)
  }

  // Étape 293 : la réponse dans la langue choisie dans Jaris (Options → Général), quelle que soit celle des consignes.
  const systemPrompt = buildSystemPrompt(userName, memoryTitles, channel, languageInfo(currentLanguage()).english)
  const messages: OllamaMessage[] = [
    {
      role: 'system',
      content: restrictions?.note ? `${systemPrompt}\n\n${restrictions.note}` : systemPrompt
    },
    // Les erreurs d'outils sont conservées dans l'historique visible, mais pas réinjectées au modèle :
    // qwen3.5:4b a reproduit un ancien 403 SANS appeler search_web, alors que le service répondait 200.
    // Retirer aussi la question associée évite une suite de demandes anciennes laissées sans réponse.
    // Ce filtre s'applique au chargement comme en session, dans les deux canaux, sans effacer le disque.
    ...history.filter((message, index) => {
      const isToolFailure = (entry?: OllamaMessage): boolean =>
        entry?.role === 'assistant' && isToolFailureText(entry.content)
      // Nettoie aussi le vrai échange erroné déjà écrit sur disque : « salut » suivi d'une explication
      // inventée de `/think`. Le garder dans les 12 derniers messages inciterait le modèle à le répéter.
      const isHallucinatedThinkReply = (entry: OllamaMessage | undefined, previous?: OllamaMessage): boolean =>
        entry?.role === 'assistant' && /\/think\b/i.test(entry.content) &&
        previous?.role === 'user' && directSocialReply(previous.content) !== undefined
      return !isToolFailure(message) &&
        !(message.role === 'user' && isToolFailure(history[index + 1])) &&
        !isHallucinatedThinkReply(message, history[index - 1]) &&
        !(message.role === 'user' && isHallucinatedThinkReply(history[index + 1], message))
    }),
    // La date ici et non dans les consignes : elles restent identiques d'une demande à l'autre, et Ollama n'a pas
    // à les relire (voir dateTimeNote). L'historique garde la question seule, sans la date.
    { role: 'user', content: `${dateTimeNote(new Date(), currentLocale())} ${prompt}` }
  ]

  // Un petit modèle local abandonne parfois en cours de route sur une tâche à plusieurs étapes : il
  // cherche (search_web) mais n'envoie jamais le mail malgré une consigne explicite ("envoie-leur un
  // mail"), et répond à la place par un simple résumé texte de ce qu'il a trouvé. Détecté sur l'intention
  // de LA PHRASE ACTUELLE (pas l'historique, pour ne jamais relancer sur une intention d'un tour précédent
  // déjà traitée) plutôt que sur TOOL_SIGNAL_WORDS (pensé pour choisir un palier, pas pour ça).
  // Sans computer_use_task (téléphone), relancer vers lui pousserait le modèle vers un outil absent.
  // Étape 346 : ces deux filets lisent du français ; dans une autre langue, ils se tromperaient.
  const french = currentLanguage() === 'fr'
  const wantsEmailSent = french && isToolAllowed('computer_use_task') && hasUnnegatedMailIntent(prompt)
  const writingRequest = isWritingRequest(prompt)
  // Contrairement à wantsEmailSent (recalculé sur la seule phrase actuelle, jamais l'historique), cette
  // relance n'a de sens que pour la question posée à CE tour : sinon une conversation qui a déjà cherché une
  // fois relancerait sans arrêt sur une intention d'un tour précédent déjà traité.
  const wantsWebInfo = french && looksLikeKnowledgeQuestion(prompt)
  let computerUseCalled = false
  // Outils lancés dans CETTE demande : « regarder l'écran » ne clôt la demande que s'il est le tout premier (étape 242).
  let toolsRunThisTurn = 0
  let searchCalledThisTurn = false
  // Étape 346 : un outil qui AGIT (ouvrir, taper, rappel…) a réussi : la demande était une action, pas une question.
  let actionToolThisTurn = false
  // Un rappel ou une note ont répondu à la demande : « rappelle-moi d'envoyer le mail » n'est pas un envoi.
  let reminderOrNoteThisTurn = false
  // La réponse du modèle AVANT la relance vers la recherche : gardée si la recherche imposée échoue.
  let draftBeforeSearch: string | undefined
  let nudgedForEmail = false
  let nudgedForSearch = false
  let toolCalledThisTurn = false
  let nudgedForNoAction = false
  // Une question factuelle peut produire un premier texte de mémoire avant que le filet mécanique impose
  // search_web. Ne jamais streamer ce brouillon : il serait visible 2-3 secondes puis remplacé par la vraie
  // réponse, exactement le comportement signalé avec « Qui est Dario Amodei ? ». On garde les fragments en
  // attente et on n'affiche que la réponse finale, une fois la recherche réellement effectuée.
  const holdKnowledgeStream = wantsWebInfo && Boolean(onToken)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const askedAt = Date.now()
    let metrics: ChatMetrics | undefined
    const message = await chatWithOllama(
      messages,
      tools,
      model,
      think,
      signal,
      numCtx,
      holdKnowledgeStream ? () => {} : onToken,
      undefined,
      (measured) => (metrics = measured)
    )
    journal.timed(describeModelCall(model, message, metrics), askedAt)
    if (!message.tool_calls?.length) {
      if (wantsEmailSent && !computerUseCalled && !nudgedForEmail && !reminderOrNoteThisTurn) {
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
      if (wantsWebInfo && !searchCalledThisTurn && !actionToolThisTurn && !nudgedForSearch) {
        nudgedForSearch = true
        draftBeforeSearch = message.content
        onLog?.("Question de connaissance sans recherche web : relance corrective d'un tour.")
        // Étape 217 (Léo, « Comment faire du pain » depuis le téléphone) : le brouillon de mémoire n'est PAS
        // remis au modèle, et la consigne n'est ni un reproche ni un message de l'utilisateur. Avec le brouillon
        // + « ta mémoire n'est pas fiable » en message utilisateur, le modèle se justifiait au lieu de répondre :
        // « réponse strictement basée sur search_web… j'ai reculé sur saladier, fouet… pourquoi cette réponse est
        // correcte… comme exigé ». Même travers que la relance « promesse sans action » (paraphrase de la consigne).
        messages.push({
          role: 'system',
          content:
            "Pour cette question, appelle d'abord search_web avec ses mots-clés, puis réponds directement à la " +
            "question de l'utilisateur à partir des résultats, comme une réponse normale. Ne parle ni de cette " +
            "consigne, ni de recherche demandée, ni de ta mémoire, et ne justifie pas ta réponse."
        })
        continue
      }
      const leakedTool = !toolCalledThisTurn && !nudgedForNoAction ? findLeakedToolName(message.content) : undefined
      // Un texte rédigé à la demande (étape 262) peut contenir « je vais… » sans que ce soit une action de Jaris.
      if (!toolCalledThisTurn && !nudgedForNoAction && ((!writingRequest && PROMISE_WITHOUT_ACTION(message.content)) || leakedTool)) {
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
            "nécessaire (par exemple une simple question à laquelle tu as déjà la réponse), réponds " +
            "directement et uniquement à la question d'origine de l'utilisateur, sans mentionner cette " +
            "consigne, les outils, ni le fait que tu corriges quoi que ce soit."
        })
        continue
      }
      const finalText = finalize(message.content)
      if (holdKnowledgeStream) onToken?.(finalText)
      return finalText
    }

    toolCalledThisTurn = true
    messages.push(message)

    // Un appel d'outil doit toujours se conclure sur le palier "médium" : c'est le seul dont la fiabilité
    // à reformuler une vraie réponse après un résultat d'outil est éprouvée (voir THINK_LEVEL plus haut).
    if (tier === 'flash') {
      tier = 'medium'
      ;({ model, think } = await withEffort(resolveModelForTier(tier)))
      if (!chosenModel) onLog?.(`Appel d'outil détecté : passage au palier médium pour la suite (${model}).`)
    }

    for (const call of message.tool_calls) {
      onLog?.(`Outil appelé : ${call.function.name}(${JSON.stringify(call.function.arguments)})`)
      const soundCue = TOOL_SOUND_CUES[call.function.name]
      if (soundCue) onSoundCue?.(soundCue)

      // Un outil qui lève une exception (moteur de recherche/Ollama injoignable, erreur réseau...) ne doit
      // jamais faire échouer tout le tour de conversation : sans ce try/catch, l'exception remontait telle
      // quelle jusqu'à converse(), et l'appelant (voicePipeline.ts/chatSession.ts) la remplaçait par le
      // message générique "vérifie qu'Ollama tourne bien" — trompeur quand la vraie cause est ailleurs (ex:
      // pas d'internet pour search_web). Le message d'erreur, lui, est déjà clair et actionnable (voir
      // webSearch.ts) : mieux vaut le transmettre au modèle comme un résultat d'outil normal, pour qu'il le
      // relaie fidèlement (voir la consigne "ne jamais inventer de dépannage" plus bas) plutôt que le perdre.
      // Téléphone (étape 214) : un outil interdit que le modèle appelle quand même (il n'en avait pas la liste)
      // n'est jamais exécuté, et la réponse est le refus lui-même, sans « Échec de l'outil » technique devant.
      if (restrictions && !isToolAllowed(call.function.name)) {
        onLog?.(`Outil refusé depuis le téléphone : ${call.function.name}`)
        return finalize(restrictions.refusal)
      }

      let result: string
      let toolFailed = false
      toolsRunThisTurn++
      try {
        // Étape 346 : « Arrêter » ou une nouvelle phrase interrompent tout de suite, même un outil qui ne sait pas
        // s'arrêter lui-même (il finit alors en arrière-plan, son résultat est ignoré).
        result = await raceAbort(executeTool(call.function.name, call.function.arguments), signal)
      } catch (err) {
        if (signal?.aborted) throw err
        restrictions?.onToolFailure?.(call.function.name, err)
        result = toolFailure(err)
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
        // Étape 346 : une recherche imposée par la relance qui échoue (pas d'internet…) ne remplace jamais une
        // réponse déjà donnée — « Combien d'habitants à Lyon ? » gardait sinon « Échec de l'outil » à la place.
        const nudgedLookupFailed = nudgedForSearch && (call.function.name === 'search_web' || call.function.name === 'read_web_page')
        if (nudgedLookupFailed && draftBeforeSearch?.trim() && !isToolFailureText(draftBeforeSearch)) {
          // Dit tel quel : la réponse vient de la mémoire du modèle, pas d'une vérification.
          const finalText = finalize(t('reply.unverified', { answer: draftBeforeSearch.trim() }))
          if (holdKnowledgeStream) onToken?.(finalText)
          return finalText
        }
        return finalize(result)
      }

      if (call.function.name === 'computer_use_task') computerUseCalled = true
      // Campagne de tests de Léo (04/10/2026) : la relance « cherche sur internet » partait aussi après une
      // réponse tirée de la mémoire ou de l'état du PC — 91 demandes sur 1 083 (« c'est quand l'anniversaire de
      // ma mère ? », « combien de RAM j'utilise ? »…), toujours plus lentes, et 11 fois une bonne réponse
      // (« le 14 mars ») remplacée par « aucun résultat sur internet ». Consulter une source compte comme vérifier.
      if (LOOKUP_TOOLS.has(call.function.name)) searchCalledThisTurn = true
      else actionToolThisTurn = true
      if (call.function.name === 'set_reminder' || call.function.name === 'remember') reminderOrNoteThisTurn = true

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
      // Étape 242 (campagne de Léo, 67 demandes) : seulement quand on lui demande l'écran lui-même, en premier
      // outil. En pleine tâche (« ouvre Discord et écris… » : l'écriture échoue, le modèle regarde pour
      // comprendre), s'arrêter là répondait par une description de l'écran sans jamais finir la tâche ni dire
      // que l'écriture avait échoué : le résultat repart au modèle, comme celui de n'importe quel outil.
      if (call.function.name === 'look_at_screen' && toolsRunThisTurn === 1 && isScreenQuestion(prompt)) {
        return finalize(result)
      }

      // Étape 173 : l'image est déjà affichée (Chat) ou ouverte (voix) par onImage. Repasser par le modèle de
      // conversation le rechargerait sur la carte graphique qu'on vient de libérer pour le dessin, pour
      // n'ajouter qu'une phrase — et un petit modèle pourrait décrire une image qu'il n'a jamais vue.
      if (call.function.name === 'generate_image') {
        return finalize(result)
      }

      messages.push({ role: 'tool', content: result })
    }
  }

  throw new Error(t('reply.tooManyRounds'))
}
