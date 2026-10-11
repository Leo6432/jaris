import { formatBytes } from '../../shared/formatBytes'
import type { UpdateProgress } from '../../shared/ipc'
import { t } from '../../shared/i18n'

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
  if (!progress) return t('update.connecting')
  if (progress.phase === 'install') {
    // Deux fins très différentes, à ne jamais confondre : Jaris se ferme et se rouvre tout seul, alors que
    // l'installeur d'Ollama n'a AUCUN mode silencieux documenté — il ouvre sa propre fenêtre et attend un
    // clic. Afficher "ça se termine tout seul" dans ce cas serait une promesse fausse, et Léo attendrait
    // devant un écran qui ne bougera jamais (même famille que les fausses confirmations déjà corrigées).
    return progress.target === 'ollama'
      ? t('update.done.ollama')
      : t('update.done.jaris')
  }
  const quoi = progress.target === 'ollama' ? t('update.downloading.ollama') : t('update.downloading')
  if (progress.totalBytes === null) {
    return t('update.received', { what: quoi, received: formatBytes(progress.receivedBytes) })
  }
  return t('update.progress', { what: quoi, percent: progress.percent ?? 0, received: formatBytes(progress.receivedBytes), total: formatBytes(progress.totalBytes) })
}
