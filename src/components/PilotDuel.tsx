import { useEffect, useState } from 'react'
import type { PilotDuelCaptureInfo, PilotDuelOutcome } from '../../shared/ipc'
import { SettingGroup, SettingRow } from './SettingsLayout'

/**
 * Étape 249 : duel des pilotes d'écran (UI-TARS, le pilote actuel, contre MAI-UI 8B) sur le VRAI écran de Léo.
 * Aucun clic : Windows donne la vraie position de chaque bouton, et chaque pilote doit la viser.
 */
export function PilotDuel(): JSX.Element {
  const [info, setInfo] = useState<PilotDuelCaptureInfo>({ captures: 0, targets: 0 })
  const [capturing, setCapturing] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<PilotDuelOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => window.jaris.onPilotDuelProgress((message) => setProgress(message)), [])

  const capture = async (): Promise<void> => {
    setError(null)
    setCapturing(true)
    try {
      setInfo(await window.jaris.pilotDuelCapture())
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(err))
    } finally {
      setCapturing(false)
    }
  }

  const run = async (): Promise<void> => {
    setError(null)
    setOutcome(null)
    setRunning(true)
    setProgress('Préparation des deux pilotes…')
    try {
      setOutcome(await window.jaris.pilotDuelRun())
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(err))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const reset = async (): Promise<void> => {
    setOutcome(null)
    setError(null)
    setInfo(await window.jaris.pilotDuelReset())
  }

  return (
    <SettingGroup
      title="Duel des pilotes d'écran"
      description="Compare le pilote actuel (UI-TARS) à MAI-UI 8B sur TON écran, sans aucun clic. Ouvre une fenêtre que tu utilises (Firefox, Discord, l'Explorateur…) puis clique sur « Capturer mon écran » : Jaris se cache 5 secondes, photographie l'écran et revient. Windows donne la vraie position de chaque bouton, et chaque pilote doit la viser. Prends 2 ou 3 captures de fenêtres différentes avant de lancer le duel."
    >
      <SettingRow label="Captures" description={
          info.captures
            ? `${info.captures} capture(s), ${info.targets} bouton(s) à viser.${info.lastWindow ? ` Dernière fenêtre : « ${info.lastWindow} ».` : ''}`
            : 'Aucune capture pour l’instant.'
        }>
        <button className="options-menu__action" onClick={() => void capture()} disabled={capturing || running}>
          {capturing ? 'Capture dans 5 s…' : 'Capturer mon écran'}
        </button>
        {info.captures > 0 && (
          <button className="options-menu__action" onClick={() => void reset()} disabled={capturing || running}>
            Recommencer
          </button>
        )}
      </SettingRow>
      <SettingRow
        label="Lancer le duel"
        description="Télécharge MAI-UI 8B si besoin (environ 6 Go), puis fait viser chaque bouton aux deux pilotes, avec et sans zoom. Compte quelques minutes."
      >
        <button className="options-menu__action" onClick={() => void run()} disabled={!info.captures || capturing || running}>
          {running ? 'Duel en cours…' : 'Lancer le duel'}
        </button>
      </SettingRow>
      {running && progress && <p className="capacity-scan__status">{progress}</p>}
      {error && <p className="options-menu__ollama-update-note">{error}</p>}
      {outcome && (
        <div className="pilot-duel__result">
          <table className="pilot-duel__table">
            <thead>
              <tr>
                <th>Pilote</th>
                <th>1er regard</th>
                <th>Avec zoom</th>
                <th>Par bouton</th>
              </tr>
            </thead>
            <tbody>
              {outcome.scores.map((s) => (
                <tr key={s.label}>
                  <td>{s.label}</td>
                  {s.error ? (
                    <td colSpan={3}>impossible : {s.error}</td>
                  ) : (
                    <>
                      <td>
                        {s.hits}/{s.total}
                      </td>
                      <td>
                        {s.zoomHits}/{s.total}
                      </td>
                      <td>{s.secondsPerTarget} s</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <button className="options-menu__action" onClick={() => void window.jaris.pilotDuelOpenReport()}>
            Ouvrir le détail
          </button>
        </div>
      )}
    </SettingGroup>
  )
}
