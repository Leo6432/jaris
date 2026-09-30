/**
 * Correcteur de ce que Léo a dit (étape 207, Léo : « pour le vocal, ajouter un correcteur un peu comme Apple » —
 * précisé : « corriger ce que j'ai dit », tout seul, avant la réponse). La transcription locale se trompe sur
 * les homophones et les noms propres (« Charisse » pour « Jaris », « ouvre stime » pour « ouvre Steam ») ; une
 * passe par le petit modèle déjà utilisé pour les questions simples remet le bon mot, comme la dictée d'Apple
 * corrige d'après le contexte.
 *
 * Le danger d'un petit modèle local est connu dans ce dépôt : il répond à la phrase au lieu de la corriger, ou
 * la reformule. D'où trois verrous, et le texte d'origine est gardé dès qu'un seul cède :
 * 1. sortie structurée (schéma JSON à un seul champ) et température 0 ;
 * 2. `acceptCorrection` : la correction doit rester TRÈS proche de l'original (distance d'édition, longueur) —
 *    une réponse ou une reformulation n'y ressemble jamais assez ;
 * 3. délai court et annulation : si le modèle tarde ou échoue, Jaris continue avec ce qu'il a entendu, jamais
 *    bloqué par le correcteur.
 */

export type CorrectionChat = (system: string, user: string, signal?: AbortSignal) => Promise<string>

export const CORRECTION_TIMEOUT_MS = 6000

export function correctionSystemPrompt(userName: string | null): string {
  return [
    "Tu corriges la transcription automatique d'une phrase dite à voix haute, en français, à un assistant vocal.",
    'Règles :',
    '- Corrige UNIQUEMENT les mots mal reconnus (homophones, noms propres ou de marques déformés, mots coupés), les accents et la ponctuation.',
    '- Ne réponds JAMAIS à la phrase. N\'ajoute rien, ne retire rien, ne reformule pas : même sens, mêmes mots quand ils sont justes.',
    '- Garde le tutoiement et la même forme des verbes (« envoie » reste « envoie », jamais « envoyez »). Un nom propre bien écrit ne se change pas.',
    "- L'assistant s'appelle « Jaris » : « Charisse », « Jarice », « Jarvis », « Jariste » deviennent « Jaris ».",
    userName ? `- La personne qui parle s'appelle « ${userName} ».` : '',
    "- S'il n'y a rien à corriger, renvoie la phrase telle quelle.",
    'Exemples :',
    '« ouvre stime » → « Ouvre Steam. »',
    '« Charisse mets un minuteur de dis minutes » → « Jaris, mets un minuteur de dix minutes. »',
    '« quel temps fait il à paris demain » → « Quel temps fait-il à Paris demain ? »',
    'Réponds au format JSON demandé, avec la phrase corrigée dans « texte ».'
  ]
    .filter(Boolean)
    .join('\n')
}

export const CORRECTION_SCHEMA = {
  type: 'object',
  properties: { texte: { type: 'string' } },
  required: ['texte']
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] : 1 + Math.min(previous[j - 1], previous[j], current[j - 1])
    }
    previous = current
  }
  return previous[b.length]
}

/** Compare le fond, pas la forme : minuscules, sans accents ni ponctuation (une correction de ponctuation est gratuite). */
function comparable(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Vrai seulement si `corrected` est une CORRECTION de `original` : quelques lettres changées, pas une autre
 * phrase. Tolérance : un mot déformé sur quatre environ (« stime » → « Steam », « Charisse » → « Jaris »), mais
 * jamais une réponse (« Il fait beau à Paris demain. ») ni un ajout (« Bien sûr, j'ouvre Steam »).
 */
export function acceptCorrection(original: string, corrected: string): boolean {
  const a = comparable(original)
  const b = comparable(corrected)
  if (!a || !b) return false
  if (a === b) return true
  const distance = levenshtein(a, b)
  const allowed = Math.max(3, Math.ceil(a.length * 0.3))
  if (distance > allowed) return false
  // Pas plus d'un mot en plus ou en moins : une correction remplace, elle n'ajoute pas de phrase.
  return Math.abs(a.split(' ').length - b.split(' ').length) <= 1
}

/** Lit le champ « texte » de la réponse JSON ; tout ce qui n'y ressemble pas est ignoré. */
export function parseCorrection(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { texte?: unknown }
    return typeof data.texte === 'string' && data.texte.trim() ? data.texte.trim() : null
  } catch {
    return null
  }
}

/**
 * La phrase à utiliser : corrigée si le modèle a proposé une vraie correction, l'originale sinon (échec, délai
 * dépassé, correction refusée par acceptCorrection). Une annulation demandée par l'appelant, elle, remonte.
 */
export async function correctTranscript(
  text: string,
  chat: CorrectionChat,
  userName: string | null = null,
  signal?: AbortSignal,
  timeoutMs = CORRECTION_TIMEOUT_MS
): Promise<{ text: string; changed: boolean }> {
  const original = text.trim()
  if (comparable(original).length < 2) return { text: original, changed: false }
  // Un vrai minuteur plutôt qu'AbortSignal.timeout : ce dernier ne retient pas la boucle d'évènements de Node,
  // donc le délai pouvait ne jamais se déclencher si rien d'autre ne tournait (vu en test).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Correction trop lente.')), timeoutMs)
  const forward = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener('abort', forward, { once: true })
  let raw: string
  try {
    raw = await chat(correctionSystemPrompt(userName), original, controller.signal)
  } catch (err) {
    if (signal?.aborted) throw err
    return { text: original, changed: false }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
  const corrected = parseCorrection(raw)
  if (!corrected || !acceptCorrection(original, corrected)) return { text: original, changed: false }
  return { text: corrected, changed: corrected !== original }
}
