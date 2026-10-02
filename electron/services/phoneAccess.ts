import type { ConverseRestrictions } from './assistant'

/**
 * Ce que Jaris peut faire quand le message vient du téléphone (étape 214). Choix de Léo : « tout sauf le
 * risqué » — discuter, chercher, retenir, rappels, images, ouvrir une application, mais jamais taper,
 * cliquer, regarder l'écran ni éteindre le PC : si quelqu'un vole le téléphone, il ne doit pas pouvoir
 * piloter le PC ni voir ce qui est affiché dessus.
 *
 * Une LISTE BLANCHE plutôt qu'une liste noire : un outil ajouté plus tard à tools.ts reste interdit depuis le
 * téléphone tant que quelqu'un n'a pas décidé, ici, qu'il était sans risque.
 */
export const PHONE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'open_app',
  'set_reminder',
  'search_web',
  'read_web_page',
  'remember',
  'recall_memory',
  'get_system_stats',
  'generate_image'
])

export const PHONE_REFUSAL =
  "Depuis ton téléphone, je ne peux pas taper, cliquer ni regarder ton écran : c'est bloqué pour ta sécurité. " +
  'Fais-le depuis le PC. Pour éteindre le PC, utilise le bouton d’extinction en haut de la page.'

export const PHONE_RESTRICTIONS: ConverseRestrictions = {
  allowedTools: PHONE_ALLOWED_TOOLS,
  note:
    "Ce message vient du téléphone de l'utilisateur, loin du PC. Depuis le téléphone, tu ne peux ni taper, ni " +
    "cliquer, ni regarder l'écran, ni éteindre le PC : ces outils n'existent pas ici. Si on te le demande, dis " +
    'simplement que c’est bloqué depuis le téléphone pour sa sécurité, sans rien inventer. Pour éteindre le PC, ' +
    'il existe un bouton d’extinction en haut de la page du téléphone : indique-le.',
  refusal: PHONE_REFUSAL
}

/** Outil en cours -> phrase affichée sur le téléphone (jamais le nom technique ni ses arguments). */
const TOOL_STATUS: Record<string, string> = {
  search_web: 'Recherche sur le web…',
  read_web_page: 'Lecture de la page…',
  generate_image: "Dessin de l'image…",
  open_app: "Ouverture de l'application sur le PC…",
  set_reminder: 'Programmation du rappel…',
  remember: 'Je retiens…',
  recall_memory: 'Je cherche dans ma mémoire…',
  get_system_stats: "Lecture de l'état du PC…"
}

/**
 * Traduit une ligne du journal de Jaris (onLog) en phrase de progression pour le téléphone, ou `null` si la
 * ligne n'a rien à montrer. Le journal contient des détails techniques (arguments d'outils, modèles) : seul
 * ce qui est utile à Léo ressort, en français courant.
 */
export function phoneStatusFromLog(line: string): string | null {
  const tool = line.match(/^Outil appelé : ([a-z_]+)\(/)
  if (tool) return TOOL_STATUS[tool[1]] ?? 'Jaris travaille…'
  if (/^Dessin : étape (\d+) sur (\d+)/.test(line)) return line.replace(/^Dessin : /, 'Dessin : ')
  if (/^Modèle (choisi|choisi à la main) :/.test(line)) return 'Jaris réfléchit…'
  return null
}
