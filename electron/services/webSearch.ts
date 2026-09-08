import { config } from '../config'

interface SearxngResult {
  title: string
  url: string
  content?: string
}

interface SearxngResponse {
  results?: SearxngResult[]
}

const MAX_RESULTS = 5

/** Interroge l'instance SearXNG locale et renvoie un résumé texte des meilleurs résultats. */
export async function searchWeb(query: string): Promise<string> {
  const url = new URL('/search', config.searxng.host)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error(`Impossible de joindre SearXNG sur ${config.searxng.host} (le conteneur Docker est-il lancé ? "docker compose up -d")`)
  }

  if (!response.ok) {
    // 403 sur ?format=json précisément (jamais sur la recherche HTML normale) : SearXNG refuse ce format
    // par défaut pour décourager le scraping à grande échelle des instances PUBLIQUES — searxng/settings.yml
    // de ce dépôt l'active déjà (search.formats: [html, json], server.limiter: false). ensureSearxngRunning
    // (dependencyServices.ts) teste et répare déjà ça tout seul à chaque démarrage de Jaris (recrée le
    // conteneur si le format JSON est refusé) : ce message ne devrait donc apparaître qu'entre deux
    // démarrages de Jaris (config modifiée à la main pendant que Jaris tourne déjà), jamais durablement.
    const hint =
      response.status === 403
        ? ' (vérifie searxng/settings.yml (formats: json, limiter: false) puis relance Jaris — la ' +
          'configuration est revérifiée et le conteneur recréé automatiquement si besoin à chaque démarrage)'
        : ''
    throw new Error(`SearXNG a répondu ${response.status}${hint} : ${await response.text()}`)
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return `Aucun résultat trouvé pour "${query}".`

  return results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n')
}
