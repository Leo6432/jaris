import { init } from '@sentry/electron/renderer'
import { PRIVATE_DATA_COLLECTION, scrubErrorEvent } from '../../shared/errorReports'

/**
 * Étape 527 : les erreurs de l'écran (fenêtre principale, petit Jaris) rejoignent les rapports du main — seulement si la
 * personne a dit oui. Rien n'est démarré sans cet accord ; un « oui » donné en route vaut pour l'écran au prochain
 * démarrage (le main, lui, démarre tout de suite).
 */
export function startRendererErrorReports(): void {
  void window.jaris
    ?.getErrorReports?.()
    .then((state) => {
      if (!state.enabled) return
      init({
        dataCollection: PRIVATE_DATA_COLLECTION,
        maxBreadcrumbs: 0,
        beforeSend: (event, hint) => {
          hint.attachments = []
          return scrubErrorEvent(event as unknown as Record<string, unknown>) as unknown as typeof event
        }
      })
    })
    .catch(() => {})
}
