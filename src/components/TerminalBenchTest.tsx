import { useEffect, useMemo, useState } from 'react'
import {
  TERMINAL_BENCH_TASK_COUNT,
  type TerminalBenchProgress,
  type TerminalBenchRun,
  type TerminalBenchStatus
} from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { formatDuration } from '../lib/formatCodeGenProgress'
import { ipcErrorMessage } from '../lib/ipcError'
import { formatPercent, t } from '@/lib/i18n'

/**
 * Étape 349, Léo : « ajoute un bouton test, en bas, faut pas que ça mélange tout, un bouton test avec le score, le temps
 * estimé ». Une carte à part, tout en bas de « Tous les modèles » : on y lance Terminal-Bench 2.1 sur CE PC avec les
 * options d'Artificial Analysis, on suit le temps restant (recalculé chaque minute) et on compare le score obtenu au
 * leur. Ces résultats ne vont jamais dans le tableau au-dessus ni dans le choix des modèles.
 */

const DOCKER_URL = 'https://www.docker.com/products/docker-desktop/'
const DEFAULT_MODEL = 'granite4.2:3b'

export interface TerminalBenchModel {
  model: string
  /** Score d'Artificial Analysis (en %), s'ils l'ont mesuré. */
  terminalBench: number | null
}

function percentOf(passed: number, trials: number): string {
  return trials ? formatPercent(passed / trials) : '—'
}

function runScore(run: TerminalBenchRun): {
  passed: number
  trials: number
  tasks: number
} {
  let passed = 0
  let trials = 0
  for (const task of Object.values(run.tasks)) {
    passed += task.passed
    trials += task.trials
  }
  return { passed, trials, tasks: Object.keys(run.tasks).length }
}

export default function TerminalBenchTest({ models }: { models: TerminalBenchModel[] }): JSX.Element {
  const [status, setStatus] = useState<TerminalBenchStatus | null>(null)
  const [progress, setProgress] = useState<TerminalBenchProgress | null>(null)
  const [model, setModel] = useState(() =>
    models.some((m) => m.model === DEFAULT_MODEL) ? DEFAULT_MODEL : (models[0]?.model ?? '')
  )
  const [attempts, setAttempts] = useState(3)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    void window.jaris
      .getTerminalBenchStatus()
      .then((s) => {
        setStatus(s)
        setProgress(s?.progress ?? null)
      })
      .catch(() => {})
  }

  useEffect(refresh, [])
  useEffect(
    () =>
      window.jaris.onTerminalBenchProgress((p) => {
        setProgress(p)
        // Une tâche finie ou la fin du test : les résultats enregistrés ont changé.
        if (p.phase !== 'running' && p.phase !== 'preparing') refresh()
      }),
    []
  )

  const aaScore = useMemo(() => models.find((m) => m.model === model)?.terminalBench ?? null, [models, model])
  const active = progress && (progress.phase === 'preparing' || progress.phase === 'running')

  const start = async (): Promise<void> => {
    setConfirming(false)
    setError(null)
    try {
      await window.jaris.startTerminalBench(model, attempts)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const aaOf = (name: string): number | null => models.find((m) => m.model === name)?.terminalBench ?? null

  return (
    <section className="tbench" aria-labelledby="tbench-title">
      <h3 id="tbench-title" className="tbench__title">
        {t('tbench.title')}
      </h3>
      <p className="tbench__text">{t('tbench.intro')}</p>

      {status?.docker === 'notInstalled' && (
        <p className="tbench__warning">
          {t('tbench.dockerMissing')}{' '}
          <a href={DOCKER_URL} target="_blank" rel="noreferrer">
            {t('tbench.dockerDownload')}
          </a>
        </p>
      )}
      {status?.docker === 'notRunning' && <p className="tbench__warning">{t('tbench.dockerStopped')}</p>}

      {!active && (
        <div className="tbench__form">
          <label className="tbench__field">
            <span>{t('tbench.model')}</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {formatModelName(m.model, { quant: false })}
                </option>
              ))}
            </select>
          </label>
          <label className="tbench__field">
            <span>{t('tbench.attempts')}</span>
            <select value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
              <option value={3}>{t('tbench.attempts3')}</option>
              <option value={1}>{t('tbench.attempts1')}</option>
            </select>
          </label>
          <p className="tbench__aa">
            {aaScore === null ? t('tbench.aaNone') : t('tbench.aaScore', { score: formatPercent(aaScore / 100) })}
          </p>
          {!confirming ? (
            <button
              className="options-menu__action tbench__start"
              disabled={!model || status?.docker !== 'ready'}
              onClick={() => setConfirming(true)}
            >
              {t('tbench.start')}
            </button>
          ) : (
            <div className="tbench__confirm">
              <p>{t('tbench.confirm', { tasks: TERMINAL_BENCH_TASK_COUNT })}</p>
              <div className="tbench__actions">
                <button className="options-menu__action" onClick={() => void start()}>
                  {t('tbench.confirmStart')}
                </button>
                <button className="options-menu__action" onClick={() => setConfirming(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {progress && (
        <div className="tbench__progress" aria-live="polite">
          <p className="tbench__progress-title">
            {t('tbench.progressTitle', {
              model: formatModelName(progress.model, { quant: false }),
              attempts: progress.attempts
            })}
          </p>
          <p className="tbench__step">{progress.phase === 'error' ? t('tbench.failed') : progress.step}</p>
          <div className="options-menu__progress-bar">
            <div
              className="options-menu__progress-bar-fill"
              style={{
                width: `${progress.tasksTotal ? Math.round((progress.tasksDone / progress.tasksTotal) * 100) : 0}%`
              }}
            />
          </div>
          <dl className="tbench__stats">
            <div>
              <dt>{t('tbench.tasks')}</dt>
              <dd>
                {progress.tasksDone} / {progress.tasksTotal}
              </dd>
            </div>
            <div>
              <dt>{t('tbench.score')}</dt>
              <dd>
                {percentOf(progress.passed, progress.trials)}
                {progress.trials > 0 && (
                  <span className="tbench__detail">
                    {' '}
                    ({progress.passed}/{progress.trials})
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('tbench.elapsed')}</dt>
              <dd>{formatDuration(progress.elapsedMs)}</dd>
            </div>
            <div>
              <dt>{t('tbench.remaining')}</dt>
              <dd>
                {progress.remainingMs === null ? t('tbench.remainingLater') : formatDuration(progress.remainingMs)}
              </dd>
            </div>
          </dl>
          {progress.phase === 'error' && progress.error && <p className="options-menu__error">{progress.error}</p>}
          {active && (
            <button className="options-menu__action" onClick={() => void window.jaris.stopTerminalBench()}>
              {t('tbench.stop')}
            </button>
          )}
        </div>
      )}

      {error && <p className="options-menu__error">{error}</p>}

      {status && status.runs.length > 0 && (
        <div className="tbench__results-scroll">
          <table className="options-menu__model-overview tbench__results">
            <caption>{t('tbench.results')}</caption>
            <thead>
              <tr>
                <th>{t('tbench.model')}</th>
                <th>{t('tbench.attemptsShort')}</th>
                <th className="options-menu__col-num">{t('tbench.yours')}</th>
                <th className="options-menu__col-num">{t('tbench.theirs')}</th>
                <th className="options-menu__col-num">{t('tbench.tasks')}</th>
                <th className="options-menu__col-num">{t('tbench.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {status.runs.map((run) => {
                const s = runScore(run)
                const aa = aaOf(run.model)
                return (
                  <tr key={`${run.model}|${run.attempts}`}>
                    <td title={run.model}>{formatModelName(run.model, { quant: false })}</td>
                    <td>{run.attempts}</td>
                    <td className="options-menu__col-num">{percentOf(s.passed, s.trials)}</td>
                    <td className="options-menu__col-num">{aa === null ? '—' : formatPercent(aa / 100)}</td>
                    <td className="options-menu__col-num">
                      {s.tasks} / {TERMINAL_BENCH_TASK_COUNT}
                      {run.finishedAt ? '' : ` · ${t('tbench.paused')}`}
                    </td>
                    <td className="options-menu__col-num">{formatDuration(run.seconds * 1000)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
