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
    // de ce dépôt l'active déjà (search.formats: [html, json], server.limiter: false), mais SearXNG ne relit
    // ce fichier qu'au démarrage du conteneur : un conteneur déjà lancé avant/sans cette config (ou qui n'a
    // simplement jamais redémarré depuis) continue de refuser le JSON tant qu'il n'est pas relancé.
    const hint =
      response.status === 403
        ? " (le format JSON est-il bien activé côté SearXNG ? vérifie searxng/settings.yml (formats: json, " +
          "limiter: false) puis redémarre le conteneur avec \"docker compose restart\" pour qu'il reprenne " +
          'en compte ce fichier)'
        : ''
    throw new Error(`SearXNG a répondu ${response.status}${hint} : ${await response.text()}`)
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return `Aucun résultat trouvé pour "${query}".`

  return results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n')
}
