import { config } from '../config'
import { readSearxngContainerSettings } from './dependencyServices'
import type { WebSource } from '../../shared/ipc'

interface SearxngResult {
  title: string
  url: string
  content?: string
}

interface SearxngResponse {
  results?: SearxngResult[]
}

const MAX_RESULTS = 5

/**
 * Interroge l'instance SearXNG locale : un résumé texte des meilleurs résultats pour le modèle, et depuis
 * l'étape 273 les pages trouvées (titre, adresse) pour les montrer à Léo dans le Chat. Seules les adresses
 * http(s) sont gardées : le Chat en fait des liens cliquables.
 */
export async function searchWebDetailed(query: string): Promise<{ text: string; sources: WebSource[] }> {
  const url = new URL('/search', config.searxng.host)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  let response: Response
  try {
    response = await fetch(url)
  } catch {
    // Étape 234 (bêta) : ce message arrive tel quel à l'écran — « docker compose up -d » ne disait rien à Léo.
    throw new Error(
      `La recherche web ne répond pas : son service (SearXNG, que Jaris lance avec Docker Desktop) n'est pas démarré. ` +
        `Jaris le démarre tout seul à l'ouverture ; si ça continue, ouvre Docker Desktop, attends qu'il soit prêt, puis réessaie. (${config.searxng.host})`
    )
  }

  if (!response.ok) {
    // Ce message atteint maintenant Léo TEL QUEL (assistant.ts renvoie directement le résultat d'un outil en
    // échec, sans repasser par le modèle de conversation qui a démontré en usage réel inventer un dépannage
    // générique faux à sa place — voir CLAUDE.md) : le rédiger pour un humain non technique, jamais supposer
    // qu'il sera reformulé.
    //
    // 403 sur ?format=json précisément (jamais sur la recherche HTML normale) : SearXNG refuse ce format par
    // défaut pour décourager le scraping à grande échelle des instances PUBLIQUES — searxng/settings.yml de
    // ce dépôt l'active déjà (search.formats: [html, json], server.limiter: false). Ce texte exact ("You
    // don't have the permission...") EST la page d'erreur par défaut de Flask/Werkzeug (le framework de
    // SearXNG lui-même), vérifié dans son code source — PAS une page Apache d'un autre logiciel comme on l'a
    // cru un temps (v0.3.9, diagnostic erroné basé sur une identification non vérifiée du texte). Le conteneur
    // SearXNG répond donc bien lui-même, mais sa config chargée en mémoire ne contient toujours pas "json"
    // dans search.formats malgré 3 correctifs déjà tentés (v0.3.6/v0.3.7/v0.3.9) et le fichier correct sur le
    // disque : plus de promesse de "réparation automatique" tant que la vraie cause n'est pas confirmée —
    // readSearxngContainerSettings() (dependencyServices.ts) donne enfin un vrai fait à comparer.
    const bodySnippet =
      response.status === 403
        ? (await response.text())
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300)
        : await response.text()
    if (response.status === 403) {
      const containerSettings = await readSearxngContainerSettings()
      throw new Error(
        `La recherche web est bloquée par SearXNG (erreur 403, format JSON refusé). Contenu renvoyé par ` +
          `SearXNG : "${bodySnippet}". Fichier de configuration tel que le conteneur le voit RÉELLEMENT en ce ` +
          `moment : ${containerSettings ? `"${containerSettings.slice(0, 500)}"` : 'impossible à lire (Docker indisponible ?)'}. ` +
          `Transmets ce message exact en entier (les deux parties entre guillemets) pour qu'on trouve enfin la vraie cause.`
      )
    }
    throw new Error(`SearXNG a répondu ${response.status} : ${bodySnippet}`)
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return { text: `Aucun résultat trouvé pour "${query}".`, sources: [] }

  return {
    text: results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n'),
    sources: results.filter((r) => /^https?:\/\//i.test(r.url)).map((r) => ({ title: r.title || r.url, url: r.url }))
  }
}
