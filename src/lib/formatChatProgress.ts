import { t, type MessageKey } from '../../shared/i18n'
import { engineStepFromLine, engineStepLine } from '../../shared/imageGallery'
import { activityFromLog } from '../../shared/voiceActivity'
/**
 * Les journaux du moteur servent au diagnostic, mais le Chat et son widget ne doivent jamais afficher des
 * détails internes comme `Outil appelé : search_web(...)` ou le contenu brut de `Résultat de l'outil`.
 * On conserve seulement une indication utile et humaine pendant l'attente. `null` signifie : ignorer cette
 * ligne et garder l'indication précédente jusqu'à la réponse finale.
 *
 * LISTE D'AUTORISATION, comme phoneStatusFromLog (phoneAccess.ts) : seule une ligne reconnue s'affiche, tout le reste
 * vaut `null`. Jusqu'à la version 0.49.1, c'était une liste d'exclusion terminée par « afficher la ligne telle
 * quelle » : chaque nouvelle ligne du journal (en français, technique) apparaissait dans le Chat et le widget, par
 * exemple « Outils MCP proposés : … » à CHAQUE demande dès qu'un serveur MCP était actif, ou « VRAM utilisable
 * actuelle : … ».
 */

/**
 * Les phrases du journal ÉCRITES POUR L'UTILISATEUR (fabriquées par t(), donc dans la langue de Jaris, la même que
 * celle de cet écran) qui ont leur place pendant l'attente. Reconnues par leur gabarit dans la langue courante.
 * Celles qui citent un modèle ou une erreur brute (« pilot.textFailed », « image.gpuFreed »…) restent au journal.
 */
const SHOWN_AS_WRITTEN: MessageKey[] = [
  'log.notepad.preparing',
  'log.browserSearch.in',
  'log.browserSearch',
  'log.opening',
  'log.overload',
  'log.chosenModelGone',
  'pilot.takingOver',
  'pilot.borrow',
  'pilot.background',
  'image.translating',
  'image.translated',
  'image.preparing',
  'image.gpuDecodeRetry',
  'engine.finishing.image'
]

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Vrai si `line` est exactement le texte de `key` dans la langue courante, quelles que soient ses {variables}. */
function isWrittenFrom(line: string, key: MessageKey): boolean {
  const pattern = t(key)
    .trim()
    .split(/\{\w+\}/)
    .map(escapeRegExp)
    .join('[\\s\\S]+?')
  return new RegExp(`^${pattern}$`).test(line)
}

export function formatChatProgress(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed) return null

  if (/^(?:Question de connaissance sans recherche web|Outil appelé : search_web\b)/i.test(trimmed)) {
    return t('progress.searching')
  }
  if (/^Outil appelé : read_web_page\b/i.test(trimmed)) return t('progress.readingPage')
  if (/^Outil appelé : look_at_screen\b/i.test(trimmed)) return t('progress.readingScreen')
  if (/^Outil appelé : computer_use_task\b/i.test(trimmed) || /^Action à l'écran demandée/u.test(trimmed)) return t('progress.acting')
  // Étape 293 : une étape du pilotage (« Étape 2/20 : clic sur … ») est une ligne du journal, en français : elle
  // s'affiche par sa phrase traduite, ou pas du tout.
  if (/^Étape \d+\/\d+ :/u.test(trimmed)) return activityFromLog(trimmed)
  // « Dessin : 2/4 » : reconnue par la fonction qui fabrique aussi la ligne (shared/imageGallery), dans la langue courante.
  const drawing = engineStepFromLine(trimmed, 'engine.step.image')
  if (drawing) return engineStepLine('engine.step.image', drawing.step, drawing.total)

  return SHOWN_AS_WRITTEN.some((key) => isWrittenFrom(trimmed, key)) ? trimmed : null
}
