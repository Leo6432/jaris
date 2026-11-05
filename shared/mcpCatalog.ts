import type { McpTransportConfig } from './mcp'

/**
 * Étape 419 (Léo, captures des « Connecteurs » de Claude : « mets les MCP actifs ou désactivés, et mets Ajouter avec
 * une base de MCP » ; puis, devant une première base : « navigateur, c'est par défaut, et GitHub aussi, enlève tout, je
 * veux du Canva, Gmail, comme sur la capture ») : la base de « Découvrir ».
 *
 * Seulement les serveurs MCP OFFICIELS, en ligne, de chaque service, dont Jaris peut lui-même se servir avec le compte
 * de Léo (OAuth 2.1, mcpAuth.ts) : vérifié sur chacun (04/11/2026) que l'adresse répond 401 en Streamable HTTP et
 * que son serveur d'autorisation publie une inscription dynamique (`registration_endpoint`) avec PKCE S256.
 * Écartés après vérification : Gmail, Drive et Agenda de Google (aperçu développeur : il faut créer sa propre
 * application Google), Slack, HubSpot et Box (pas d'inscription dynamique : seulement les applications qu'ils ont
 * validées), GitHub et un navigateur (Jaris les a déjà). Zapier donne accès à Gmail et Google Agenda par le compte
 * Zapier de Léo.
 *
 * Le main construit la configuration à partir d'ICI : l'écran n'envoie que l'identifiant de l'entrée.
 */
export interface McpCatalogEntry {
  id: string
  /** Nom du service (une marque : jamais traduit). */
  name: string
  url: string
  /** Couleur de la pastille (initiale du service sur fond de sa couleur, pas son logo). */
  color: string
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', color: '#7d2ae8' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', color: '#191919' },
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', color: '#ff4f00' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', color: '#a259ff' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', color: '#1868db' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', color: '#5e6ad2' },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', color: '#e44332' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', color: '#18bfff' },
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', color: '#0061fe' },
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', color: '#e6b800' },
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', color: '#ff3d57' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', color: '#3ecf8e' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', color: '#ffb000' }
]

export function catalogEntry(id: unknown): McpCatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null
}

/** La configuration d'une entrée : une adresse, sans clé (la connexion se fait par le compte de Léo). */
export function catalogTransport(entry: McpCatalogEntry): McpTransportConfig {
  return { kind: 'http', url: entry.url, headers: {} }
}
