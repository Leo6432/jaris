import { config } from '../config'
import { readSearxngContainerSettings } from './dependencyServices'
import type { WebSource } from '../../shared/ipc'
import { t } from '../../shared/i18n'

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
    throw new Error(t('search.down', { host: config.searxng.host }))
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
    // Étape 328 : le texte de la page d'erreur, sans balises et raccourci, pour TOUS les codes — un 500 ou un 502
    // affichait jusqu'ici la page HTML entière, balises comprises, dans le Chat ou lue à voix haute.
    const bodySnippet = (await response.text())
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    if (response.status === 403) {
      const containerSettings = await readSearxngContainerSettings()
      throw new Error(
        t('search.forbidden', {
          body: bodySnippet,
          settings: containerSettings ? `"${containerSettings.slice(0, 500)}"` : t('search.forbidden.unreadable')
        })
      )
    }
    throw new Error(t('search.httpError', { status: response.status, body: bodySnippet }))
  }

  const data = (await response.json()) as SearxngResponse
  const results = (data.results ?? []).slice(0, MAX_RESULTS)
  if (!results.length) return { text: t('search.noResult', { query }), sources: [] }

  return {
    text: results.map((r, i) => `${i + 1}. ${r.title} — ${r.content ?? ''} (${r.url})`).join('\n'),
    sources: results.filter((r) => /^https?:\/\//i.test(r.url)).map((r) => ({ title: r.title || r.url, url: r.url }))
  }
}
