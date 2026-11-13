import Anthropic from '@anthropic-ai/sdk'
import { languageInfo } from '../../shared/i18n/languages'
import { currentLanguage, t } from '../../shared/i18n'
import { isDuelOutcome, type DuelAction, type DuelAdviceEffort, type DuelAdviceModel, type DuelOutcome } from '../../shared/duel'

/**
 * Étape 399 (Léo : « ma clé API Claude ; il pose la question, attend les deux réponses, vote A ou B et continue ») :
 * Claude écrit la demande de chaque duel Conversation, puis juge les deux réponses. Le vote n'est jamais compté tel
 * quel : Léo le valide ou le refuse ensuite (duelStore.ts, decideDuelReview).
 *
 * Modèle choisi par Léo : Claude Sonnet 5.5. Les deux modèles du duel restent anonymes (A et B) : Claude ne voit jamais
 * leurs noms, seulement ce qu'ils ont fait et répondu.
 */
export const JUDGE_MODEL = 'claude-sonnet-5-5'

/** Ce que Claude voit d'un côté du duel : les actions, ce que les outils ont répondu, une erreur, la réponse. */
export interface JudgedSide {
  actions: readonly DuelAction[]
  /** Lignes « Outil appelé » / « Résultat de l'outil », déjà sans noms de modèles et raccourcies. */
  toolLog: readonly string[]
  error: string | null
  text: string
}

export interface JudgeVerdict {
  outcome: DuelOutcome
  reason: string
}

/** Une panne qui doit arrêter les duels automatiques (clé refusée, plus de crédit, réseau…), avec un message lisible. */
export class JudgeStopError extends Error {
  /** Étape 476 : la nature de la panne, pour qu'un autre écran (avis du Duel Vision) la dise avec ses propres mots. */
  constructor(
    message: string,
    readonly kind: 'key' | 'rate' | 'network' | 'api' | 'unreadable' = 'api'
  ) {
    super(message)
    this.name = 'JudgeStopError'
  }
}

/** Claude a refusé de répondre pour CE duel (classificateurs de sécurité) : on passe au suivant, sans arrêter. */
export class JudgeRefusalError extends Error {
  constructor() {
    super('refusal')
    this.name = 'JudgeRefusalError'
  }
}

/** Le strict nécessaire de `client.messages.create`, pour pouvoir le simuler dans les tests. */
type CreateMessage = (body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => Promise<Anthropic.Message>

/**
 * Étape 477 : en flux (stream), réassemblé à la fin. Aux efforts « très élevé » et « maximum », la réflexion peut
 * dépasser 16 000 jetons : une demande non diffusée aussi longue risque l'expiration du kit Anthropic.
 */
let clientFactory: (apiKey: string) => CreateMessage = (apiKey) => {
  const client = new Anthropic({ apiKey, maxRetries: 4 })
  return (body, options) => client.messages.stream(body, options).finalMessage()
}

/** Tests : remplace l'appel à l'API par un faux. */
export function setJudgeClientFactory(factory: (apiKey: string) => CreateMessage): void {
  clientFactory = factory
}

function languageName(): string {
  return languageInfo(currentLanguage()).english
}

/** Un outil de Jaris tel que Claude le voit : son nom et la description donnée aux modèles. */
export interface JudgeTool {
  name: string
  description: string
}

/**
 * Léo : « tu donnes un fichier à Claude pour lui expliquer ? Sinon il ne connaît rien. » La notice envoyée en tête de
 * CHAQUE demande à Claude (écrire la question comme voter) : ce qu'est Jaris, comment se passe un duel, ce que prouve
 * (et ne prouve PAS) le résultat de chaque outil, et la liste des outils réellement proposés sur ce PC. Identique d'un
 * duel à l'autre, donc mise en cache par l'API (cache_control) : elle n'est payée en entier qu'une fois.
 */
export function jarisBrief(tools: readonly JudgeTool[]): string {
  return [
    '# What Jaris is',
    'Jaris is a voice and chat assistant that runs entirely on one Windows PC, for one person (Léo). It answers with',
    'small open-weight AI models running locally through Ollama (from about 1 to 30 billion parameters). Its tools act',
    'for real on that PC: they open applications, type text into the window in front, set reminders, search the web,',
    'describe the screen, control media. In the Chat, answers may use Markdown (lists, bold, code).',
    '',
    '# The duel',
    'To choose which local model Jaris should use, two anonymous models (A and B) receive exactly the same request, with',
    'exactly the same instructions, tools and reasoning setting. A answers first and acts on the PC, then B. Their votes',
    'build a ranking that decides which model Jaris uses. Votes you cast are checked by Léo before they count.',
    '',
    '# How to read what the assistants did',
    '- A line "Outil appelé : name(args)" means the model really asked Jaris to run that tool; the next line',
    '  "Résultat de l\'outil : …" is what Jaris actually answered. These lines are the ground truth: the model cannot fake them.',
    '- A model that says it did something ("I opened Notepad", "the reminder is set") without the matching tool call',
    '  did NOT do it. That is a serious fault: the person believes something happened.',
    '- A tool result that reports an error or a refusal means the action failed, whatever the reply claims.',
    '- open_app: "… a été lancé" means Windows received the launch request; it does not prove the window is visible.',
    '- type_text / press_key: the text or key goes to the application in front. Jaris refuses to type when the expected',
    '  application is not in front (the result says so).',
    '- look_at_screen: the result is a description of the screen written by a separate local vision model, which can be',
    '  wrong; computer_use_task: a step-by-step control of the screen by that vision model, which reports what it did.',
    '- search_web / read_web_page: the results are real web results; facts in the reply should match them. Facts that',
    '  needed a search the model did not do are likely invented.',
    '- set_reminder: the reminder is really scheduled; check the delay matches the request.',
    '- Screenshots, when provided, were taken by Jaris itself: before A started, after A finished, and after B finished.',
    '  B ran right after A on the same PC, so the screenshot after B can still show windows that A opened: compare it',
    '  with the screenshot after A to see what B changed. Windows belonging to Jaris itself are hidden from them.',
    '- Never shutting down or restarting the PC is not a fault: that tool is never offered in a duel.',
    '',
    '# Tools offered on this PC (name: description given to the models)',
    ...(tools.length ? tools.map((tool) => `- ${tool.name}: ${tool.description.slice(0, 400)}`) : ['- (none)'])
  ].join('\n')
}

/** La notice, en bloc système mis en cache (avant les consignes propres à la demande). */
function briefBlock(tools: readonly JudgeTool[]): Anthropic.TextBlockParam {
  return { type: 'text', text: jarisBrief(tools), cache_control: { type: 'ephemeral' } }
}

const QUESTION_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false
} as const

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['a', 'b', 'tie', 'bothBad'] },
    reason: { type: 'string' }
  },
  required: ['winner', 'reason'],
  additionalProperties: false
} as const

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Transforme une erreur de l'API en arrêt lisible ; une annulation remonte telle quelle. */
function stopFor(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new JudgeStopError(t('judge.error.key'), 'key')
  }
  if (err instanceof Anthropic.RateLimitError) return new JudgeStopError(t('judge.error.rate'), 'rate')
  if (err instanceof Anthropic.APIConnectionError) return new JudgeStopError(t('judge.error.network'), 'network')
  if (err instanceof Anthropic.APIError) return new JudgeStopError(t('judge.error.api', { error: err.message }))
  return err instanceof Error ? err : new Error(String(err))
}

async function ask<T>(
  apiKey: string,
  body: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'max_tokens'> & { model?: string; max_tokens?: number },
  parse: (value: unknown) => T | null,
  signal?: AbortSignal
): Promise<T> {
  let message: Anthropic.Message
  try {
    message = await clientFactory(apiKey)({ model: JUDGE_MODEL, max_tokens: 16000, ...body }, { signal })
  } catch (err) {
    throw stopFor(err)
  }
  if (message.stop_reason === 'refusal') throw new JudgeRefusalError()
  let value: unknown
  try {
    value = JSON.parse(textOf(message))
  } catch {
    value = null
  }
  const parsed = parse(value)
  if (parsed === null) throw new JudgeStopError(t('judge.error.unreadable'), 'unreadable')
  return parsed
}

/**
 * Vérifie la clé sans rien faire payer de notable : la fiche du modèle juge (Models API). Renvoie `null` si elle marche,
 * sinon le message à afficher.
 */
export async function checkClaudeKey(apiKey: string): Promise<string | null> {
  try {
    await new Anthropic({ apiKey, maxRetries: 1 }).models.retrieve(JUDGE_MODEL)
    return null
  } catch (err) {
    return stopFor(err).message
  }
}

/**
 * La demande d'un duel. `tools` : ce que l'assistant sait faire sur CE PC (nom et description) ; `previous` : les
 * demandes déjà posées, pour ne pas se répéter.
 */
export async function writeDuelQuestion(
  apiKey: string,
  tools: readonly JudgeTool[],
  previous: readonly string[],
  signal?: AbortSignal
): Promise<string> {
  const language = languageName()
  const task = [
    '# Your task: write the next duel request',
    `Write ONE realistic request that Léo would say or type to Jaris, in ${language}, 1 to 3 sentences.`,
    'Vary widely from one request to the next: everyday questions, current facts that need a web search, advice,',
    'drafting a message or an email (drafting only), explaining or summarizing, maths and logic, planning, remembering',
    'something about the user or recalling it, reminders, opening an application and typing in it, media control,',
    'looking at the screen, questions about the PC. Only ask for what the tools above can really do.',
    'Never ask to delete files, send anything to a real person, buy something, change system settings, or shut down or',
    'restart the PC. No real personal data. Never repeat or paraphrase an earlier request.'
  ].join('\n')
  const system: Anthropic.TextBlockParam[] = [briefBlock(tools), { type: 'text', text: task }]
  const recent = previous.slice(-40)
  const content = recent.length
    ? `Earlier requests (do not repeat):\n${recent.map((p) => `- ${p}`).join('\n')}\n\nWrite the next request.`
    : 'Write the first request.'
  return ask(
    apiKey,
    {
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: QUESTION_SCHEMA } }
    },
    (value) => {
      const prompt = (value as { prompt?: unknown } | null)?.prompt
      return typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 2000) : null
    },
    signal
  )
}

function describeSide(name: 'A' | 'B', side: JudgedSide): string {
  const lines = [`=== Assistant ${name} ===`]
  if (side.toolLog.length) lines.push('Tool calls and results:', ...side.toolLog.map((line) => `  ${line}`))
  else if (side.actions.length) lines.push('Actions:', ...side.actions.map((a) => `  ${a.tool}${a.detail ? ` (${a.detail})` : ''}`))
  else lines.push('Tool calls: none')
  if (side.error) lines.push(`Error: ${side.error}`)
  lines.push('Final reply:', side.text.trim() || '(empty)')
  return lines.join('\n')
}

/** Captures d'écran prises par Jaris (JPEG en base64), quand Léo a choisi de les montrer à Claude. */
export interface DuelScreens {
  before: string | null
  afterA: string | null
  afterB: string | null
}

export interface JudgeInput {
  prompt: string
  a: JudgedSide
  b: JudgedSide
  tools: readonly JudgeTool[]
  screens?: DuelScreens | null
}

function screenBlocks(screens: DuelScreens | null | undefined): Anthropic.ContentBlockParam[] {
  if (!screens) return []
  const blocks: Anthropic.ContentBlockParam[] = []
  const add = (label: string, data: string | null): void => {
    if (!data) return
    blocks.push({ type: 'text', text: label })
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })
  }
  add('Screenshot before A started:', screens.before)
  add('Screenshot after A finished:', screens.afterA)
  add('Screenshot after B finished:', screens.afterB)
  return blocks
}

/** Le vote de Claude sur un duel : qui a le mieux servi la personne, et pourquoi. */
export async function judgeDuel(apiKey: string, input: JudgeInput, signal?: AbortSignal): Promise<JudgeVerdict> {
  const language = languageName()
  const task = [
    '# Your task: judge this duel',
    'Decide which assistant served Léo better, using these criteria in order:',
    '1. Did it actually do what was asked? An action claimed in the reply but absent from the tool calls, or a tool',
    '   that failed, counts as not done. Doing something that was not asked counts against it. When screenshots are',
    '   provided, use them to check what really appeared on the screen.',
    '2. Is it correct? Invented facts count against, especially facts that needed a web search it did not do.',
    `3. Does it answer the actual request, in ${language}, clearly and without padding?`,
    'Ignore which side came first, and do not reward length for its own sake.',
    'Answer "tie" when both are about equally good, "bothBad" when neither is acceptable.',
    `Give the reason in ${language}, in one or two short sentences, saying what decided it (Léo reads it to check your vote).`
  ].join('\n')
  const system: Anthropic.TextBlockParam[] = [briefBlock(input.tools), { type: 'text', text: task }]
  const text = [`Request: ${input.prompt}`, '', describeSide('A', input.a), '', describeSide('B', input.b)].join('\n')
  const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text }, ...screenBlocks(input.screens)]
  return ask(
    apiKey,
    {
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: VERDICT_SCHEMA } }
    },
    (value) => {
      const v = value as { winner?: unknown; reason?: unknown } | null
      if (!v || !isDuelOutcome(v.winner) || typeof v.reason !== 'string') return null
      return { outcome: v.winner, reason: v.reason.trim().slice(0, 2000) }
    },
    signal
  )
}

/**
 * Étape 476 (Léo : « demander à l'IA laquelle elle préfère, pour t'aider à voter ») : l'avis de Claude sur les deux
 * descriptions d'un Duel Vision. Claude voit l'image elle-même, donc peut vérifier chaque détail décrit. Ce n'est
 * qu'un conseil affiché à Léo : il n'est jamais compté comme un vote.
 */
export async function adviseVisionDuel(
  apiKey: string,
  input: { image: string; a: string; b: string; model: DuelAdviceModel; effort: DuelAdviceEffort },
  signal?: AbortSignal
): Promise<JudgeVerdict> {
  const language = languageName()
  const task = [
    '# Your task: compare two descriptions of the same image',
    'Two small local vision models were each asked to describe the image below. Decide which description is better,',
    'using these criteria in order:',
    '1. Accuracy: anything described that is not in the image (invented objects, wrong text, wrong colours or counts)',
    '   counts heavily against it.',
    '2. Coverage: the important things in the image (main subject, any readable text, notable details) are mentioned.',
    `3. Clarity: written in ${language}, clear and without padding.`,
    'Ignore which side came first, and do not reward length for its own sake.',
    'Answer "tie" when both are about equally good, "bothBad" when neither is acceptable.',
    `Give the reason in ${language}, in one or two short sentences, naming the detail that decided it.`
  ].join('\n')
  const text = ['=== Description A ===', input.a.trim() || '(empty)', '', '=== Description B ===', input.b.trim() || '(empty)'].join('\n')
  return ask(
    apiKey,
    {
      // Étape 477 : le modèle et l'effort choisis par Léo. 64 000 jetons : de la place pour la réflexion aux efforts
      // élevés (elle compte dans la limite), sans quoi la réponse serait coupée avant le JSON.
      model: input.model,
      max_tokens: 64000,
      system: task,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image } },
            { type: 'text', text }
          ]
        }
      ],
      output_config: { effort: input.effort, format: { type: 'json_schema', schema: VERDICT_SCHEMA } }
    },
    (value) => {
      const v = value as { winner?: unknown; reason?: unknown } | null
      if (!v || !isDuelOutcome(v.winner) || typeof v.reason !== 'string') return null
      return { outcome: v.winner, reason: v.reason.trim().slice(0, 2000) }
    },
    signal
  )
}
