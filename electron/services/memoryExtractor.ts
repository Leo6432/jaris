import { config } from '../config'
import { chatWithOllama, type OllamaMessage } from './ollama'
import { TOOLS, toolFlag } from './tools'
import { listMemoryTitles, rememberNote } from './memoryStore'
import { getProfile } from './profileStore'
import { t } from '../../shared/i18n'

const REMEMBER_TOOL = TOOLS.find((t) => t.function.name === 'remember')
if (!REMEMBER_TOOL) {
  throw new Error("Outil 'remember' introuvable dans TOOLS : ne devrait jamais arriver.")
}

/** Un échange terminé, en attente d'être lu par la mémoire automatique. */
export interface Exchange {
  transcript: string
  reply: string
  /** Étape 328 : la conversation où l'échange a eu lieu, pour n'oublier que les siens quand on la supprime. */
  conversationId?: string
}

/**
 * Échanges pas encore lus par la mémoire automatique. Une extraction arrêtée par une nouvelle demande (voir
 * cancelMemoryExtraction) ne perd donc pas son échange : il est relu avec les suivants, à la prochaine réponse.
 * Plafond LARGE : sur la machine de Léo, une extraction dure environ une minute, donc une conversation suivie peut en
 * faire arrêter plusieurs de suite ; avec seulement 3 échanges gardés, « ma sœur s'appelle Emma » dit au 1er message
 * était perdu au 5e sans jamais avoir été lu. Ce sont les phrases de l'utilisateur qui portent les faits : elles sont
 * gardées entières ici ; seule la demande au modèle les raccourcit (voir exchangesForPrompt).
 */
const MAX_PENDING_EXCHANGES = 12
/** Dans la demande au modèle : le dernier échange presque entier, les plus anciens plus courts (la demande reste petite). */
const PROMPT_LIMITS = {
  latest: { transcript: 4000, reply: 600 },
  older: { transcript: 800, reply: 300 }
}

let pending: Exchange[] = []
let current: { controller: AbortController; done: Promise<void> } | null = null
/** Change à chaque effacement de l'historique : une extraction partie avant n'écrit plus rien (voir clearPendingMemoryExchanges). */
let clearEpoch = 0

/**
 * Arrête l'extraction en cours, à appeler au DÉBUT de chaque nouvelle demande (voix, Chat, téléphone, Code, Image,
 * Vidéo). Vu en usage réel : l'extraction lancée juste après une réponse occupait encore Ollama quand la question
 * suivante est arrivée, qui a attendu environ une minute derrière elle. Couper la connexion arrête la génération côté
 * Ollama. Rien n'est affiché ni journalisé comme un échec : l'échange reste en attente et sera relu à la prochaine
 * réponse.
 */
export function cancelMemoryExtraction(): void {
  current?.controller.abort()
}

/**
 * L'utilisateur efface l'historique (ou une conversation) : les échanges encore en attente partent avec lui, et
 * l'extraction en cours n'écrit plus rien. Sans ça, une info dite juste avant l'effacement (extraction arrêtée par la
 * question suivante, échange resté en attente) aurait quand même fini dans la mémoire à la réponse d'après.
 *
 * Étape 328 : avec une conversation précise, seuls SES échanges partent. Avant, supprimer une vieille conversation
 * de la liste jetait aussi ce qui venait d'être dit dans la conversation ouverte (« ma sœur s'appelle Emma » n'était
 * jamais retenu).
 */
export function clearPendingMemoryExchanges(conversationId?: string): void {
  if (conversationId !== undefined) {
    const belongs = (exchange: Exchange): boolean => exchange.conversationId === conversationId
    if (!pending.some(belongs)) return
    pending = pending.filter((exchange) => !belongs(exchange))
  } else {
    pending = []
  }
  clearEpoch += 1
  current?.controller.abort()
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Les échanges tels que le modèle les lit, du plus ancien au plus récent. */
export function exchangesForPrompt(batch: Exchange[]): string {
  return batch
    .map(({ transcript, reply }, index) => {
      const limits = index === batch.length - 1 ? PROMPT_LIMITS.latest : PROMPT_LIMITS.older
      return `Utilisateur : ${cut(transcript, limits.transcript)}\nJaris : ${cut(reply, limits.reply)}`
    })
    .join('\n\n')
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
 *
 * Une seule extraction à la fois : une nouvelle remplace celle qui tourne encore (elle reprend ses échanges),
 * après l'avoir laissée se terminer — une note déjà en cours d'écriture n'est donc jamais écrite deux fois.
 */
export function extractMemoryFromExchange(
  transcript: string,
  reply: string,
  onLog?: (message: string) => void,
  conversationId?: string
): Promise<void> {
  const queued = [...pending, { transcript, reply, conversationId }]
  const dropped = queued.length - MAX_PENDING_EXCHANGES
  if (dropped > 0) {
    // Jamais en silence : un fait dit dans ces échanges ne sera pas retenu (journal de développement seulement).
    console.info(`[mémoire] ${dropped} échange(s) ancien(s) retiré(s) de la file sans avoir été lu(s) (plus de ${MAX_PENDING_EXCHANGES} en attente).`)
  }
  pending = queued.slice(-MAX_PENDING_EXCHANGES)
  const previous = current
  previous?.controller.abort()
  const controller = new AbortController()
  const done = (async () => {
    await previous?.done
    if (controller.signal.aborted) return
    await runExtraction(controller.signal, onLog)
  })()
  current = { controller, done }
  const forget = (): void => {
    if (current?.controller === controller) current = null
  }
  void done.then(forget, forget)
  return done
}

async function runExtraction(signal: AbortSignal, onLog?: (message: string) => void): Promise<void> {
  const batch = pending
  if (!batch.length) return
  const epoch = clearEpoch
  let answered = false
  try {
    const [memoryTitles, profile] = await Promise.all([listMemoryTitles(), getProfile()])
    if (signal.aborted) return
    const model = profile?.models?.medium ?? config.ollama.model

    const systemPrompt =
      'Tu es le module de mémoire de Jaris, un assistant vocal. On te donne le ou les derniers échanges de ' +
      'conversation. Ton seul travail : décider si ces échanges contiennent un FAIT nouveau, ' +
      "concret et durable, que Jaris devrait se rappeler d'une conversation à l'autre (une préférence, une " +
      "adresse, un projet en cours, un rendez-vous, un fait donné sur la vie de l'utilisateur...), OU une " +
      "CORRECTION d'un fait déjà noté (l'utilisateur dit qu'une info connue a changé ou était fausse).\n\n" +
      "Si oui, appelle IMPÉRATIVEMENT l'outil remember. Règles strictes pour le contenu de la note :\n" +
      "- Le fait vient de ce que l'UTILISATEUR a dit, jamais de ce que Jaris répond (sa présentation, ses " +
      'explications, ses conseils).\n' +
      '- Écris UNIQUEMENT le fait lui-même, comme une phrase de connaissance, à la troisième personne ' +
      '(bon exemple : "Adresse email de Léo : xxx@gmail.com.").\n' +
      "- N'écris JAMAIS de commentaire sur ce qui manque, ce qu'il faudrait redemander, ou ton propre " +
      'raisonnement (interdit : "il n\'a pas encore dit...", "il faudrait demander...", "il est ' +
      'nécessaire de..."). Si une info manque dans l\'échange, ignore-la simplement, n\'en parle pas ' +
      'dans la note.\n' +
      '- Le titre de la note désigne le sujet ou la personne concernée (ex: le prénom de ' +
      "l'utilisateur pour une info personnelle), jamais l'action en cours (pas de titre comme " +
      '"Réponse mail", "Question posée" ou "Conversation").\n' +
      "- Si l'échange CORRIGE une info déjà connue (ex: \"en fait mon adresse c'est...\", \"ce n'est plus " +
      '..., c\'est maintenant..."), mets `replace: true` pour que la nouvelle valeur remplace l\'ancienne au ' +
      "lieu de s'ajouter à côté. Laisse `replace` absent/false pour un fait vraiment nouveau qui s'ajoute à " +
      'ce qui est déjà noté.\n\n' +
      'Si ces échanges ne contiennent aucun fait nouveau et concret à garder, aucune correction, et rien de ' +
      "différent de ce qui est déjà noté (bavardage, question factuelle ponctuelle, demande d'action sans " +
      'info personnelle, ou juste une incertitude sur une info encore manquante), n\'appelle aucun outil et ' +
      'ne réponds rien. ' +
      (memoryTitles.length
        ? `Notes déjà en mémoire : ${memoryTitles.join(', ')} — n'appelle pas remember pour répéter une info ` +
          'déjà connue et inchangée, mais appelle-le bien (avec replace: true) si cette info vient de changer.'
        : '')

    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: exchangesForPrompt(batch) }
    ]

    // Vérifié non-undefined au chargement du module (throw ci-dessus sinon) : le cast est sûr ici.
    // Étape 294 : la fenêtre de la conversation (réglage Options → Modèles), pas celle par défaut — une autre valeur
    // ferait recharger le modèle médium par Ollama après chaque échange, juste avant la question suivante.
    const numCtx = profile?.contextLength ?? config.ollama.numCtx
    const message = await chatWithOllama(messages, [REMEMBER_TOOL!], model, 'low', signal, numCtx)
    answered = true
    // Le modèle a répondu : ces échanges sont lus, une note en sorte ou non. Les notes s'écrivent même si une
    // nouvelle demande arrive maintenant (plus rien n'occupe Ollama).
    pending = pending.filter((exchange) => !batch.includes(exchange))
    for (const call of message.tool_calls ?? []) {
      // Historique effacé pendant que le modèle répondait : rien de ce qu'il en a tiré n'est écrit.
      if (epoch !== clearEpoch) return
      if (call.function.name !== 'remember') continue
      const title = String(call.function.arguments.title ?? '').trim()
      const content = String(call.function.arguments.content ?? '').trim()
      if (!title || !content) continue
      const review = reviewNote(title, content, batch, profile?.name ?? null)
      if ('refused' in review) {
        console.info(`[mémoire] note « ${title} » écartée : ${review.refused}`)
        continue
      }
      if (review.title !== title) console.info(`[mémoire] titre « ${title} » remplacé par « ${review.title} » (il désignait l'échange).`)
      // toolFlag, jamais Boolean() : `replace: "false"` en texte (petit modèle) EFFAÇAIT la note existante. Et jamais
      // de remplacement sous un titre changé par Jaris : le modèle visait une autre note, celle-ci serait effacée.
      const replace = review.title === title && toolFlag(call.function.arguments.replace)
      await rememberNote(review.title, content, replace)
      onLog?.(t('memory.autoSaved', { title: review.title }))
    }
  } catch (err) {
    // Arrêtée par une nouvelle demande : rien à dire, ses échanges restent en attente (lus à la prochaine réponse).
    // Détecté par le signal lui-même, jamais par le type d'erreur (une coupure peut remonter sous un autre nom).
    if ((signal.aborted && !answered) || epoch !== clearEpoch) return
    // Vraie erreur : ces échanges sont abandonnés, sinon un échange qui fait toujours échouer serait retenté sans fin.
    pending = pending.filter((exchange) => !batch.includes(exchange))
    onLog?.(t('memory.autoFailed', { error: err instanceof Error ? err.message : String(err) }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Garde-fous dans le CODE (une consigne de plus ne suffit pas face à un petit modèle, voir CLAUDE.md). Vu en vrai
// avec qwen3.5:0.8b : après « Bonjour ! Tu peux te présenter en deux phrases ? », la mémoire a enregistré sous le
// titre « Conversation » la RÉPONSE de Jaris elle-même (« Bonjour Léo : je suis Jaris, un assistant personnel… »).
// Règle de prudence, qui l'emporte sur tout le reste : un vrai fait dit par l'utilisateur passe toujours, même
// reformulé, même complété par la réponse de Jaris, même sous un titre maladroit.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Mots d'un titre qui désignent l'ÉCHANGE lui-même, pas un sujet (texte sans accents, en minuscules). Jamais un nom
 * français courant à double sens : « Chat » (l'animal), « Entretien » (d'embauche). Ceux qui restent ambigus
 * (« Présentation » : celle de Jaris, ou celle que Léo fait lundi devant son patron) ne jettent rien à eux seuls :
 * c'est le contenu qui décide (voir reviewNote).
 */
const EXCHANGE_TITLE_WORDS = new Set([
  'conversation', 'conversations', 'echange', 'echanges', 'discussion', 'discussions', 'dialogue', 'dialogues',
  'reponse', 'reponses', 'question', 'questions', 'presentation', 'presentations', 'salutation', 'salutations',
  'bonjour', 'salut', 'bonsoir', 'bienvenue', 'accueil', 'introduction', 'message', 'messages', 'demande',
  'demandes', 'requete', 'requetes', 'interaction', 'interactions', 'exchange', 'exchanges', 'dialog', 'reply',
  'replies', 'response', 'responses', 'answer', 'answers', 'greeting', 'greetings', 'hello', 'hi', 'welcome',
  'request', 'requests', 'talk', 'smalltalk'
])

/**
 * Mots qui peuvent entourer un mot d'échange sans en faire un sujet : « Conversation avec Jaris », « Échange du
 * jour », « Question posée », « Présentation de l'assistant ». Pas le prénom de l'utilisateur : « Présentation de
 * Léo » peut porter un vrai fait sur lui, il est jugé sur son contenu.
 */
const EXCHANGE_TITLE_FILLERS = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'un', 'une', 'avec', 'et', 'en', 'au', 'aux', 'a', 'sur',
  'pour', 'entre', 'jaris', 'utilisateur', 'utilisatrice', 'assistant', 'assistante', 'ia', 'ai', 'user',
  'jour', 'aujourd', 'hui', 'initial', 'initiale', 'premier', 'premiere', 'nouveau', 'nouvelle', 'court',
  'courte', 'rapide', 'simple', 'general', 'generale', 'recent', 'recente', 'actuel', 'actuelle', 'pose',
  'posee', 'posees', 'donnee', 'small', 'the', 'an', 'with', 'of', 'and', 'first', 'new', 'short', 'quick',
  'today', 'current', 'recent', 'asked', 'general'
])

/** Mots trop courants pour dire d'où vient un fait (comparés tels quels, accents compris : « thé » n'est pas « the »). */
const STOP_WORDS = new Set([
  'les', 'des', 'une', 'est', 'sont', 'son', 'ses', 'sur', 'dans', 'avec', 'sans', 'pour', 'par', 'pas', 'plus',
  'très', 'tres', 'que', 'qui', 'quoi', 'dont', 'mais', 'donc', 'car', 'comme', 'aussi', 'cet', 'cette', 'ces',
  'elle', 'elles', 'ils', 'nous', 'vous', 'leur', 'leurs', 'mon', 'mes', 'ton', 'tes', 'été', 'être', 'etre',
  'avoir', 'ont', 'avons', 'avez', 'suis', 'était', 'etait', 'sera', 'fait', 'faire', 'peut', 'peux', 'tout',
  'tous', 'toute', 'toutes', 'aux', 'entre', 'chez', 'vers', 'depuis', 'encore', 'déjà', 'deja', 'bien', 'oui',
  'non', 'ici', 'cela', 'ceci', 'ça', 'celui', 'celle', 'lui', 'eux', 'moi', 'toi', 'the', 'and', 'for', 'with',
  'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'his', 'her', 'hers', 'its', 'their',
  'they', 'them', 'she', 'him', 'you', 'your', 'our', 'not', 'but', 'also', 'very', 'been', 'being', 'will',
  'can', 'about', 'into'
])

/**
 * Salutations et formules de politesse (sans accents) : l'utilisateur les dit, Jaris les répète, elles ne prouvent
 * jamais d'où vient un fait. Dans le cas vu en vrai, « bonjour » comptait comme un mot de l'utilisateur.
 */
const COURTESY_WORDS = new Set([
  'bonjour', 'bonsoir', 'salut', 'coucou', 'hello', 'hey', 'merci', 'thanks', 'thank', 'please', 'stp', 'svp',
  'bienvenue', 'welcome', 'enchante', 'enchantee', 'okay', 'accord', 'plaisir', 'pleasure', 'cordialement'
])

/**
 * Ce qui RACONTE l'échange au lieu de dire un fait (sans accents) : « L'utilisateur a salué Jaris et lui a demandé de
 * se présenter ». Ne sert que sous un titre qui désigne déjà l'échange : ailleurs, « Léo a demandé une augmentation »
 * est un vrai fait.
 */
const NARRATION_STEMS = ['demand', 'salu', 'remerci', 'repond', 'reponse', 'question', 'conversation', 'echang', 'discut', 'dialog']
const NARRATION_WORDS = new Set([
  'jaris', 'bonjour', 'bonsoir', 'coucou', 'hello', 'merci', 'ask', 'asks', 'asked', 'greet', 'greets', 'greeted',
  'thank', 'thanks', 'thanked', 'reply', 'replies', 'replied', 'answer', 'answers', 'answered', 'talked'
])

/** Minuscules, sans accents (« œ » → « oe »), pour comparer des mots écrits différemment. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Un mot comparable : sans accents, et un nombre sans ses zéros de tête (« 03 » = « 3 »). */
function comparable(word: string): string {
  const flat = plain(word)
  return /^\d+$/.test(flat) ? flat.replace(/^0+(?=\d)/, '') : flat
}

/**
 * Le même mot, conjugué ou accordé autrement : « bois »/« boit », « appelle »/« appelles », « anniv »/« anniversaire ».
 * Volontairement large : se tromper ici fait passer une note pour venue de l'utilisateur, jamais l'inverse.
 */
function sameWord(word: string, candidates: Set<string>): boolean {
  if (candidates.has(word)) return true
  if (/^\d+$/.test(word)) return false
  for (const other of candidates) {
    const shortest = Math.min(word.length, other.length)
    if (shortest < 4 || /^\d+$/.test(other)) continue
    let common = 0
    while (common < shortest && word[common] === other[common]) common += 1
    if (common >= shortest - 1) return true
  }
  return false
}

/** Une QUESTION posée à Jaris (« C'est quoi la photosynthèse ? ») : sa réponse est du savoir de Jaris, pas un fait sur l'utilisateur. */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (/\?\s*["'»”’)\]]*\s*$/.test(trimmed)) return true
  // Pas « quand »/« when » : « Quand j'étais petit, j'habitais à Lyon » est une affirmation.
  return /^(?:c['’]?est quoi|qu['’]?est[- ]ce|est[- ]ce que|quel(?:le)?s?|comment|pourquoi|combien|où|qui est|qui a|peux[- ]tu|pourrais[- ]tu|sais[- ]tu|what|who|why|how|where|which|can you|could you|do you|does)(?![\p{L}\p{N}])/iu.test(
    trimmed
  )
}

/** Le titre ne désigne que l'échange (« Conversation », « Échange avec Jaris », « Greeting ») : pas un sujet. */
export function isExchangeTitle(title: string): boolean {
  const words = wordsOf(title).map(plain)
  return (
    words.some((word) => EXCHANGE_TITLE_WORDS.has(word)) &&
    words.every((word) => EXCHANGE_TITLE_WORDS.has(word) || EXCHANGE_TITLE_FILLERS.has(word))
  )
}

/** D'où viennent les mots porteurs d'une note : ce qu'a dit l'utilisateur (affirmations / questions), ou la réponse de Jaris seule. */
function originOf(content: string, exchanges: Exchange[], userName: string | null): { fromStatement: number; fromQuestion: number; onlyFromReply: number } {
  const collect = (texts: string[]): Set<string> => new Set(texts.flatMap((text) => wordsOf(text).map(comparable)))
  const statementWords = collect(exchanges.filter((exchange) => !isQuestion(exchange.transcript)).map((exchange) => exchange.transcript))
  const questionWords = collect(exchanges.filter((exchange) => isQuestion(exchange.transcript)).map((exchange) => exchange.transcript))
  const replyWords = collect(exchanges.map((exchange) => exchange.reply))
  // Le prénom de l'utilisateur et le nom de Jaris : Jaris les dit, une note les cite, ils ne disent pas d'où vient le fait.
  const names = new Set(['jaris', ...wordsOf(userName ?? '').map(comparable)])
  const origin = { fromStatement: 0, fromQuestion: 0, onlyFromReply: 0 }
  for (const raw of wordsOf(content)) {
    if (STOP_WORDS.has(raw)) continue
    const word = comparable(raw)
    if (names.has(word) || COURTESY_WORDS.has(word) || (word.length < 3 && !/^\d+$/.test(word))) continue
    if (sameWord(word, statementWords)) origin.fromStatement += 1
    else if (sameWord(word, questionWords)) origin.fromQuestion += 1
    else if (sameWord(word, replyWords)) origin.onlyFromReply += 1
  }
  return origin
}

/**
 * Le contenu est repris de la réponse de Jaris, pas des mots de l'utilisateur. Deux cas seulement, pour rester prudent :
 *  - AUCUN mot porteur ne vient de l'utilisateur, et certains viennent de la réponse (sa présentation recopiée) ;
 *  - les seuls mots venus de l'utilisateur viennent de QUESTIONS, et la réponse en apporte au moins trois, plus de
 *    trois fois plus (« C'est quoi la photosynthèse ? » → la note recopie l'explication de Jaris).
 * Une note qui complète un fait de l'utilisateur avec les mots de Jaris passe donc (« je suis végétarien » → « Léo est
 * végétarien et ne mange pas de viande »). Les mots que personne n'a dits (une traduction, un mot ajouté) ne comptent
 * ni pour ni contre.
 */
export function isCopiedFromReply(content: string, exchanges: Exchange[], userName: string | null): boolean {
  const { fromStatement, fromQuestion, onlyFromReply } = originOf(content, exchanges, userName)
  if (onlyFromReply === 0) return false
  if (fromStatement + fromQuestion === 0) return true
  return fromStatement === 0 && onlyFromReply >= 3 && onlyFromReply > 3 * fromQuestion
}

/** La note raconte l'échange (« Léo a salué Jaris et lui a demandé de se présenter ») au lieu de dire un fait. */
function narratesExchange(content: string): boolean {
  return wordsOf(content)
    .map(plain)
    .some((word) => NARRATION_WORDS.has(word) || NARRATION_STEMS.some((stem) => word.startsWith(stem)))
}

/**
 * Ce que devient une note proposée par le modèle : gardée telle quelle, gardée sous un autre titre, ou écartée (avec
 * la raison, pour le journal de développement). Un titre qui désigne l'échange ne jette jamais à lui seul un vrai fait
 * de l'utilisateur : la note est gardée sous le prénom de l'utilisateur (ce que la consigne demande déjà), ou sous son
 * titre si aucun prénom n'est connu. Elle n'est écartée que si son contenu ne vient pas clairement de l'utilisateur
 * (moins de deux mots à lui) ou s'il raconte l'échange.
 */
export function reviewNote(title: string, content: string, exchanges: Exchange[], userName: string | null): { title: string } | { refused: string } {
  if (isCopiedFromReply(content, exchanges, userName)) return { refused: 'contenu repris de la réponse de Jaris' }
  if (!isExchangeTitle(title)) return { title }
  const { fromStatement, fromQuestion } = originOf(content, exchanges, userName)
  if (fromStatement + fromQuestion < 2 || narratesExchange(content)) {
    return { refused: "titre qui désigne l'échange, et contenu qui ne dit pas un fait de l'utilisateur" }
  }
  return { title: userName?.trim() || title }
}
