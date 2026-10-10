import type { CodeGenProgress, CodeLiveWrite } from '../../shared/ipc'

/**
 * Ce que Léo lit pendant qu'une génération tourne (mode Code, étape 99) — le seul retour qu'il ait pendant
 * des minutes entières, donc une fonction PURE et testée à part plutôt qu'un bout de JSX, comme
 * formatRecentDate (étape 94) et formatUpdateProgress (étape 98).
 *
 * Au-delà de ce seuil sans le moindre fragment reçu du modèle, on le DIT au lieu de laisser deviner : c'est
 * toute la différence entre "c'est long" et "c'est bloqué", que rien n'exprimait avant.
 */
export const STALL_HINT_MS = 20_000

/** "45 s", "1 min 12", "2 h 05" — durée parlée, jamais un nombre de millisecondes. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, '0')}`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/**
 * La ligne « en direct » du mode Code (étape 288, Léo : « enlève ça [Étape 3 · … caractères écrits · Arrêter], on s'en
 * fout, mais mets ce qu'il fait en direct, par exemple code index.html plus 20 lignes »). Plus de numéro d'étape ni de
 * compteur de caractères : ce que Jaris FAIT — le fichier qu'il écrit et ses lignes —, sinon qu'il réfléchit.
 * L'arrêt se fait par le bouton du champ, comme dans le Chat.
 */
export interface CodeLiveText {
  /** « Écrit », « Modifie », « Relit », ou « Réfléchit… » / « Travaille… » quand aucun fichier n'est en cours. */
  action: string
  /** Le fichier en cours d'écriture, s'il y en a un. */
  path: string | null
  /** « +20 lignes », dès la première ligne reçue. */
  lines: string | null
  /** Un silence prolongé du modèle, dit en clair plutôt que laissé à deviner (« c'est long » ≠ « c'est bloqué »). */
  stall: string | null
}

const LIVE_VERB: Record<CodeLiveWrite['kind'], string> = { write: 'Écrit', edit: 'Modifie', review: 'Relit' }

export function formatCodeLive(live: CodeLiveWrite | null, progress: CodeGenProgress | null): CodeLiveText {
  const stall = progress && progress.idleMs >= STALL_HINT_MS ? `rien reçu du modèle depuis ${formatDuration(progress.idleMs)}` : null
  if (live) {
    return {
      action: LIVE_VERB[live.kind],
      path: live.path,
      lines: live.lines > 0 ? `+${live.lines} ${live.lines === 1 ? 'ligne' : 'lignes'}` : null,
      stall
    }
  }
  return { action: !progress || progress.thinking ? 'Réfléchit…' : 'Travaille…', path: null, lines: null, stall }
}
