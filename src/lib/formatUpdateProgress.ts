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
  if (!progress) return 'Connexion au serveur de téléchargement…'
  if (progress.phase === 'install') {
    // Deux fins très différentes, à ne jamais confondre : Jaris se ferme et se rouvre tout seul, alors que
    // l'installeur d'Ollama n'a AUCUN mode silencieux documenté — il ouvre sa propre fenêtre et attend un
    // clic. Afficher "ça se termine tout seul" dans ce cas serait une promesse fausse, et Léo attendrait
    // devant un écran qui ne bougera jamais (même famille que les fausses confirmations déjà corrigées).
    return progress.target === 'ollama'
      ? "Téléchargement terminé. Termine l'installation dans la fenêtre d'Ollama qui vient de s'ouvrir."
      : 'Téléchargement terminé. Jaris se ferme, puis se rouvre tout seul une fois la mise à jour installée.'
  }
  const quoi = progress.target === 'ollama' ? "Téléchargement d'Ollama" : 'Téléchargement'
  if (progress.totalBytes === null) {
    return `${quoi} : ${formatBytes(progress.receivedBytes)} reçus…`
  }
  return `${quoi} : ${progress.percent} % — ${formatBytes(progress.receivedBytes)} sur ${formatBytes(progress.totalBytes)}`
}
