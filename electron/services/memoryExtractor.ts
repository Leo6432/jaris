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
}

/**
 * Échanges pas encore lus par la mémoire automatique. Une extraction arrêtée par une nouvelle demande (voir
 * cancelMemoryExtraction) ne perd donc pas son échange : il est relu avec le suivant, à la prochaine réponse.
 * Plafonné : dans une longue conversation sans pause, seuls les derniers comptent.
 */
const MAX_PENDING_EXCHANGES = 3
/** La réponse de Jaris ne sert qu'à comprendre l'échange : coupée dans la demande au modèle (plusieurs échanges). */
const MAX_REPLY_CHARS_IN_PROMPT = 2000

let pending: Exchange[] = []
let current: { controller: AbortController; done: Promise<void> } | null = null

/**
 * Arrête l'extraction en cours, à appeler au DÉBUT de chaque nouvelle demande (voix, Chat, téléphone). Vu en usage
 * réel : l'extraction lancée juste après une réponse occupait encore Ollama quand la question suivante est arrivée,
 * qui a attendu environ une minute derrière elle. Couper la connexion arrête la génération côté Ollama. Rien n'est
 * affiché ni journalisé comme un échec : l'échange reste en attente et sera relu à la prochaine réponse.
 */
export function cancelMemoryExtraction(): void {
  current?.controller.abort()
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
export function extractMemoryFromExchange(transcript: string, reply: string, onLog?: (message: string) => void): Promise<void> {
  pending = [...pending, { transcript, reply }].slice(-MAX_PENDING_EXCHANGES)
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

    const exchanges = batch
      .map(({ transcript, reply }) => {
        const shown = reply.length > MAX_REPLY_CHARS_IN_PROMPT ? `${reply.slice(0, MAX_REPLY_CHARS_IN_PROMPT)}…` : reply
        return `Utilisateur : ${transcript}\nJaris : ${shown}`
      })
      .join('\n\n')
    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: exchanges }
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
      if (call.function.name !== 'remember') continue
      const title = String(call.function.arguments.title ?? '').trim()
      const content = String(call.function.arguments.content ?? '').trim()
      if (!title || !content) continue
      const refused = refusedNoteReason(title, content, batch, profile?.name ?? null)
      if (refused) {
        console.info(`[mémoire] note « ${title} » écartée : ${refused}`)
        continue
      }
      // toolFlag, jamais Boolean() : `replace: "false"` en texte (petit modèle) EFFAÇAIT la note existante.
      await rememberNote(title, content, toolFlag(call.function.arguments.replace))
      onLog?.(t('memory.autoSaved', { title }))
    }
  } catch (err) {
    // Arrêtée par une nouvelle demande : rien à dire, ses échanges restent en attente (lus à la prochaine réponse).
    // Détecté par le signal lui-même, jamais par le type d'erreur (une coupure peut remonter sous un autre nom).
    if (signal.aborted && !answered) return
    // Vraie erreur : ces échanges sont abandonnés, sinon un échange qui fait toujours échouer serait retenté sans fin.
    pending = pending.filter((exchange) => !batch.includes(exchange))
    onLog?.(t('memory.autoFailed', { error: err instanceof Error ? err.message : String(err) }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Garde-fous dans le CODE (une consigne de plus ne suffit pas face à un petit modèle, voir CLAUDE.md). Vu en vrai
// avec qwen3.5:0.8b : après « Bonjour ! Tu peux te présenter en deux phrases ? », la mémoire a enregistré sous le
// titre « Conversation » la RÉPONSE de Jaris elle-même (« Bonjour Léo : je suis Jaris, un assistant personnel… »).
// ---------------------------------------------------------------------------------------------------------------

/** Mots d'un titre qui désignent l'ÉCHANGE lui-même, pas un sujet (texte sans accents, en minuscules). */
const EXCHANGE_TITLE_WORDS = new Set([
  'conversation', 'conversations', 'echange', 'echanges', 'discussion', 'discussions', 'dialogue', 'dialogues',
  'reponse', 'reponses', 'question', 'questions', 'presentation', 'presentations', 'salutation', 'salutations',
  'bonjour', 'salut', 'bonsoir', 'bienvenue', 'accueil', 'introduction', 'message', 'messages', 'demande',
  'demandes', 'requete', 'requetes', 'chat', 'entretien', 'interaction', 'interactions', 'exchange', 'exchanges',
  'dialog', 'reply', 'replies', 'response', 'responses', 'answer', 'answers', 'greeting', 'greetings', 'hello',
  'hi', 'welcome', 'request', 'requests', 'talk', 'smalltalk'
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

/** Le titre ne désigne que l'échange (« Conversation », « Échange avec Jaris », « Greeting ») : pas un sujet. */
export function isExchangeTitle(title: string): boolean {
  const words = wordsOf(title).map(plain)
  return (
    words.some((word) => EXCHANGE_TITLE_WORDS.has(word)) &&
    words.every((word) => EXCHANGE_TITLE_WORDS.has(word) || EXCHANGE_TITLE_FILLERS.has(word))
  )
}

/**
 * Le contenu vient surtout de la réponse de Jaris, pas des mots de l'utilisateur : ses mots porteurs se retrouvent
 * au moins deux fois plus souvent dans la réponse seule que dans ce qu'a dit l'utilisateur. Un fait reformulé à la
 * troisième personne garde les mots de l'utilisateur (« ma sœur s'appelle Emma » → « La sœur de Léo s'appelle
 * Emma ») ; les mots que personne n'a dits (une traduction, un mot ajouté) ne comptent ni pour ni contre.
 */
export function isCopiedFromReply(content: string, exchanges: Exchange[], userName: string | null): boolean {
  const userWords = new Set(exchanges.flatMap((exchange) => wordsOf(exchange.transcript).map(comparable)))
  const replyWords = new Set(exchanges.flatMap((exchange) => wordsOf(exchange.reply).map(comparable)))
  // Le prénom de l'utilisateur et le nom de Jaris : Jaris les dit, une note les cite, ils ne disent pas d'où vient le fait.
  const names = new Set(['jaris', ...wordsOf(userName ?? '').map(comparable)])
  let fromUser = 0
  let onlyFromReply = 0
  for (const raw of wordsOf(content)) {
    if (STOP_WORDS.has(raw)) continue
    const word = comparable(raw)
    if (names.has(word) || (word.length < 3 && !/^\d+$/.test(word))) continue
    if (sameWord(word, userWords)) fromUser += 1
    else if (sameWord(word, replyWords)) onlyFromReply += 1
  }
  return onlyFromReply > 0 && onlyFromReply >= 2 * fromUser
}

/** Pourquoi une note proposée par le modèle est écartée (pour le journal de développement), ou null si elle passe. */
export function refusedNoteReason(title: string, content: string, exchanges: Exchange[], userName: string | null): string | null {
  if (isExchangeTitle(title)) return "titre qui désigne l'échange, pas un sujet"
  if (isCopiedFromReply(content, exchanges, userName)) return 'contenu repris de la réponse de Jaris'
  return null
}
