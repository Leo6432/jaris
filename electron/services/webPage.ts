import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns'
import { isIP } from 'net'
import { Agent } from 'undici'
import { t } from '../../shared/i18n'
/**
 * Lecture d'une page web précise (étape 48) : search_web (webSearch.ts) ne renvoie que 5 courts extraits
 * (DuckDuckGo depuis l'étape 337), souvent insuffisants pour une adresse, un horaire ou un détail précis absent du résumé — cet
 * outil va chercher le contenu réel de la page derrière une des URLs déjà trouvées par search_web.
 *
 * Extraction volontairement simple (regex, pas de vraie dépendance de parsing HTML type cheerio/jsdom) :
 * juste assez pour retrouver un texte lisible dans le corps de la page, cohérent avec le reste de ce dépôt
 * (webSearch.ts, extractStep de computerUse.ts... tous des parseurs "best effort" faits main).
 *
 * Relecture croisée : cet outil est permis depuis le TÉLÉPHONE (phoneAccess.ts), donc depuis internet, et l'adresse
 * vient d'un modèle (qu'une page lue peut manipuler). Il lisait n'importe quelle adresse : ce PC (127.0.0.1 : l'Ollama de
 * Jaris, le serveur du téléphone…), la box, les appareils du réseau local — y compris au bout d'une redirection — et
 * lisait le corps entier, sans limite. Désormais seules les adresses PUBLIQUES sont lues : vérifiées sur l'adresse IP
 * réellement contactée (après la résolution DNS, au moment de la connexion), à chaque redirection (suivies ici, une par
 * une), et la page n'est lue que jusqu'à MAX_PAGE_BYTES.
 */

const FETCH_TIMEOUT_MS = 15000
/** Assez pour couvrir le corps d'un article normal sans faire déborder le contexte du modèle de conversation. */
const MAX_TEXT_LENGTH = 4000
/** Redirections suivies au plus, chacune revérifiée. */
export const MAX_REDIRECTS = 5
/** Octets lus au plus : de quoi trouver MAX_TEXT_LENGTH caractères de texte dans une vraie page ; la suite n'est pas téléchargée. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024

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
      // Étape 328 : un nombre hors de l'Unicode (« &#99999999; », vu sur des pages réelles) faisait LEVER
      // String.fromCodePoint : toute la lecture de la page échouait pour un seul caractère. Il reste écrit tel quel.
      const valid = Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      return valid ? String.fromCodePoint(codePoint) : match
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

// ---------------------------------------------------------------------------------------------------------
// Adresses publiques seulement
// ---------------------------------------------------------------------------------------------------------

function parseIpv4(text: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!match) return null
  const bytes = match.slice(1).map(Number)
  return bytes.every((byte) => byte <= 255) ? bytes : null
}

/** Les 8 groupes de 16 bits d'une adresse IPv6 (forme abrégée « :: » et IPv4 en fin comprises), ou null. */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(':')) return null
  let address = text
  const lastColon = address.lastIndexOf(':')
  const last = address.slice(lastColon + 1)
  if (last.includes('.')) {
    const v4 = parseIpv4(last)
    if (!v4) return null
    address = `${address.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = address.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const left = groups(halves[0])
  const right = halves.length === 2 ? groups(halves[1]) : []
  if (halves.length === 2 ? left.length + right.length > 7 : left.length !== 8) return null
  const all = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  if (!all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null
  return all.map((group) => parseInt(group, 16))
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false // « ce réseau », réseau privé, ce PC
  if (a === 100 && b >= 64 && b <= 127) return false // partagé (opérateurs, Tailscale)
  if (a === 169 && b === 254) return false // lien local (et l'adresse des métadonnées des serveurs loués)
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // réservé, documentation
  if (a === 198 && (b === 18 || b === 19)) return false // tests de réseau
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false // documentation
  return a < 224 // multicast, réservé, diffusion
}

function isPublicIpv6(h: number[]): boolean {
  const embedded = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff]
  const zeros = (from: number, to: number): boolean => h.slice(from, to).every((group) => group === 0)
  if (zeros(0, 6)) return false // « :: », ce PC (::1), IPv4 compatible (obsolète)
  if (zeros(0, 5) && h[5] === 0xffff) return isPublicIpv4(embedded(h[6], h[7])) // ::ffff:a.b.c.d
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return isPublicIpv4(embedded(h[6], h[7])) // ::ffff:0:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPublicIpv4(embedded(h[6], h[7])) // NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return false // NAT64 local
  if (h[0] === 0x2002) return isPublicIpv4(embedded(h[1], h[2])) // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return false // adresses locales uniques
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return false // lien local, site local
  if ((h[0] & 0xff00) === 0xff00) return false // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false // documentation
  if (h[0] === 0x0100 && zeros(1, 4)) return false // poubelle
  return true
}

/** Une adresse IP joignable sur internet — pas ce PC, ni la box, ni un appareil du réseau local. Un nom n'en est pas une. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const v4 = parseIpv4(ip)
  if (v4) return isPublicIpv4(v4)
  const v6 = parseIpv6(ip)
  return v6 ? isPublicIpv6(v6) : false
}

/** Adresse refusée : levée au moment de la connexion, puis rendue par readWebPage avec une phrase pour Léo. */
export class BlockedAddressError extends Error {
  constructor(readonly host: string) {
    super(`adresse non publique : ${host}`)
    this.name = 'BlockedAddressError'
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void

/**
 * Résolution DNS de la connexion elle-même (undici → net.connect) : TOUTES les adresses du nom doivent être publiques.
 * Vérifiée là, sur l'adresse vraiment contactée — un nom qui change d'adresse entre une vérification et la connexion
 * (« DNS rebinding ») ne passe pas.
 */
export function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    if (!addresses.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
    const refused = addresses.find((entry) => !isPublicAddress(entry.address))
    if (refused) return callback(new BlockedAddressError(`${hostname} (${refused.address})`))
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

let dispatcher: Agent | null = null
function publicOnlyDispatcher(): Agent {
  dispatcher ??= new Agent({ connect: { lookup: publicOnlyLookup as never } })
  return dispatcher
}

function blockedError(url: string): Error {
  // Comme une page introuvable (étape 355) : l'adresse choisie par le modèle est en cause, pas Jaris (Duel).
  const error = new Error(t('page.blockedAddress', { url }))
  error.name = 'PageHttpError'
  return error
}

const isBlocked = (err: unknown): boolean =>
  err instanceof BlockedAddressError || (err as { cause?: unknown } | null)?.cause instanceof BlockedAddressError

/** Le corps, mais pas au-delà de `maxBytes` : la suite n'est jamais téléchargée. Décodé en UTF-8, comme avant. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const kept = value.length > maxBytes - size ? value.subarray(0, maxBytes - size) : value
      chunks.push(kept)
      size += kept.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

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

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let current = parsed
  let response: Response
  for (let redirects = 0; ; redirects++) {
    // Une adresse IP écrite telle quelle ne passe pas par le DNS : vérifiée ici (le nom, lui, l'est à la connexion).
    const host = current.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !isPublicAddress(host)) throw blockedError(current.href)
    try {
      // Redirections suivies À LA MAIN : chacune est revérifiée avant d'être contactée.
      response = await fetch(current, { signal, redirect: 'manual', dispatcher: publicOnlyDispatcher() as object } as RequestInit)
    } catch (err) {
      if (isBlocked(err)) throw blockedError(current.href)
      throw new Error(t('page.loadFailed', { url, error: err instanceof Error ? err.message : String(err) }))
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null
    if (!location) break
    await response.body?.cancel().catch(() => {})
    let next: URL | null = null
    try {
      next = new URL(location, current)
    } catch {
      next = null
    }
    if (!next || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
      const error = new Error(t('page.httpError', { url, status: response.status }))
      error.name = 'PageHttpError'
      throw error
    }
    if (redirects >= MAX_REDIRECTS) {
      const error = new Error(t('page.tooManyRedirects', { url }))
      error.name = 'PageHttpError'
      throw error
    }
    current = next
  }

  if (!response.ok) {
    // Étape 355 (Duel) : le site a répondu, mais pas avec la page (404 d'une adresse inventée…). C'est l'adresse choisie
    // par le modèle qui est en cause, pas Jaris ni internet — le Duel le distingue par ce nom.
    await response.body?.cancel().catch(() => {})
    const error = new Error(t('page.httpError', { url, status: response.status }))
    error.name = 'PageHttpError'
    throw error
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('html') && !contentType.includes('text/plain')) {
    await response.body?.cancel().catch(() => {})
    return `Contenu de ${url} non lisible en texte (type "${contentType || 'inconnu'}").`
  }

  let html: string
  try {
    html = await readCapped(response, MAX_PAGE_BYTES)
  } catch (err) {
    throw new Error(t('page.loadFailed', { url, error: err instanceof Error ? err.message : String(err) }))
  }
  const text = htmlToText(html)
  if (!text) return `Page ${url} chargée mais aucun texte lisible n'a pu en être extrait.`

  const truncated = text.length > MAX_TEXT_LENGTH
  return truncated ? `${text.slice(0, MAX_TEXT_LENGTH)}… (contenu tronqué)` : text
}
