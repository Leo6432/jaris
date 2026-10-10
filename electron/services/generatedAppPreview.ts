import { protocol } from 'electron'
import { randomUUID } from 'crypto'

const SCHEME = 'jaris-preview'

/**
 * Ce qu'un aperçu sert : une seule page (application générée), ou les fichiers d'un dépôt GitHub (étape 287, Léo :
 * « à droite faut pas que c'est le menu pour enregistrer sur GitHub, mais pouvoir jouer directement et tester un
 * vrai aperçu »). `read` rend le contenu d'un chemin du dépôt (changements préparés compris), `undefined` s'il
 * n'existe pas.
 */
export type FilesPreviewSource = { kind: 'files'; entry: string; read: (path: string) => Promise<Uint8Array | string | undefined> }
type PreviewSource = { kind: 'html'; html: string } | FilesPreviewSource

const previews = new Map<string, PreviewSource>()

/** Avant app.ready : origine dédiée, sans contourner la CSP ni accéder aux fichiers du disque. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled/supportFetchAPI (étape 287) : un site de dépôt charge ses polices, ses modules et parfois ses
    // données (fetch) depuis ses propres fichiers — des requêtes CORS qu'un protocole maison refuse sans ça.
    { scheme: SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }
  ])
}

function remember(source: PreviewSource): string {
  const id = randomUUID()
  previews.set(id, source)
  // Seul le dernier projet est affiché ; garder quelques versions permet les retours Code/Aperçu.
  if (previews.size > 20) previews.delete(previews.keys().next().value as string)
  return id
}

/** Le HTML provient uniquement d'une génération terminée ; aucune URL ne sert de chemin de fichier. */
export function createGeneratedAppPreview(html: string): string {
  return `${SCHEME}://${remember({ kind: 'html', html })}/index.html`
}

/**
 * Aperçu d'un dépôt (étape 287) : `entry` est la page d'accueil (index.html le plus souvent), servie avec les autres
 * fichiers du dépôt à côté d'elle, pour que ses liens relatifs (style.css, jeu.js, images/…) fonctionnent.
 */
export function createFilesPreview(entry: string, read: FilesPreviewSource['read']): string {
  const id = remember({ kind: 'files', entry, read })
  return `${SCHEME}://${id}/${entry.split('/').map(encodeURIComponent).join('/')}`
}

/** Règles de l'aperçu, reprises telles quelles par le test de code (scripts/benchmark-browser.mjs, étape 232). */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms"

/**
 * Règles d'un aperçu de dépôt (étape 287). Les fichiers du dépôt lui-même (`jaris-preview:`), et le web en https :
 * un vrai site charge souvent une bibliothèque, une police ou des images depuis Internet, et doit s'afficher comme
 * une fois mis en ligne. Le reste ne change pas : page isolée (sandbox sans allow-same-origin, donc aucun accès à
 * Jaris ni au disque), aucun envoi de formulaire, aucune page imbriquée.
 */
export const REPO_PREVIEW_CSP =
  `default-src 'none'; script-src ${SCHEME}: https: 'unsafe-inline' 'unsafe-eval'; style-src ${SCHEME}: https: 'unsafe-inline'; ` +
  `img-src ${SCHEME}: https: data: blob:; media-src ${SCHEME}: https: data: blob:; font-src ${SCHEME}: https: data:; ` +
  `connect-src ${SCHEME}: https:; frame-src 'none'; base-uri ${SCHEME}:; form-action 'none'; sandbox allow-scripts allow-forms`

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm'
}

export function previewContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Le chemin demandé, dans le dépôt : jamais `..` ni `.` (rien ne sort du dépôt), un dossier sert son index.html.
 * `null` si le chemin est refusé.
 */
export function previewPath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const parts = decoded.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '..' || part === '.')) return null
  if (parts.length === 0 || decoded.endsWith('/')) parts.push('index.html')
  return parts.join('/')
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()'
}

/** Sert un fichier d'un aperçu de dépôt. Exporté pour être testé sans Electron. */
export async function serveFilesPreview(source: FilesPreviewSource, pathname: string): Promise<Response> {
  const path = previewPath(pathname)
  if (path === null) return new Response('Chemin refusé', { status: 400 })
  // Un site publié depuis un sous-dossier (docs/, public/…) écrit souvent « /style.css » pour un fichier rangé à côté
  // de sa page : sans ce second essai, ce lien pointerait à la racine du dépôt et l'aperçu s'afficherait sans style.
  const entryDir = source.entry.includes('/') ? source.entry.slice(0, source.entry.lastIndexOf('/')) : ''
  let content = await source.read(path)
  if (content === undefined && entryDir && !path.startsWith(`${entryDir}/`)) content = await source.read(`${entryDir}/${path}`)
  if (content === undefined) return new Response('Fichier introuvable dans le dépôt', { status: 404 })
  return new Response(typeof content === 'string' ? content : new Uint8Array(content), {
    headers: {
      ...BASE_HEADERS,
      'Content-Type': previewContentType(path),
      // Page isolée = origine « null » : sans cet en-tête, ses polices et ses modules (requêtes CORS) sont refusés.
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': REPO_PREVIEW_CSP
    }
  })
}

export function registerPreviewHandler(): void {
  // Pas « async » : une application générée garde sa réponse immédiate, exactement comme avant ; seul l'aperçu d'un
  // dépôt rend une promesse (ses fichiers peuvent venir de GitHub). protocol.handle accepte les deux.
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    const source = request.method === 'GET' && !url.username && !url.password && !url.port ? previews.get(url.hostname) : undefined
    if (source?.kind === 'files') return serveFilesPreview(source, url.pathname)
    const html = source?.kind === 'html' && url.pathname === '/index.html' && !url.search ? source.html : undefined
    if (html === undefined) return new Response('Aperçu introuvable', { status: 404 })
    return new Response(html, {
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        // Autoriser le JS généré seulement dans cette page sandboxée ; aucune requête réseau ou iframe.
        // allow-forms (étape 232) : sans lui, le navigateur ne déclenche même pas l'évènement « submit » — un
        // formulaire généré (contact, inscription...) ne réagissait JAMAIS au clic, même avec un code juste.
        // form-action 'none' bloque toujours tout envoi réel : seul le code de la page voit le formulaire.
        'Content-Security-Policy': PREVIEW_CSP
      }
    })
  })
}
