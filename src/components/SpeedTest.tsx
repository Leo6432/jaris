import { useEffect, useRef, useState } from 'react'
import { formatModelName } from '../lib/formatModelName'
import { ipcErrorMessage } from '../lib/ipcError'
import { formatDecimal, t } from '@/lib/i18n'
import type { SpeedTestEvent, SpeedTestModel } from '../../shared/ipc'

/**
 * Étape 514 (Léo : « un bouton pour tester la vitesse de tous les modèles, choisir ceux que je veux ou tout, les mêmes
 * questions pour tout le monde… comme l'analyse mais pour la vitesse ») : le pendant de « Tester ces modèles »
 * (UnscoredModelsTest) pour la colonne « Vitesse sur ton PC ». Les modèles jamais mesurés sont listés ; « Choisir »
 * permet de cocher n'importe quel modèle (déjà mesuré compris, pour le remesurer). Le moteur : speedTest.ts.
 */
type Row = { model: string; speed?: number; reason?: string }
type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error' | 'stopped'

export default function SpeedTest({ onTested, reloadKey = 0 }: { onTested?: () => void; reloadKey?: number }): JSX.Element | null {
  const [models, setModels] = useState<SpeedTestModel[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [choosing, setChoosing] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [percent, setPercent] = useState(0)
  const [current, setCurrent] = useState(() => t('runtime.preparing'))
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  // Étape 516 : le fichier des vitesses à m'envoyer (publiées ensuite dans Jaris pour tout le monde).
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)

  const reload = (): Promise<void> =>
    window.jaris
      .getSpeedTestModels()
      .then(setModels)
      .catch(() => setModels([]))

  // Étape 522 : relue quand le Classement l'est (version d'Ollama changée, etc.), jamais pendant un test.
  useEffect(() => {
    if (phase !== 'running') void reload()
  }, [reloadKey])

  // Étape 526 (test qui échouait sous la charge : « Préparation… » au lieu de « Mesure de… ») : l'écoute était posée
  // APRÈS l'affichage de « en cours », donc parfois après les premiers évènements du test, perdus. Elle est posée dès
  // l'ouverture ; seuls les évènements d'un test lancé d'ici comptent.
  const listening = useRef(false)
  useEffect(() => {
    return window.jaris.onSpeedTestEvent((event: SpeedTestEvent) => {
      if (!listening.current) return
      if (event.type === 'progress') {
        if (event.total > 0) setPercent(Math.min(100, Math.round((event.done / event.total) * 100)))
      } else if (event.type === 'downloading') {
        setCurrent(t('speed.downloading', { model: formatModelName(event.model), percent: event.percent }))
      } else if (event.type === 'measuring') {
        setCurrent(t('speed.measuring', { model: formatModelName(event.model), question: event.question, total: event.total }))
      } else if (event.type === 'done') {
        setRows((prev) => [...prev.filter((r) => r.model !== event.model), { model: event.model, speed: event.speed }])
      } else if (event.type === 'skipped') {
        setRows((prev) => [...prev.filter((r) => r.model !== event.model), { model: event.model, reason: event.reason }])
      }
    })
  }, [])

  if (!models || models.length === 0) return null
  const untested = models.filter((m) => m.speed === null)
  // Plus rien à mesurer : seul « Choisir » a un sens (remesurer).
  const choose = choosing || untested.length === 0
  const chosen = choose ? models.filter((m) => picked.includes(m.model)) : untested
  const downloadGb = chosen.filter((m) => !m.installed).reduce((sum, m) => sum + m.sizeGb, 0)
  const toggle = (model: string): void =>
    setPicked((list) => (list.includes(model) ? list.filter((m) => m !== model) : [...list, model]))
  const detail = (m: SpeedTestModel): string => {
    const parts = [m.installed ? t('speed.installed') : t('speed.toDownload', { size: t('unit.gb', { value: formatDecimal(m.sizeGb) }) })]
    if (m.speed !== null) parts.push(t('speed.current', { speed: formatDecimal(m.speed) }))
    return parts.join(' · ')
  }

  const run = async (): Promise<void> => {
    listening.current = true
    setPhase('running')
    setPercent(0)
    setRows([])
    setError(null)
    setStopping(false)
    setCurrent(t('runtime.preparing'))
    try {
      const result = await window.jaris.runSpeedTest(chosen.map((m) => m.model))
      if (result.stopped) setPhase('stopped')
      else {
        setPercent(100)
        setPhase('done')
      }
    } catch (err) {
      setError(ipcErrorMessage(err))
      setPhase('error')
    } finally {
      listening.current = false
      setStopping(false)
      await reload()
      onTested?.()
    }
  }

  const exportResults = async (): Promise<void> => {
    setExporting(true)
    setExported(null)
    try {
      const result = await window.jaris.exportSpeedResults()
      if (result.empty) setExported(t('speed.exportEmpty'))
      else if (result.saved) setExported(t('speed.exported', { models: result.models ?? 0 }))
      else if (result.error) setExported(t('unscored.exportFailed', { error: result.error }))
    } catch (err) {
      setExported(t('unscored.exportFailed', { error: ipcErrorMessage(err) }))
    } finally {
      setExporting(false)
    }
  }
  const measuredCount = models.filter((m) => m.speed !== null).length

  const stop = async (): Promise<void> => {
    setStopping(true)
    await window.jaris.stopSpeedTest().catch(() => {})
  }

  return (
    <div className="options-menu__unscored options-menu__speed-test">
      <p className="options-menu__unscored-title">
        {untested.length ? t('speed.toTest', { count: untested.length }) : t('speed.allTested')}
      </p>
      {untested.length > 0 && (
        <div className="duel-sizes duel-pickmode options-menu__unscored-mode" role="radiogroup" aria-label={t('speed.mode.label')}>
          {([false, true] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={choosing === value}
              className={`duel-size${choosing === value ? ' duel-size--selected' : ''}`}
              disabled={phase === 'running'}
              onClick={() => setChoosing(value)}
            >
              {t(value ? 'unscored.mode.choose' : 'speed.mode.untested')}
            </button>
          ))}
        </div>
      )}
      {choose ? (
        <>
          <div className="duel-picks__tools">
            <button type="button" className="duel-btn" onClick={() => setPicked(models.map((m) => m.model))} disabled={phase === 'running' || picked.length === models.length}>
              {t('duel.pick.all')}
            </button>
            <button type="button" className="duel-btn" onClick={() => setPicked([])} disabled={phase === 'running' || picked.length === 0}>
              {t('duel.pick.none')}
            </button>
          </div>
          <ul className="duel-picks options-menu__unscored-picks">
            {models.map((entry) => {
              const checked = picked.includes(entry.model)
              return (
                <li key={entry.model}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    disabled={phase === 'running'}
                    className={`duel-pick${checked ? ' duel-pick--checked' : ''}`}
                    title={entry.model}
                    onClick={() => toggle(entry.model)}
                  >
                    <span className="duel-pick__box" aria-hidden="true">
                      {checked && (
                        <svg viewBox="0 0 16 16" width="12" height="12">
                          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="duel-pick__name">{formatModelName(entry.model)}</span>
                    <span className="options-menu__unscored-pick-detail">{detail(entry)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <ul className="options-menu__unscored-list">
          {untested.map((entry) => (
            <li key={entry.model}>{t('common.labelValue', { label: formatModelName(entry.model), value: detail(entry) })}</li>
          ))}
        </ul>
      )}
      <p className="options-menu__unscored-text options-menu__unscored-total">
        {downloadGb > 0
          ? t('speed.selectionDownload', { count: chosen.length, size: t('unit.gb', { value: formatDecimal(downloadGb) }) })
          : t('speed.selection', { count: chosen.length })}
      </p>
      <p className="options-menu__unscored-text">{t('speed.same')}</p>

      {phase === 'idle' && (
        <button className="options-menu__action" onClick={() => setPhase('confirming')} disabled={chosen.length === 0}>
          {t('speed.test')}
        </button>
      )}

      {phase === 'confirming' && (
        <div className="options-menu__unscored-confirm">
          <p>{downloadGb > 0 ? t('speed.confirmDownload', { size: t('unit.gb', { value: formatDecimal(downloadGb) }) }) : t('speed.confirm')}</p>
          <p>{t('speed.confirmQuiet')}</p>
          <div className="options-menu__unscored-actions">
            <button className="options-menu__action" onClick={() => void run()}>
              {t('unscored.start')}
            </button>
            <button className="options-menu__action" onClick={() => setPhase('idle')}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {phase !== 'idle' && phase !== 'confirming' && (
        <div className="options-menu__progress">
          <div className="options-menu__progress-label">
            {phase === 'running' ? current : phase === 'done' ? t('speed.done') : phase === 'stopped' ? t('speed.stopped') : t('unscored.interrupted')}
          </div>
          <div className="options-menu__progress-bar">
            <div className="options-menu__progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          {rows.length > 0 && (
            <ul className="options-menu__unscored-results">
              {rows.map((row) => (
                <li key={row.model}>
                  {t('common.labelValue', {
                    label: formatModelName(row.model),
                    value: row.speed !== undefined ? t('speed.result', { speed: formatDecimal(row.speed) }) : t('unscored.skipped', { reason: row.reason ?? t('unscored.unknownReason') })
                  })}
                </li>
              ))}
            </ul>
          )}
          {phase === 'error' && error && <p className="options-menu__error">{error}</p>}
          <div className="options-menu__unscored-actions">
            {phase === 'running' ? (
              <button className="options-menu__action options-menu__action--stop" onClick={() => void stop()} disabled={stopping}>
                {stopping ? t('unscored.stopping') : t('unscored.stop')}
              </button>
            ) : (
              <button className="options-menu__action" onClick={() => setPhase('idle')}>
                {t('speed.again')}
              </button>
            )}
          </div>
        </div>
      )}
      {measuredCount > 0 && phase !== 'running' && (
        <div className="options-menu__unscored-export">
          <button className="options-menu__action" onClick={() => void exportResults()} disabled={exporting}>
            {exporting ? t('common.loading') : t('unscored.export')}
          </button>
          {exported && (
            <p className="options-menu__unscored-text" role="status">
              {exported}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
