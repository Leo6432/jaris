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
    throw new Error(`SearXNG a répondu ${response.status} : ${await response.text()}`)
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return `Aucun résultat trouvé pour "${query}".`

  return results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n')
}
