import { protocol } from 'electron'
import { randomUUID } from 'crypto'

const SCHEME = 'jaris-preview'
const previews = new Map<string, string>()

/** Avant app.ready : origine dédiée, sans contourner la CSP ni accéder aux fichiers du disque. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])
}

/** Le HTML provient uniquement d'une génération terminée ; aucune URL ne sert de chemin de fichier. */
export function createGeneratedAppPreview(html: string): string {
  const id = randomUUID()
  previews.set(id, html)
  // Seul le dernier projet est affiché ; garder quelques versions permet les retours Code/Aperçu.
  if (previews.size > 20) previews.delete(previews.keys().next().value as string)
  return `${SCHEME}://${id}/index.html`
}

export function registerPreviewHandler(): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    const html = url.pathname === '/index.html' && !url.search && !url.username && !url.password && !url.port
      ? previews.get(url.hostname) : undefined
    if (request.method !== 'GET' || html === undefined) return new Response('Aperçu introuvable', { status: 404 })
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()',
        // Autoriser le JS généré seulement dans cette page sandboxée ; aucune requête réseau ou iframe.
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"
      }
    })
  })
}
