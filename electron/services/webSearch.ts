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
    // Ce message atteint maintenant Léo TEL QUEL (assistant.ts renvoie directement le résultat d'un outil en
    // échec, sans repasser par le modèle de conversation qui a démontré en usage réel inventer un dépannage
    // générique faux à sa place — voir CLAUDE.md) : le rédiger pour un humain non technique, jamais supposer
    // qu'il sera reformulé.
    //
    // 403 sur ?format=json précisément (jamais sur la recherche HTML normale) : SearXNG refuse ce format par
    // défaut pour décourager le scraping à grande échelle des instances PUBLIQUES — searxng/settings.yml de
    // ce dépôt l'active déjà (search.formats: [html, json], server.limiter: false), et ensureSearxngRunning
    // (dependencyServices.ts) teste/répare déjà ça à chaque démarrage de Jaris. Un 403 qui persiste malgré ça
    // (vécu par Léo, 2 correctifs déjà tentés v0.3.6/v0.3.7) reste possible pour une cause pas encore
    // identifiée avec certitude : ne plus promettre "c'est réparé tout seul", juste donner le fait brut.
    const bodySnippet =
      response.status === 403
        ? (await response.text())
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300)
        : await response.text()
    throw new Error(
      response.status === 403
        ? `La recherche web est bloquée par SearXNG (erreur 403, format JSON refusé). Contenu renvoyé par ` +
          `SearXNG : "${bodySnippet}". Ce n'est pas censé arriver : Jaris essaie de corriger ça tout seul à ` +
          `chaque démarrage. Si ça persiste après avoir complètement fermé puis relancé Jaris, transmets ce ` +
          `message exact (avec le contenu entre guillemets) pour qu'on trouve la vraie cause.`
        : `SearXNG a répondu ${response.status} : ${bodySnippet}`
    )
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return `Aucun résultat trouvé pour "${query}".`

  return results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n')
}
