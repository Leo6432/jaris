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
/** Étape 424 : les rubriques de « Découvrir », dans l'ordre de la liste de Léo. */
export const MCP_CATEGORIES = ['productivity', 'design', 'marketing', 'dev', 'crm', 'commerce', 'analytics', 'messaging'] as const
export type McpCategory = (typeof MCP_CATEGORIES)[number]

export interface McpCatalogEntry {
  id: string
  /** Nom du service (une marque : jamais traduit). */
  name: string
  url: string
  category: McpCategory
  /** Fichier du logo dans src/assets/mcp-logos (sans « .png ») quand il diffère de `id` (Adobe CJA → adobe). */
  logo?: string
}

/**
 * Étape 424 (Léo : « ajoute ça et aussi les logos des entreprises, pas des lettres », avec sa liste par rubrique) :
 * chaque adresse vérifiée le 05/11/2026 sur la documentation de l'entreprise ou le registre officiel MCP (espace de
 * noms vérifié par domaine), PUIS sur le serveur lui-même : réponse 401 (connexion par compte) et serveur d'autorisation
 * qui publie une inscription dynamique (`registration_endpoint`) avec PKCE S256 — lecture publique, aucune inscription
 * faite. Écartés de sa liste, faute de connexion possible pour Jaris : Gmail et Google Agenda (projet Google Cloud à
 * créer), D&B et GitHub (pas d'inscription dynamique), Vercel (connexion refusée aux applis non validées), Goodnotes
 * (adresse réservée à Claude), Salesforce (application à créer dans Salesforce), Hive (clé dans l'adresse),
 * ActiveCampaign, Zoho CRM et Bigin (adresse propre à chaque compte : « + Ajouter »), Ample Computer (introuvable).
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // Productivité, mail et agenda
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', category: 'productivity' },
  { id: 'fastmail', name: 'Fastmail', url: 'https://api.fastmail.com/mcp', category: 'productivity' },
  { id: 'superhuman', name: 'Superhuman Mail', url: 'https://mcp.mail.superhuman.com/mcp', category: 'productivity' },
  { id: 'paperoffice', name: 'PaperOffice', url: 'https://mcp.paperoffice.ai/dms', category: 'productivity' },
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', category: 'productivity' },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', category: 'productivity' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', category: 'productivity' },
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', category: 'productivity' },
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', category: 'productivity' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', category: 'productivity' },
  // Design, vidéo et image
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', category: 'design' },
  { id: 'adobe', name: 'Adobe', url: 'https://adobe-creativity.adobe.io/mcp', category: 'design' },
  { id: 'moda', name: 'Moda', url: 'https://mcp.moda.app/mcp', category: 'design' },
  { id: 'cloudinary', name: 'Cloudinary', url: 'https://asset-management.mcp.cloudinary.com/mcp', category: 'design' },
  { id: 'orshot', name: 'Orshot', url: 'https://mcp.orshot.com/mcp', category: 'design' },
  { id: 'higgsfield', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', category: 'design' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', category: 'design' },
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', category: 'design' },
  // Réseaux sociaux et marketing
  { id: 'metricool', name: 'Metricool', url: 'https://ai.metricool.com/mcp', category: 'marketing' },
  { id: 'typefully', name: 'Typefully', url: 'https://mcp.typefully.com/mcp', category: 'marketing' },
  // Ancien protocole SSE seulement (POST → 404) : Jaris s'y rabat de lui-même (mcpHub.ts).
  { id: 'windsor', name: 'Windsor.ai', url: 'https://mcp.windsor.ai/sse', category: 'marketing' },
  { id: 'supermetrics', name: 'Supermetrics', url: 'https://mcp.supermetrics.com/mcp', category: 'marketing' },
  { id: 'adspirer', name: 'Adspirer', url: 'https://mcp.adspirer.com/mcp', category: 'marketing' },
  { id: 'motion', name: 'Motion', url: 'https://projects.motionapp.com/mcp', category: 'marketing' },
  // Dev et hébergement
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://bindings.mcp.cloudflare.com/mcp', category: 'dev' },
  { id: 'macaly', name: 'Macaly Cloud', url: 'https://www.macaly.com/api/cloud/mcp', category: 'dev' },
  { id: 'cpln', name: 'Control Plane', url: 'https://mcp.cpln.io/mcp', category: 'dev' },
  { id: 'codewords', name: 'CodeWords', url: 'https://runtime.codewords.ai/run/devx_mcp/mcp', category: 'dev' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', category: 'dev' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', category: 'dev' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', category: 'dev' },
  // CRM et ventes
  { id: 'nutshell', name: 'Nutshell', url: 'https://app.nutshell.com/mcp', category: 'crm' },
  { id: 'salesflare', name: 'Salesflare', url: 'https://mcp.salesflare.com/mcp', category: 'crm' },
  { id: 'salesloft', name: 'Salesloft', url: 'https://mcp.salesloft.com/mcp', category: 'crm' },
  { id: 'mychatbot', name: 'MyChatBot', url: 'https://connector.mychatbot.app/mcp', category: 'crm' },
  // E-commerce et paiements
  { id: 'fourthwall', name: 'Fourthwall', url: 'https://mcp.fourthwall.com', category: 'commerce' },
  { id: 'pinelabs', name: 'Pine Labs', url: 'https://mcp.pinelabs.com/mcp', category: 'commerce' },
  { id: 'airwallex', name: 'Airwallex', url: 'https://mcp.airwallex.com/mcp', category: 'commerce' },
  { id: 'plaid', name: 'Plaid', url: 'https://api.dashboard.plaid.com/mcp/', category: 'commerce' },
  // Analytics et finance
  { id: 'polar', name: 'Polar Analytics', url: 'https://api.polaranalytics.com/mcp', category: 'analytics' },
  { id: 'omni', name: 'Omni', url: 'https://callbacks.omniapp.co/callback/mcp', category: 'analytics' },
  { id: 'adobe-cja', name: 'Adobe CJA', url: 'https://cja-mcp.adobe.io/mcp', category: 'analytics', logo: 'adobe' },
  { id: 'datarails', name: 'Datarails', url: 'https://mcp.datarails.com/mcp', category: 'analytics' },
  { id: 'morningstar', name: 'Morningstar', url: 'https://mcp.morningstar.com/mcp', category: 'analytics' },
  // Messagerie
  { id: 'ringcentral', name: 'RingCentral Chat', url: 'https://mcp.labs.ringcentral.com/ringex/team-chat', category: 'messaging' }
]

export function catalogEntry(id: unknown): McpCatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null
}

/** La configuration d'une entrée : une adresse, sans clé (la connexion se fait par le compte de Léo). */
export function catalogTransport(entry: McpCatalogEntry): McpTransportConfig {
  return { kind: 'http', url: entry.url, headers: {} }
}

const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * Étape 425 (Léo : « ajoute une barre de recherche ») : une entrée de « Découvrir » correspond-elle à ce qui est tapé ?
 * Chaque mot tapé doit se trouver dans l'un des textes de la carte (nom, description, rubrique — affichés, donc dans la
 * langue de Léo), sans tenir compte des accents ni des majuscules. Rien de tapé : tout correspond.
 */
export function catalogMatches(query: string, texts: readonly string[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = fold(texts.join(' \n '))
  return words.every((word) => haystack.includes(word))
}
