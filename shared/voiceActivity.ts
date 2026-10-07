/**
 * Étape 252 — ce que Jaris est en train de faire, affiché sous la phrase entendue en mode vocal. Léo (06/10/2026) :
 * « j'ai attendu 1 min sans rien, il doit soit nous dire ce qu'il fait ou soit il bug ». En voix, rien ne s'affichait
 * entre la phrase dite et la réponse : ni la réflexion du modèle (jusqu'à 2 min dans son journal), ni les étapes du
 * pilotage. Rien n'est lu à voix haute (raconter chaque étape serait pénible) : c'est une ligne à l'écran, avec le
 * temps écoulé, qui avance même quand rien d'autre ne bouge — la différence entre « il travaille » et « il est
 * bloqué ». Module pur : traduit les lignes du journal (onLog) en phrases courtes, testé sans Electron.
 */

/** Ce qu'on affiche avant toute autre information : le modèle réfléchit. */
export const THINKING_ACTIVITY = 'Je réfléchis'

const TOOL_ACTIVITY: Record<string, string> = {
  computer_use_task: "Je prends la main sur l'écran",
  look_at_screen: "Je regarde l'écran",
  search_web: 'Je cherche sur internet',
  open_app: "J'ouvre l'application",
  generate_image: "Je dessine l'image",
  set_reminder: 'Je prépare le rappel',
  remember: 'Je retiens ça',
  recall_memory: 'Je cherche dans ma mémoire'
}

/** Une étape du pilotage (« Étape 2/20 : … ») en phrase courte ; `null` si la ligne ne dit rien d'utile à l'écran. */
function stepActivity(step: string, detail: string): string | null {
  const d = detail.trim().replace(/[.…]+$/u, '')
  const aim = d.match(/^je vise précisément (.+)$/iu)
  if (aim) return `Étape ${step} : je vise ${aim[1]}`
  if (/^je regarde l'écran/iu.test(d)) return `Étape ${step} : je regarde l'écran`
  // Étape 256 : l'étape planifiée sans image, d'après la liste des boutons que Windows donne.
  if (/^je lis les boutons/iu.test(d)) return `Étape ${step} : je lis les boutons`
  const named = d.match(/^clic sur "(.+?)"/iu)
  if (named) return `Étape ${step} : je clique sur « ${named[1]} »`
  const target = d.match(/^clic \w+ sur (.+?) à \(/iu)
  if (target) return `Étape ${step} : je clique sur ${target[1]}`
  if (/^clic /iu.test(d)) return `Étape ${step} : je clique`
  if (/^texte tapé/iu.test(d)) return `Étape ${step} : j'écris le texte`
  if (/^touche /iu.test(d)) return `Étape ${step} : j'appuie sur une touche`
  if (/^attente/iu.test(d)) return `Étape ${step} : j'attends que la page charge`
  if (/introuvable/iu.test(d)) return `Étape ${step} : je cherche autrement`
  return null
}

/** Traduit une ligne du journal en activité affichable ; `null` = la ligne ne change pas ce qu'on affiche. */
export function activityFromLog(line: string): string | null {
  const step = line.match(/^Étape (\d+)\/\d+ : (.+)$/u)
  if (step) return stepActivity(step[1], step[2])
  const tool = line.match(/^Outil appelé : (\w+)\(/u)
  if (tool) return TOOL_ACTIVITY[tool[1]] ?? "J'utilise un outil"
  if (/^Action à l'écran demandée/u.test(line)) return "Je prends la main sur l'écran"
  if (/^Résultat de l'outil/u.test(line)) return 'Je prépare la réponse'
  return null
}

/** « Je réfléchis… 45 s » : le compteur avance chaque seconde, preuve que Jaris n'est pas figé. */
export function formatActivity(activity: string, elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const elapsed = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`
  return `${activity}… ${elapsed}`
}
