import Anthropic from '@anthropic-ai/sdk'
import { languageInfo } from '../../shared/i18n/languages'
import { currentLanguage, t } from '../../shared/i18n'
import { isDuelOutcome, type DuelAction, type DuelOutcome } from '../../shared/duel'

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
  constructor(message: string) {
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

let clientFactory: (apiKey: string) => CreateMessage = (apiKey) => {
  const client = new Anthropic({ apiKey, maxRetries: 4 })
  return (body, options) => client.messages.create(body, options)
}

/** Tests : remplace l'appel à l'API par un faux. */
export function setJudgeClientFactory(factory: (apiKey: string) => CreateMessage): void {
  clientFactory = factory
}

function languageName(): string {
  return languageInfo(currentLanguage()).english
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
    return new JudgeStopError(t('judge.error.key'))
  }
  if (err instanceof Anthropic.RateLimitError) return new JudgeStopError(t('judge.error.rate'))
  if (err instanceof Anthropic.APIConnectionError) return new JudgeStopError(t('judge.error.network'))
  if (err instanceof Anthropic.APIError) return new JudgeStopError(t('judge.error.api', { error: err.message }))
  return err instanceof Error ? err : new Error(String(err))
}

async function ask<T>(
  apiKey: string,
  body: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'max_tokens'>,
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
  if (parsed === null) throw new JudgeStopError(t('judge.error.unreadable'))
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
  tools: readonly { name: string; description: string }[],
  previous: readonly string[],
  signal?: AbortSignal
): Promise<string> {
  const language = languageName()
  const system = [
    'You write test requests for Jaris, a voice and chat assistant that runs small local AI models on a Windows PC.',
    'Each request is sent unchanged to two anonymous models; their answers will be compared afterwards.',
    `Write ONE realistic request that a person would say or type to their assistant, in ${language}, 1 to 3 sentences.`,
    'Vary widely from one request to the next: everyday questions, current facts that need a web search, advice,',
    'drafting a message or an email (drafting only), explaining or summarizing, maths and logic, planning, remembering',
    'something about the user or recalling it, reminders, opening an application, media control, looking at the screen,',
    'questions about the PC. Use what the assistant can really do, listed below.',
    'Never ask to delete files, send anything to a real person, buy something, change system settings, or shut down or',
    'restart the PC. No real personal data. Never repeat or paraphrase an earlier request.',
    '',
    'What the assistant can do:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description.slice(0, 300)}`)
  ].join('\n')
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

/** Le vote de Claude sur un duel : qui a le mieux servi la personne, et pourquoi. */
export async function judgeDuel(apiKey: string, prompt: string, a: JudgedSide, b: JudgedSide, signal?: AbortSignal): Promise<JudgeVerdict> {
  const language = languageName()
  const system = [
    'You judge a duel between two anonymous assistants, A and B, that answered the same request on a Windows PC.',
    'Their tools really act on the PC (opening apps, typing, reminders, web search, reading the screen...).',
    'For each side you get its tool calls with what each tool returned, any error, and its final reply.',
    'Decide which one served the person better, using these criteria in order:',
    '1. Did it actually do what was asked? An action claimed in the reply but absent from the tool calls, or a tool',
    '   that failed, counts as not done. Doing something that was not asked counts against it.',
    '2. Is it correct? Invented facts count against, especially facts that needed a web search it did not do.',
    `3. Does it answer the actual request, in ${language}, clearly and without padding?`,
    'Ignore which side came first, and do not reward length for its own sake.',
    'Answer "tie" when both are about equally good, "bothBad" when neither is acceptable.',
    `Give the reason in ${language}, in one or two short sentences, saying what decided it.`
  ].join('\n')
  const content = [`Request: ${prompt}`, '', describeSide('A', a), '', describeSide('B', b)].join('\n')
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
