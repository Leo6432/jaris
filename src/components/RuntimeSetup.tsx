import { useEffect, useRef, useState } from 'react'
import type { RuntimeSetupProgress } from '../../shared/ipc'
import { t } from '@/lib/i18n'

/**
 * Écran d'installation du premier lancement (étape 16 du roadmap) : Jaris installe lui-même Python, ses
 * dépendances et Ollama, sans que l'utilisateur ouvre le moindre terminal.
 *
 * Démarre tout seul dès l'affichage plutôt que derrière un bouton "Installer" : à ce stade l'utilisateur
 * vient de double-cliquer sur un installeur et de donner son prénom, il n'y a rien à choisir ici — un
 * bouton de plus ne serait qu'une étape de plus à franchir pour un résultat identique.
 */
export default function RuntimeSetup({ onDone }: { onDone: () => void }): JSX.Element {
  const [progress, setProgress] = useState<RuntimeSetupProgress | null>(null)
  const [failures, setFailures] = useState<string[]>([])
  const [finished, setFinished] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // React monte deux fois chaque composant en développement (StrictMode) : sans ce garde, une même
  // tentative partirait deux fois en parallèle sur le même dossier, les deux se marchant dessus.
  const startedAttempt = useRef(-1)

  useEffect(() => {
    const unsubscribe = window.jaris.onRuntimeSetupProgress((update) => {
      setProgress(update)
      if (update.failed) setFailures((prev) => [...prev, update.message])
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (startedAttempt.current === attempt) return
    startedAttempt.current = attempt
    setProgress(null)
    setFailures([])
    setFinished(false)

    window.jaris
      .runRuntimeSetup()
      .then((status) => {
        if (status.ready) {
          onDone()
          return
        }
        // Installation incomplète : on ne bloque pas l'utilisateur dans cet écran, il peut réessayer ou
        // continuer — les messages d'échec déjà collectés lui disent ce qui manque.
        setFinished(true)
      })
      .catch((err: unknown) => {
        setFailures((prev) => [...prev, err instanceof Error ? err.message : String(err)])
        setFinished(true)
      })
  }, [attempt, onDone])

  const statusText = finished
    ? t('runtime.incomplete')
    : progress === null
      ? t('runtime.preparing')
      : progress.failed
        ? t('runtime.continuing')
        : progress.message

  return (
    <div className="app">
      <div className="runtime-setup">
        <h1>{t('runtime.title')}</h1>
        <p className="runtime-setup__intro">{t('runtime.intro')}</p>

        {/* Étape 234 (bêta) : un échec s'affichait DEUX fois (ici et dans la liste en dessous), et la barre
            continuait d'animer une fois tout arrêté — ce qui se lit comme « ça travaille encore ». */}
        <div className="runtime-setup__status">{statusText}</div>

        {/* Barre remplie seulement quand un pourcentage a un sens (un téléchargement) : pendant une étape
            dont la durée est inconnue, elle reste en animation indéterminée plutôt que d'afficher un
            chiffre inventé qui n'avancerait pas. */}
        {!finished && (
          <div className="runtime-setup__bar">
            <div
              className={`runtime-setup__bar-fill${progress?.percent === undefined ? ' runtime-setup__bar-fill--pulse' : ''}`}
              style={progress?.percent === undefined ? undefined : { width: `${Math.round(progress.percent)}%` }}
            />
          </div>
        )}

        {failures.length > 0 && (
          <ul className="runtime-setup__failures">
            {failures.map((failure, i) => (
              <li key={i}>{failure}</li>
            ))}
          </ul>
        )}

        {finished && (
          <div className="runtime-setup__actions">
            <button onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</button>
            <button className="runtime-setup__skip" onClick={onDone}>
              {t('runtime.skip')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
