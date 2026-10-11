import type { ConverseRestrictions } from './assistant'
import { t, type MessageKey } from '../../shared/i18n'
import { imageStepFromLog } from '../../shared/imageGallery'

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

/** Étape 293 : dans la langue de Jaris au moment du refus (elle peut changer pendant que le téléphone est relié). */
export function phoneRefusal(): string {
  return t('phone.refusal')
}

export const PHONE_RESTRICTIONS: ConverseRestrictions = {
  allowedTools: PHONE_ALLOWED_TOOLS,
  note:
    "Ce message vient du téléphone de l'utilisateur, loin du PC. Depuis le téléphone, tu ne peux ni taper, ni " +
    "cliquer, ni regarder l'écran, ni éteindre le PC : ces outils n'existent pas ici. Si on te le demande, dis " +
    'simplement que c’est bloqué depuis le téléphone pour sa sécurité, sans rien inventer. Pour éteindre le PC, ' +
    'il existe un bouton d’extinction en haut de la page du téléphone : indique-le.',
  get refusal() {
    return phoneRefusal()
  }
}

/** Outil en cours -> phrase affichée sur le téléphone (jamais le nom technique ni ses arguments). */
const TOOL_STATUS: Record<string, MessageKey> = {
  search_web: 'phone.status.search_web',
  read_web_page: 'phone.status.read_web_page',
  generate_image: 'phone.status.generate_image',
  open_app: 'phone.status.open_app',
  set_reminder: 'phone.status.set_reminder',
  remember: 'phone.status.remember',
  recall_memory: 'phone.status.recall_memory',
  get_system_stats: 'phone.status.get_system_stats'
}

/**
 * Traduit une ligne du journal de Jaris (onLog) en phrase de progression pour le téléphone, ou `null` si la
 * ligne n'a rien à montrer. Le journal contient des détails techniques (arguments d'outils, modèles) : seul
 * ce qui est utile à Léo ressort, en français courant.
 */
export function phoneStatusFromLog(line: string): string | null {
  const tool = line.match(/^Outil appelé : ([a-z_]+)\(/)
  if (tool) return t(TOOL_STATUS[tool[1]] ?? 'phone.status.working')
  // Étape 293 : « Dessin : 2/4 » (le mot suit la langue, voir imageGenerator) ; l'ancienne forme reste reconnue.
  const step = imageStepFromLog(line)
  if (step && (line.startsWith(`${t('engine.step.image')} :`) || /^Dessin : étape/.test(line))) {
    return t('common.labelValue', { label: t('engine.step.image'), value: `${step.step}/${step.total}` })
  }
  if (/^Modèle (choisi|choisi à la main) :/.test(line)) return t('phone.status.thinking')
  return null
}
