import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { PRIVACY_URL } from '../lib/support'

/**
 * Étape 527 (Léo : « une question, une seule fois ») : les installations faites avant les rapports d'erreurs n'ont pas
 * vu la case de l'écran de bienvenue. Une petite carte, en bas à droite, pose la question UNE fois : Oui ou Non, la
 * réponse est notée (rapports-erreurs.json) et la carte ne revient plus. Rien ne part avant « Oui ».
 */
export default function ErrorReportsPrompt(): JSX.Element | null {
  const [shown, setShown] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    // Jamais d'erreur à l'écran : un état illisible = pas de carte (la question reste dans Options).
    Promise.resolve()
      .then(() => window.jaris.getErrorReports())
      .then((state) => alive && setShown(state?.asked === false))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!shown) return null
  const answer = (enabled: boolean): void => {
    setSaving(true)
    void window.jaris
      .setErrorReports(enabled)
      .then(() => setShown(false))
      .catch(() => setSaving(false))
  }
  return (
    <section className="error-reports-prompt" role="dialog" aria-label={t('errorReports.prompt.title')}>
      <p className="error-reports-prompt__title">{t('errorReports.prompt.title')}</p>
      <p className="error-reports-prompt__text">
        {t('errorReports.prompt.text')}{' '}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
          {t('errorReports.privacy')}
        </a>
      </p>
      <div className="error-reports-prompt__actions">
        <button type="button" className="error-reports-prompt__no" disabled={saving} onClick={() => answer(false)}>
          {t('errorReports.prompt.no')}
        </button>
        <button type="button" className="error-reports-prompt__yes" disabled={saving} onClick={() => answer(true)}>
          {t('errorReports.prompt.yes')}
        </button>
      </div>
    </section>
  )
}
