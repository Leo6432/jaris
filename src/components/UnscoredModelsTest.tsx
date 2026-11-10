import { useEffect, useState } from 'react'
import { formatModelName } from '../lib/formatModelName'
import { ipcErrorMessage } from '../lib/ipcError'
import { t, tn } from '@/lib/i18n'
import type { ModelToTest } from '../../shared/ipc'

/**
 * Étape 168, Léo : « remets le bouton pour Lightning et qwen2.5-coder:14b ». L'analyse complète a été retirée
 * (étape 166) une fois ses scores recopiés dans verified-tool-scores.md ; un modèle ajouté ensuite n'avait donc
 * plus aucun moyen d'être mesuré, et Jaris ne choisit jamais un modèle sans score. Ce bouton ne teste QUE les
 * modèles sans score (jamais les 40) et ne choisit rien à la fin : Léo envoie le fichier, les scores sont
 * recopiés à la main dans verified-tool-scores.md, comme pour l'analyse du 25/09/2026.
 *
 * Suivi volontairement simple : une barre, ce qui se passe en ce moment, et une ligne par modèle terminé.
 * L'ancien tableau listait les ~40 modèles « En attente », ce qui faisait croire à Léo que tout allait être
 * retéléchargé.
 */
type Row = { model: string; status: 'done' | 'skipped' | 'replayed'; correct?: number; total?: number; reason?: string }
type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error' | 'stopped'

function describeNeed(need: ModelToTest['needs'][number]): string {
  const test = t(need.test === 'tools' ? 'unscored.need.tools' : need.test === 'vision' ? 'unscored.need.vision' : 'unscored.need.code')
  if (need.reason === 'redo') return t('unscored.need.redo', { test })
  if (need.reason === 'remeasure') return t('unscored.need.remeasure', { test })
  return test
}

/**
 * Étape 433 : une durée estimée lisible — arrondie à la minute sous 10 min, aux 5 minutes au-delà (une estimation
 * n'a pas la précision de la seconde).
 */
export function formatEstimate(ms: number): string {
  const rawMinutes = Math.max(1, Math.round(ms / 60_000))
  const minutes = rawMinutes < 10 ? rawMinutes : Math.round(rawMinutes / 5) * 5
  if (minutes < 60) return t('duration.minutesOnly', { m: minutes })
  return t('duration.hours', { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') })
}

export default function UnscoredModelsTest(): JSX.Element | null {
  const [models, setModels] = useState<ModelToTest[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [percent, setPercent] = useState(0)
  const [current, setCurrent] = useState(() => t('runtime.preparing'))
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  // Étape 436 (Léo : « pouvoir choisir : tout tester comme maintenant, ou choisir comme les duels, avec le temps — si
  // j'ai beaucoup de temps, je choisis les gros modèles et j'éteins le PC après ; sinon les petits »).
  const [choosing, setChoosing] = useState(false)
  // Étape 438 : le petit fichier à m'envoyer (seulement les résultats pas encore envoyés, compressé).
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  // Étape 441 (Léo : « ajoute pouvoir arrêter les tests, là je dois quitter l'application pour arrêter le test »).
  const [stopping, setStopping] = useState(false)

  // Étape 437 : la machine louée connectée (ou non) change où le test se fera — et donc ses durées estimées.
  const [machineHost, setMachineHost] = useState<string | null>(null)
  useEffect(() => {
    void window.jaris.getUnscoredModels().then(setModels)
    let alive = true
    void window.jaris
      .machineGet()
      .then((view) => alive && setMachineHost(view.connected ? (view.saved?.host ?? null) : null))
      .catch(() => {})
    const stop = window.jaris.onMachineChanged((view) => {
      if (!alive) return
      const next = view.connected ? (view.saved?.host ?? null) : null
      setMachineHost((current) => {
        if (current !== next) void window.jaris.getUnscoredModels().then((list) => alive && setModels(list))
        return next
      })
    })
    return () => {
      alive = false
      stop()
    }
  }, [])

  useEffect(() => {
    if (phase !== 'running') return undefined
    // Étape 453 : sur une grande machine louée, plusieurs modèles se testent en même temps.
    let testingNow: string[] = []
    return window.jaris.onModelBenchmarkLine((line) => {
      const [marker, ...args] = line.trim().split(/\s+/)
      const upsert = (row: Row): void => setRows((prev) => [...prev.filter((r) => r.model !== row.model), row])
      if (marker === '##PROGRESS##') {
        const [done, total] = args.map(Number)
        if (total > 0) setPercent(Math.min(100, Math.round((done / total) * 100)))
      } else if (marker === '##PULL_MODEL_PROGRESS##') {
        setCurrent(t('unscored.downloading', { model: formatModelName(args[0]), percent: args[1] }))
      } else if (marker === '##TESTING_NOW##') {
        testingNow = args
        if (args.length > 1) setCurrent(t('unscored.testingMany', { count: args.length, models: args.map((m) => formatModelName(m)).join(', ') }))
        else if (args.length === 1) setCurrent(t('unscored.testing', { model: formatModelName(args[0]) }))
      } else if (marker === '##MODEL_TESTING##') {
        if (testingNow.length <= 1) setCurrent(t('unscored.testing', { model: formatModelName(args[0]) }))
      } else if (marker === '##WORKING##') {
        // Plusieurs modèles en même temps : la liste reste affichée (un seul signe de vie la cacherait).
        if (testingNow.length > 1) return
        // Étape 314 : une réponse de plusieurs minutes (gros modèle débordant sur la RAM) ne doit pas passer pour un
        // blocage. Sous une minute, rien ne change : « Test de X… » suffit.
        const minutes = Math.floor(Number(args[1]) / 60)
        setCurrent(
          minutes >= 1
            ? t('unscored.working', { model: formatModelName(args[0]), minutes })
            : t('unscored.testing', { model: formatModelName(args[0]) })
        )
      } else if (marker === '##MODEL_DONE##') {
        upsert({ model: args[0], status: 'done', correct: Number(args[1]), total: Number(args[2]) })
      } else if (marker === '##REPLAY_DONE##') {
        // Cas refaits (délai dépassé, plantage) : un nombre de cas, pas un score.
        upsert({ model: args[0], status: 'replayed', total: Number(args[1]) })
      } else if (marker === '##MODEL_SKIPPED##') {
        // Étape 169 : la vraie raison, jamais un « trop gros ou téléchargement impossible » générique.
        upsert({ model: args[0], status: 'skipped', reason: args.slice(1).join(' ') || undefined })
      }
    })
  }, [phase])

  if (!models) return null
  const estimatedTotal = models.reduce((sum, m) => sum + (m.estimatedMs ?? 0), 0)
  // Ce que le bouton lancera : tout, ou seulement les modèles cochés (dans l'ordre de la liste).
  const chosen = choosing ? models.filter((m) => picked.includes(m.model)) : models
  const chosenTotal = chosen.reduce((sum, m) => sum + (m.estimatedMs ?? 0), 0)
  const toggle = (model: string): void =>
    setPicked((current) => (current.includes(model) ? current.filter((m) => m !== model) : [...current, model]))
  const lineValue = ({ needs, estimatedMs }: ModelToTest): string => {
    const missing = needs.map(describeNeed).join(', ')
    return estimatedMs ? t('unscored.lineEstimate', { needs: missing, duration: formatEstimate(estimatedMs) }) : missing
  }
  if (!models.length && phase === 'idle') {
    return <p className="capacity-scan__status">{t('unscored.allScored')}</p>
  }

  const exportResults = async (): Promise<void> => {
    setExporting(true)
    setExported(null)
    try {
      const result = await window.jaris.exportTestResults()
      if (result.empty) setExported(t('unscored.exportEmpty'))
      else if (result.saved) setExported(t('unscored.exported', { rows: result.rows ?? 0, models: result.models ?? 0, size: result.sizeKb ?? 0 }))
      else if (result.error) setExported(t('unscored.exportFailed', { error: result.error }))
    } catch (err) {
      setExported(t('unscored.exportFailed', { error: ipcErrorMessage(err) }))
    } finally {
      setExporting(false)
    }
  }

  const exportBlock = (
    <div className="options-menu__unscored-export">
      <button className="options-menu__action" onClick={() => void exportResults()} disabled={exporting || phase === 'running'}>
        {exporting ? t('common.loading') : t('unscored.export')}
      </button>
      {exported && (
        <p className="options-menu__unscored-text" role="status">
          {exported}
        </p>
      )}
    </div>
  )

  const run = async (): Promise<void> => {
    setPhase('running')
    setPercent(0)
    setRows([])
    setError(null)
    setStopping(false)
    try {
      const result = await window.jaris.testUnscoredModels(choosing ? chosen.map((m) => m.model) : undefined)
      // Arrêté par le bouton : pas une panne. Le main le dit par ce champ (benchmarkRunner.ts, stopModelTestByUser),
      // jamais par une phrase traduite (la langue peut changer pendant le test).
      if (result?.stopped) {
        setPhase('stopped')
      } else {
        setPercent(100)
        setPhase('done')
      }
    } catch (err) {
      setError(ipcErrorMessage(err))
      setPhase('error')
    } finally {
      setStopping(false)
    }
  }

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await window.jaris.stopUnscoredTest()
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
    // Lancé depuis un autre écran (ce test-ci n'attend aucune fin) : la page revient à son état normal.
    if (phase === 'error') {
      setStopping(false)
      setError(null)
      setPhase('idle')
    }
  }
  // Un test lancé ailleurs (avant un retour sur cette page) : « déjà en cours » doit aussi pouvoir s'arrêter ici.
  const stopButton = (
    <button className="options-menu__action options-menu__action--stop" onClick={() => void stop()} disabled={stopping}>
      {stopping ? t('unscored.stopping') : t('unscored.stop')}
    </button>
  )

  return (
    <div className="options-menu__unscored">
      <p className="options-menu__unscored-title">{t('unscored.toTest', { count: models.length })}</p>
      {/* Étape 436 : tout tester d'un coup (comme avant), ou choisir les modèles selon le temps qu'on a. */}
      <div className="duel-sizes duel-pickmode options-menu__unscored-mode" role="radiogroup" aria-label={t('unscored.mode.label')}>
        {([false, true] as const).map((choose) => (
          <button
            key={String(choose)}
            type="button"
            role="radio"
            aria-checked={choosing === choose}
            className={`duel-size${choosing === choose ? ' duel-size--selected' : ''}`}
            disabled={phase === 'running'}
            onClick={() => setChoosing(choose)}
          >
            {t(choose ? 'unscored.mode.choose' : 'unscored.mode.all')}
          </button>
        ))}
      </div>
      {choosing ? (
        <>
          <div className="duel-picks__tools">
            <button type="button" className="duel-btn" onClick={() => setPicked(models.map((m) => m.model))} disabled={picked.length === models.length}>
              {t('duel.pick.all')}
            </button>
            <button type="button" className="duel-btn" onClick={() => setPicked([])} disabled={picked.length === 0}>
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
                    <span className="options-menu__unscored-pick-detail">{lineValue(entry)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="options-menu__unscored-text options-menu__unscored-total">
            {chosenTotal > 0
              ? t('unscored.selectionEstimate', { count: chosen.length, duration: formatEstimate(chosenTotal) })
              : t('unscored.selection', { count: chosen.length })}
          </p>
        </>
      ) : (
        <>
          {/* Étape 431 : pour chaque modèle, ce qui lui manque — avant, 31 noms d'affilée sans dire pourquoi. */}
          <ul className="options-menu__unscored-list">
            {models.map((entry) => (
              <li key={entry.model}>{t('common.labelValue', { label: formatModelName(entry.model), value: lineValue(entry) })}</li>
            ))}
          </ul>
          {/* Étape 433 (Léo : « ajoute le temps estimé ») : le total, d'après les temps déjà mesurés sur ce PC. */}
          {estimatedTotal > 0 && (
            <p className="options-menu__unscored-text options-menu__unscored-total">
              {t(
            machineHost
              ? models.every((m) => m.estimatedMs)
                ? 'unscored.totalMachine'
                : 'unscored.totalPartialMachine'
              : models.every((m) => m.estimatedMs)
                ? 'unscored.total'
                : 'unscored.totalPartial',
            { duration: formatEstimate(estimatedTotal) }
          )}
            </p>
          )}
        </>
      )}
      {machineHost && <p className="options-menu__unscored-text options-menu__unscored-machine">{t('unscored.onMachine', { host: machineHost })}</p>}
      <p className="options-menu__unscored-text">{t('unscored.changed')}</p>

      {phase === 'idle' && (
        <>
          <button className="options-menu__action" onClick={() => setPhase('confirming')} disabled={choosing && chosen.length === 0}>
            {t(choosing ? 'unscored.testSelection' : 'unscored.test')}
          </button>
          {exportBlock}
        </>
      )}

      {phase === 'confirming' && (
        <div className="options-menu__unscored-confirm">
          <p>{t('unscored.confirm')}</p>
          <p>{t('unscored.resume')}</p>
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

      {(phase === 'running' || phase === 'done' || phase === 'error' || phase === 'stopped') && (
        <div className="options-menu__progress">
          <div className="options-menu__progress-label">
            {phase === 'running'
              ? current
              : phase === 'done'
                ? t('unscored.done')
                : phase === 'stopped'
                  ? t('unscored.stopped')
                  : t('unscored.interrupted')}
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
                    value:
                      row.status === 'done'
                        ? `${row.correct}/${row.total}`
                        : row.status === 'replayed'
                          ? tn('unscored.replayed', row.total ?? 0)
                          : t('unscored.skipped', { reason: row.reason ?? t('unscored.unknownReason') })
                  })}
                </li>
              ))}
            </ul>
          )}
          {phase === 'error' && error && <p className="options-menu__error">{error}</p>}
          {phase === 'running' && <div className="options-menu__unscored-actions">{stopButton}</div>}
          {phase === 'error' && error === t('bench.testRunning') && <div className="options-menu__unscored-actions">{stopButton}</div>}
          {phase !== 'running' && (
            <div className="options-menu__unscored-actions">
              <button className="options-menu__action" onClick={() => void window.jaris.showUnscoredResults()}>
                {t('unscored.openResults')}
              </button>
              {(phase === 'error' || phase === 'stopped') && (
                <button className="options-menu__action" onClick={() => void run()}>
                  {t('unscored.resumeButton')}
                </button>
              )}
            </div>
          )}
          {(phase === 'done' || phase === 'stopped') && (
            <>
              <p className="options-menu__unscored-text">{t('unscored.send')}</p>
              {exportBlock}
            </>
          )}
        </div>
      )}
    </div>
  )
}
