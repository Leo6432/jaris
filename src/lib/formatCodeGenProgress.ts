import type { CodeGenProgress } from '../../shared/ipc'

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

export interface CodeGenProgressText {
  /** Ligne principale : où on en est ("Étape 2 sur 2 · Relecture du code"). */
  title: string
  /** Ligne de détail : depuis combien de temps, et ce que le modèle est en train de faire. */
  detail: string
}

/**
 * `progress` vaut `null` tant que le modèle n'a pas commencé (Jaris prépare la demande, ou télécharge le
 * modèle de code au tout premier usage — le journal juste en dessous le dit alors en clair).
 */
export function formatCodeGenProgress(progress: CodeGenProgress | null, elapsedMs: number): CodeGenProgressText {
  const elapsed = formatDuration(elapsedMs)
  if (!progress) {
    return { title: 'Préparation…', detail: elapsed }
  }

  const title = `Étape ${progress.stepIndex} sur ${progress.stepCount} · ${progress.label}`

  // L'ordre compte : un silence prolongé est l'information la plus utile du moment, il passe devant le
  // reste. Sinon, les caractères écrits (qui montent) prouvent que ça avance.
  if (progress.idleMs >= STALL_HINT_MS) {
    return { title, detail: `${elapsed} · rien reçu du modèle depuis ${formatDuration(progress.idleMs)}` }
  }
  if (progress.charsWritten > 0) {
    return { title, detail: `${elapsed} · ${progress.charsWritten.toLocaleString('fr-FR')} caractères écrits` }
  }
  return { title, detail: `${elapsed} · le modèle réfléchit…` }
}
