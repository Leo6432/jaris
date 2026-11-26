/**
 * Étape 527 : rapports d'erreurs (Sentry), seulement avec l'accord de la personne. Partagé par le main
 * (electron/services/errorReports.ts) et l'écran (src/lib/errorReports.ts).
 */

/** Adresse du projet « jaris » de Léo sur Sentry (serveurs en Allemagne : ingest.de). Publique par nature (un DSN n'est pas un secret). */
export const ERROR_REPORTS_DSN = 'https://cfa90a60618b136c982e08c5c54e83af@o4512499783630848.ingest.de.sentry.io/4512499795951696'

/**
 * Tout ce que Sentry pourrait collecter en plus de l'erreur elle-même, coupé (relu dans @sentry/core 11.16,
 * types/datacollection.d.ts : presque tout est ACTIVÉ par défaut). Surtout `stackFrameVariables` : les variables du
 * programme au moment de l'erreur contiendraient le texte d'une conversation ou d'une demande. Le code autour de la
 * ligne fautive (`frameContextLines`) est celui de Jaris, jamais une donnée : gardé.
 */
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false
}

export interface ErrorReportsState {
  /** La question a-t-elle déjà été posée (oui ou non) ? */
  asked: boolean
  /** Oui : les erreurs partent (nettoyées). */
  enabled: boolean
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
/**
 * Un dossier d'utilisateur Windows ou Unix dans un chemin : le nom qui suit est remplacé. Un nom Windows peut contenir
 * des espaces (« Léo Moulard ») : jusqu'au séparateur suivant s'il y en a un, sinon jusqu'à la première espace (en
 * trop plutôt qu'en moins).
 */
const USER_DIR = /([\\/](?:Users|home)[\\/])(?:[^\\/\r\n"'<>|:*?]+(?=[\\/])|[^\\/\s"'<>|:*?]+)/gi

/** Retire d'un texte le nom d'utilisateur, le nom du PC, les dossiers personnels et les adresses mail. */
export function scrubText(text: string, privateWords: readonly string[] = []): string {
  let out = text.replace(USER_DIR, '$1<user>').replace(EMAIL, '<email>')
  for (const word of privateWords) {
    if (!word) continue
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Le mot entier seulement : le prénom « leo » ne doit pas abîmer « galleon » dans une pile d'appels.
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'), '<user>')
  }
  return out
}

type Json = unknown

function scrubDeep(value: Json, words: readonly string[], depth = 0): Json {
  if (depth > 12) return value
  if (typeof value === 'string') return scrubText(value, words)
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, words, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [key, v] of Object.entries(value as Record<string, Json>)) out[key] = scrubDeep(v, words, depth + 1)
    return out
  }
  return value
}

/**
 * Nettoie un rapport avant son envoi : jamais d'utilisateur, de nom de machine, de requête, d'extras ni de fil
 * d'actions ; et dans TOUT le reste (message, pile d'appels, contexte), plus de nom d'utilisateur, de nom de PC, de
 * dossier personnel ni d'adresse mail.
 */
export function scrubErrorEvent<T extends Record<string, Json>>(event: T, privateWords: readonly string[] = []): T {
  const copy: Record<string, Json> = { ...event }
  delete copy.user
  delete copy.server_name
  delete copy.request
  delete copy.extra
  delete copy.breadcrumbs
  return scrubDeep(copy, privateWords) as T
}
