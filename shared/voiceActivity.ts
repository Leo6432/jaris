import { t, type MessageKey } from './i18n'
/**
 * Étape 252 — ce que Jaris est en train de faire, affiché sous la phrase entendue en mode vocal. Léo (06/10/2026) :
 * « j'ai attendu 1 min sans rien, il doit soit nous dire ce qu'il fait ou soit il bug ». En voix, rien ne s'affichait
 * entre la phrase dite et la réponse : ni la réflexion du modèle (jusqu'à 2 min dans son journal), ni les étapes du
 * pilotage. Rien n'est lu à voix haute (raconter chaque étape serait pénible) : c'est une ligne à l'écran, avec le
 * temps écoulé, qui avance même quand rien d'autre ne bouge — la différence entre « il travaille » et « il est
 * bloqué ». Module pur : traduit les lignes du journal (onLog) en phrases courtes, testé sans Electron.
 */

/**
 * Étape 293 (24 langues) : les lignes du journal restent en français (diagnostic interne, et c'est sur elles que les
 * motifs ci-dessous s'appuient) ; seules les PHRASES AFFICHÉES passent par le catalogue, dans la langue de Jaris.
 */

/** Ce qu'on affiche avant toute autre information : le modèle réfléchit. */
export function thinkingActivity(): string {
  return t('activity.thinking')
}

const TOOL_ACTIVITY: Record<string, MessageKey> = {
  computer_use_task: 'activity.tool.computer',
  look_at_screen: 'activity.tool.look',
  search_web: 'activity.tool.search',
  open_app: 'activity.tool.openApp',
  generate_image: 'activity.tool.image',
  set_reminder: 'activity.tool.reminder',
  remember: 'activity.tool.remember',
  recall_memory: 'activity.tool.recall'
}

/** Une étape du pilotage (« Étape 2/20 : … ») en phrase courte ; `null` si la ligne ne dit rien d'utile à l'écran. */
function stepActivity(step: string, detail: string): string | null {
  const d = detail.trim().replace(/[.…]+$/u, '')
  const aim = d.match(/^je vise précisément (.+)$/iu)
  if (aim) return t('activity.step.aim', { step, target: aim[1] })
  if (/^je regarde l'écran/iu.test(d)) return t('activity.step.look', { step })
  // Étape 256 : l'étape planifiée sans image, d'après la liste des boutons que Windows donne.
  if (/^je lis les boutons/iu.test(d)) return t('activity.step.readButtons', { step })
  const named = d.match(/^clic sur "(.+?)"/iu)
  if (named) return t('activity.step.clickNamed', { step, name: named[1] })
  const target = d.match(/^clic \w+ sur (.+?) à \(/iu)
  if (target) return t('activity.step.clickOn', { step, target: target[1] })
  if (/^clic /iu.test(d)) return t('activity.step.click', { step })
  if (/^texte tapé/iu.test(d)) return t('activity.step.type', { step })
  if (/^touche /iu.test(d)) return t('activity.step.key', { step })
  if (/^attente/iu.test(d)) return t('activity.step.wait', { step })
  const opening = d.match(/^j'ouvre (.+)$/iu)
  if (opening) return t('activity.step.open', { step, app: opening[1] })
  if (/introuvable/iu.test(d)) return t('activity.step.retry', { step })
  return null
}

/** Traduit une ligne du journal en activité affichable ; `null` = la ligne ne change pas ce qu'on affiche. */
export function activityFromLog(line: string): string | null {
  const step = line.match(/^Étape (\d+)\/\d+ : (.+)$/u)
  if (step) return stepActivity(step[1], step[2])
  const tool = line.match(/^Outil appelé : (\w+)\(/u)
  if (tool) return t(TOOL_ACTIVITY[tool[1]] ?? 'activity.tool.other')
  if (/^Action à l'écran demandée/u.test(line)) return t('activity.tool.computer')
  if (/^Résultat de l'outil/u.test(line)) return t('activity.preparingReply')
  return null
}

/** « Je réfléchis… 45 s » : le compteur avance chaque seconde, preuve que Jaris n'est pas figé. */
export function formatActivity(activity: string, elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const elapsed =
    seconds < 60
      ? t('duration.seconds', { s: seconds })
      : t('duration.minutes', { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, '0') })
  return `${activity}… ${elapsed}`
}
