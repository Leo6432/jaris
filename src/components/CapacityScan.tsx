import { useEffect, useState } from 'react'
import type { CapacityScanResult, ModelPullProgress, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import MyModelPicks from './MyModelPicks'
import ModelPullBar from './ModelPullBar'
import { PILOT_MODEL_LABEL } from '../../shared/pilotModel'
import { t, tn } from '@/lib/i18n'

interface CapacityScanProps {
  onDone: () => void
}

/** Ligne « Vidéo » du résumé : le modèle et sa qualité, s'il reste à le télécharger depuis le mode Vidéo, ou aucun. */
function videoSummary(video: NonNullable<CapacityScanResult['video']>): string {
  if (!video.model) return t('setup.video.none')
  const values = { model: video.model, quality: video.qualityLabel ?? '' }
  return video.installed ? t('picks.video.model', values) : t('setup.video.later', values)
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
  // Le modèle en cours de téléchargement (octets reçus / taille), `null` entre deux téléchargements.
  const [pull, setPull] = useState<ModelPullProgress | null>(null)
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jaris.getMyModelPicks().then(setPicks)
  }, [])

  useEffect(() => {
    if (!installing) return
    const stopLines = window.jaris.onModelBenchmarkLine((line) => setLog((prev) => [...prev, line]))
    const stopProgress = window.jaris.onModelPullProgress(setPull)
    return () => {
      stopLines()
      stopProgress()
    }
  }, [installing])

  const start = (): void => {
    setError(null)
    setLog([])
    setPull(null)
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

        {/* Une vraie barre (et la taille) pendant un téléchargement de modèle, plutôt qu'un rond qui tourne : un
            modèle pèse plusieurs Go, l'utilisateur doit voir que ça avance et combien il en reste. Entre deux
            téléchargements (détection, modèle d'image…), la même barre fait un va-et-vient : ça travaille, sans
            pourcentage inventé — comme l'écran d'installation juste avant. */}
        {installing && (
          <div className="capacity-scan__progress">
            <p className="capacity-scan__status">{t('setup.downloading')}</p>
            <ModelPullBar pull={pull} line={log[log.length - 1] ?? ''} label={t('setup.downloading')} />
          </div>
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
              {/* Même décision que la ligne « Vidéo » de la carte des modèles (pickVideoModel) ; jamais téléchargé ici. */}
              {result.video && <li>{t('common.labelValue', { label: t('app.mode.video'), value: videoSummary(result.video) })}</li>}
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
