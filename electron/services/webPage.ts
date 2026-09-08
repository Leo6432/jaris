/**
 * Lecture d'une page web précise (étape 48) : search_web (webSearch.ts) ne renvoie que 5 courts extraits
 * SearXNG, souvent insuffisants pour une adresse, un horaire ou un détail précis absent du résumé — cet
 * outil va chercher le contenu réel de la page derrière une des URLs déjà trouvées par search_web.
 *
 * Extraction volontairement simple (regex, pas de vraie dépendance de parsing HTML type cheerio/jsdom) :
 * juste assez pour retrouver un texte lisible dans le corps de la page, cohérent avec le reste de ce dépôt
 * (webSearch.ts, extractStep de computerUse.ts... tous des parseurs "best effort" faits main).
 */

const FETCH_TIMEOUT_MS = 15000
/** Assez pour couvrir le corps d'un article normal sans faire déborder le contexte du modèle de conversation. */
const MAX_TEXT_LENGTH = 4000

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const codePoint = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? match
  })
}

function htmlToText(html: string): string {
  const withoutNonContent = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withoutTags = withoutNonContent.replace(/<[^>]+>/g, ' ')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

/** Lit le contenu texte d'une page web précise, typiquement une URL renvoyée par search_web juste avant. */
export async function readWebPage(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `URL invalide : "${url}".`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `URL refusée (seuls http/https sont autorisés) : "${url}".`
  }

  let response: Response
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`Impossible de charger la page ${url} : ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    throw new Error(`La page ${url} a répondu ${response.status}.`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('html') && !contentType.includes('text/plain')) {
    return `Contenu de ${url} non lisible en texte (type "${contentType || 'inconnu'}").`
  }

  const html = await response.text()
  const text = htmlToText(html)
  if (!text) return `Page ${url} chargée mais aucun texte lisible n'a pu en être extrait.`

  const truncated = text.length > MAX_TEXT_LENGTH
  return truncated ? `${text.slice(0, MAX_TEXT_LENGTH)}… (contenu tronqué)` : text
}
