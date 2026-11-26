import { t } from '@/lib/i18n'
import { ICON_SUPPORT, SUPPORT_URL } from '../lib/support'

/**
 * Étape 527 (Léo : « le bouton support est là que quand on est sur le menu, mais si on est en installation ou en
 * téléchargement il n'y a pas, et s'il rencontre un bug » ; « discret ») : un petit lien « Support » dans le coin de
 * chaque écran du premier lancement (bienvenue, installation des moteurs, préparation des modèles) — là où un souci
 * bloque tout et où la barre d'icônes n'existe pas encore.
 */
export default function SetupSupport(): JSX.Element {
  return (
    <a className="setup-support" href={SUPPORT_URL} target="_blank" rel="noreferrer" title={t('app.support.title')}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICON_SUPPORT} />
      </svg>
      <span>{t('app.support')}</span>
    </a>
  )
}
