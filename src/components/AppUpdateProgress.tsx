import { formatUpdateProgress } from '@/lib/formatUpdateProgress'
import type { UpdateProgress } from '../../shared/ipc'

/**
 * Avancement d'une mise à jour de Jaris (étape 98), affiché sous le bouton "Mettre à jour" tant qu'elle
 * travaille — demande de Léo : "quand on demande une mise à jour on ne sait pas quand c'est terminé".
 *
 * Réutilise TELLE QUELLE la famille de barres de progression déjà partagée par l'analyse des modèles
 * (`.options-menu__progress*`, voir ModelAnalysisProgress.tsx) plutôt que d'inventer une barre à côté :
 * même leçon que le bouton d'envoi du composeur (étape 92) et les boutons du mode Code (étape 94) — quand
 * une famille existe déjà, s'y raccrocher avant d'en créer une nouvelle.
 *
 * Composant à part (et pas un bloc de JSX de plus dans OptionsMenu.tsx, déjà très long) pour être
 * vérifiable dans un vrai navigateur avec le vrai CSS compilé : c'est la seule façon de prouver que la
 * barre avance vraiment, une règle CSS sans effet ne produisant aucune erreur.
 */
export default function AppUpdateProgress({ progress }: { progress: UpdateProgress | null }): JSX.Element {
  const percent = progress?.percent ?? null

  return (
    <div className="options-menu__progress">
      <div className="options-menu__progress-label">{formatUpdateProgress(progress)}</div>
      {/* Pas de barre quand le serveur n'annonce aucune taille : une barre figée à 0 % ferait croire à un
          blocage. La ligne au-dessus affiche alors les octets déjà reçus, qui montent, eux. */}
      {percent !== null && (
        <div className="options-menu__progress-bar">
          <div className="options-menu__progress-bar-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="options-menu__progress-sub">
        <span>Ne ferme pas Jaris : il se ferme et se rouvre tout seul à la fin.</span>
      </div>
    </div>
  )
}
