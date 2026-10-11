import { useEffect, useState } from 'react'
import type { CapacityScanResult, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import MyModelPicks from './MyModelPicks'
import { PILOT_MODEL_LABEL } from '../../shared/pilotModel'
import { t, tn } from '@/lib/i18n'

interface CapacityScanProps {
  onDone: () => void
}

/**
 * Premier lancement : détecte le matériel et télécharge directement les modèles déjà connus pour lui
 * (voir runQuickSetup, benchmarkRunner.ts) — remplace l'ancienne analyse comparative obligatoire complète
 * (qui pouvait prendre des dizaines de minutes) maintenant que scripts/verified-tool-scores.md couvre la
 * quasi-totalité des configurations courantes : plus besoin de comparer des dizaines de candidats pour
 * savoir lequel gagne, juste télécharger le gagnant déjà connu. Présente d'abord les modèles choisis pour
 * CETTE machine (getMyModelPicks — plus de paliers de comparaison depuis l'étape 137), pour que
 * l'utilisateur voie ce que Jaris va installer avant même de cliquer "Continuer". L'ancienne analyse comparative complète reste disponible à la main depuis
 * Options → Modèles pour qui veut vérifier/affiner au-delà de ce qui est déjà vérifié.
 */
export default function CapacityScan({ onDone }: CapacityScanProps): JSX.Element {
  const [picks, setPicks] = useState<MyModelPicksData | null>(null)
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jaris.getMyModelPicks().then(setPicks)
  }, [])

  useEffect(() => {
    if (!installing) return
    return window.jaris.onModelBenchmarkLine((line) => setLog((prev) => [...prev, line]))
  }, [installing])

  const start = (): void => {
    setError(null)
    setLog([])
    setInstalling(true)
    window.jaris
      .runQuickSetup()
      .then((scan) => setResult(scan))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false))
  }

  const finish = (): void => onDone()

  return (
    <div className="app">
      <div className="app__onboarding capacity-scan">
        <h1>{result ? t('setup.done.title') : t('setup.title')}</h1>

        {!result && !installing && !error && (
          <>
            <p>{t('setup.intro')}</p>
            {picks === null ? <p className="capacity-scan__status">{t('options.retest.detecting')}</p> : <MyModelPicks picks={picks} title={t('setup.picks.title')} beforeInstall />}
            <button onClick={start} disabled={picks === null}>
              {t('common.continue')}
            </button>
          </>
        )}

        {installing && (
          <>
            <div className="capacity-scan__spinner" />
            <p className="capacity-scan__status">{t('setup.downloading')}</p>
            {log.length > 0 && <p className="capacity-scan__status">{log[log.length - 1]}</p>}
          </>
        )}

        {error && (
          <>
            <p className="capacity-scan__status">{t('setup.failed', { error })}</p>
            <button onClick={start}>{t('common.retry')}</button>
          </>
        )}

        {result && (
          <>
            <p>
              {t('setup.gpu', { gpu: result.gpuName ?? t('setup.gpu.none') })}
              {result.vramGb !== null ? ` (${t('picks.vram', { gb: result.vramGb })})` : ''}
            </p>
            <ul className="capacity-scan__models">
              <li>{t('common.labelValue', { label: t('role.flash'), value: formatModelName(result.models.flash) })}</li>
              <li>{t('common.labelValue', { label: t('role.medium'), value: formatModelName(result.models.medium) })}</li>
              <li>{t('common.labelValue', { label: t('role.large'), value: formatModelName(result.models.large) })}</li>
              <li>{t('common.labelValue', { label: t('role.vision'), value: formatModelName(result.visionModel) })}</li>
              <li>{t('common.labelValue', { label: t('app.mode.code'), value: formatModelName(result.codeModel) })}</li>
              {result.image && <li>{t('common.labelValue', { label: t('app.mode.image'), value: result.image.model ?? t('setup.image.none') })}</li>}
              {result.pilot && (
                <li>{t('common.labelValue', { label: t('role.pilot'), value: result.pilot.model ? PILOT_MODEL_LABEL : t('setup.pilot.none') })}</li>
              )}
            </ul>
            {result.image?.error && (
              <div className="capacity-scan__warning">
                <p>{t('setup.image.error', { error: result.image.error })}</p>
              </div>
            )}
            {result.pilot?.error && (
              <div className="capacity-scan__warning">
                <p>{t('setup.pilot.error', { error: result.pilot.error })}</p>
              </div>
            )}
            <p className="capacity-scan__hint">{t('setup.hint')}</p>
            {result.skippedModels && result.skippedModels.length > 0 && (
              <div className="capacity-scan__warning">
                <p>{tn('setup.skipped', result.skippedModels.length)}</p>
                <ul>
                  {result.skippedModels.map(({ model, reason }) => (
                    <li key={model}>
                      {t('common.labelValue', { label: formatModelName(model), value: reason })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.blockedModels && result.blockedModels.length > 0 && (
              <div className="capacity-scan__warning">
                <p>{tn('setup.blocked', result.blockedModels.length)}</p>
                <ul>
                  {result.blockedModels.map(({ model, reason }) => (
                    <li key={model}>
                      {t('common.labelValue', { label: formatModelName(model), value: reason })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={finish}>{t('common.continue')}</button>
          </>
        )}
      </div>
    </div>
  )
}
