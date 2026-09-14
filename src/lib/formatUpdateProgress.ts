import { formatBytes } from '../../shared/formatBytes'
import type { UpdateProgress } from '../../shared/ipc'

/**
 * Ligne affichée pendant une mise à jour de Jaris (étape 98), au-dessus de la barre de progression.
 *
 * Fonction PURE et à part, comme formatRecentDate/computeScaledSize : c'est la seule chose que Léo lit
 * pendant les minutes que dure le téléchargement, donc elle mérite d'être vérifiée par un vrai test plutôt
 * que relue dans un JSX.
 *
 * `null` = la demande vient de partir, aucun octet n'est encore arrivé : dire "0 %" à ce moment-là ferait
 * croire à un blocage alors que la connexion au serveur est simplement en train de s'établir.
 */
export function formatUpdateProgress(progress: UpdateProgress | null): string {
  if (!progress) return 'Connexion à GitHub…'
  if (progress.phase === 'install') {
    return 'Téléchargement terminé. Jaris se ferme, puis se rouvre tout seul une fois la mise à jour installée.'
  }
  if (progress.totalBytes === null) {
    return `Téléchargement : ${formatBytes(progress.receivedBytes)} reçus…`
  }
  return `Téléchargement : ${progress.percent} % — ${formatBytes(progress.receivedBytes)} sur ${formatBytes(progress.totalBytes)}`
}
