import { useEffect, useRef, useState } from 'react'
import {
  DUEL_MODEL_LABELS,
  DUEL_PROMPTS,
  DUEL_SECONDS,
  duelPair,
  duelVideoFile,
  formatDuelDuration,
  summarizeDuel,
  type DuelChoice,
  type DuelModel,
  type DuelPromptId,
  type VideoDuelResults,
  type VideoDuelStatus
} from '../../shared/videoDuel'
import { SettingGroup, SettingRow } from './SettingsLayout'

/**
 * Étape 257 — Options → Général → Développeur : le duel vidéo FastWan contre Kandinsky 6 Lite, sur la machine de Léo.
 * Jugement À L'AVEUGLE : chaque description montre « A » et « B » (ordre tiré au hasard par le duel), le nom du modèle et
 * son temps n'apparaissent qu'après le choix. Le choix est enregistré avec les temps (resultats.json).
 */
export function VideoDuelSettings(): JSX.Element {
  const [status, setStatus] = useState<VideoDuelStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())

  const refresh = async (): Promise<void> => {
    try {
      const next = await window.jaris.getVideoDuelStatus()
      setStatus(next)
      setRunning(next.running)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    return window.jaris.onVideoDuelLog((message) => {
      setLog(message)
      // Une vidéo vient d'être enregistrée : la montrer tout de suite, sans attendre la fin du duel.
      if (/faite en/.test(message)) void refresh()
    })
  }, [])

  // Le compteur avance chaque seconde : la preuve que le duel travaille (plusieurs minutes par vidéo).
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const start = async (): Promise<void> => {
    setError(null)
    setRunning(true)
    setStartedAt(Date.now())
    setLog('Préparation du duel…')
    try {
      await window.jaris.runVideoDuel()
      setLog('Duel terminé : regarde les vidéos et choisis la meilleure pour chaque description.')
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(err))
    } finally {
      setRunning(false)
      setStartedAt(null)
      void refresh()
    }
  }

  const choose = async (prompt: DuelPromptId, choice: DuelChoice): Promise<void> => {
    const results = await window.jaris.setVideoDuelChoice(prompt, choice)
    if (results && status) setStatus({ ...status, results })
  }

  const removeFiles = async (): Promise<void> => {
    setError(null)
    try {
      await window.jaris.deleteVideoDuelFiles()
      setLog('Fichiers du duel effacés (les vidéos et les résultats sont gardés).')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    void refresh()
  }

  const results = status?.results ?? null
  return (
    <SettingGroup
      title="Développeur"
      description="Outils de test. Rien ici ne change le fonctionnement normal de Jaris."
    >
      <SettingRow
        label="Duel vidéo : FastWan contre Kandinsky 6 Lite"
        description={
          `Les mêmes 3 descriptions (un humain, un paysage, un chat), ${DUEL_SECONDS} s chacune, même taille, avec chaque modèle, sur ton PC. ` +
          'Tu compares à l’aveugle (vidéo A ou B) ; le nom et le temps s’affichent après ton choix. ' +
          (status?.downloadLabel ? `Premier lancement : ${status.downloadLabel} à télécharger, à part du reste de Jaris.` : '')
        }
        stacked
      >
        {status?.blocker ? (
          <p className="options-menu__ollama-update-note">{status.blocker}</p>
        ) : running ? (
          <button className="options-menu__action options-menu__action--danger" onClick={() => window.jaris.cancelVideoDuel()}>
            Arrêter le duel
          </button>
        ) : (
          <button className="options-menu__action" onClick={() => void start()} disabled={!status}>
            {results ? 'Relancer le duel' : 'Lancer le duel'}
          </button>
        )}
        {running && log && (
          <p className="capacity-scan__status video-duel__log">
            {log}
            {startedAt ? ` — ${formatDuelDuration((now - startedAt) / 1000)} écoulées` : ''}
          </p>
        )}
        {!running && log && <p className="capacity-scan__status video-duel__log">{log}</p>}
        {error && <p className="options-menu__ollama-update-note video-duel__error">{error}</p>}
        {results?.error && !running && !error && (
          <p className="options-menu__ollama-update-note video-duel__error">Dernier duel arrêté : {results.error}</p>
        )}
      </SettingRow>

      {results && <DuelResults results={results} onChoose={(prompt, choice) => void choose(prompt, choice)} />}

      {results && (
        <SettingRow label="Fichiers du duel" description="Les vidéos et resultats.json restent ; effacer libère l’environnement Python et Kandinsky (~31 Go).">
          <button className="options-menu__action" onClick={() => void window.jaris.openVideoDuelFolder()}>
            Ouvrir le dossier
          </button>
          <button className="options-menu__action options-menu__action--danger" onClick={() => void removeFiles()} disabled={running}>
            Effacer les fichiers
          </button>
        </SettingRow>
      )}
    </SettingGroup>
  )
}

function DuelResults({ results, onChoose }: { results: VideoDuelResults; onChoose: (prompt: DuelPromptId, choice: DuelChoice) => void }): JSX.Element {
  const summary = summarizeDuel(results)
  const timeOf = (model: DuelModel, prompt: DuelPromptId): number | null =>
    results.videos.find((v) => v.model === model && v.prompt === prompt)?.seconds ?? null
  return (
    <div className="video-duel">
      <p className="options-menu__row-description">
        Duel du {new Date(results.date).toLocaleString('fr-FR')} — {results.machine}, FastWan en qualité {results.fastwanQuality}.
      </p>
      {DUEL_PROMPTS.map((prompt) => {
        const [a, b] = duelPair(results.order, prompt.id)
        const choice = results.choices[prompt.id]
        const both = timeOf(a, prompt.id) !== null && timeOf(b, prompt.id) !== null
        return (
          <div key={prompt.id} className="video-duel__prompt">
            <div className="video-duel__title">{prompt.label}</div>
            <p className="video-duel__text">« {prompt.prompt} »</p>
            <div className="video-duel__pair">
              {([['A', a], ['B', b]] as const).map(([letter, model]) => {
                const seconds = timeOf(model, prompt.id)
                return (
                  <figure key={letter} className={`video-duel__side${choice === model ? ' video-duel__side--chosen' : ''}`}>
                    <figcaption className="video-duel__letter">
                      Vidéo {letter}
                      {choice && <span className="video-duel__reveal"> — {DUEL_MODEL_LABELS[model]}{seconds !== null ? `, ${formatDuelDuration(seconds)}` : ''}</span>}
                    </figcaption>
                    {seconds !== null ? <DuelVideo file={duelVideoFile(model, prompt.id)} /> : <div className="video-duel__missing">Pas encore faite</div>}
                  </figure>
                )
              })}
            </div>
            {both && (
              <div className="video-duel__choices">
                <button className={`options-menu__action${choice === a ? ' video-duel__choice--active' : ''}`} onClick={() => onChoose(prompt.id, a)}>
                  A est mieux
                </button>
                <button className={`options-menu__action${choice === b ? ' video-duel__choice--active' : ''}`} onClick={() => onChoose(prompt.id, b)}>
                  B est mieux
                </button>
                <button className={`options-menu__action${choice === 'egalite' ? ' video-duel__choice--active' : ''}`} onClick={() => onChoose(prompt.id, 'egalite')}>
                  Pareil
                </button>
              </div>
            )}
          </div>
        )
      })}
      {summary.complete && (
        <p className="video-duel__summary">
          Ton choix : FastWan {summary.wins.fastwan}, Kandinsky {summary.wins.kandinsky}, pareil {summary.wins.egalite}. Temps total pour les 3 vidéos :
          FastWan {summary.totals.fastwan !== null ? formatDuelDuration(summary.totals.fastwan) : '—'}, Kandinsky{' '}
          {summary.totals.kandinsky !== null ? formatDuelDuration(summary.totals.kandinsky) : '—'}
          {results.kandinsky.encodeSeconds !== null ? ` (+ ${formatDuelDuration(results.kandinsky.encodeSeconds)} de lecture des descriptions)` : ''}.
          {results.kandinsky.offload === 'sequential' ? ' Kandinsky a dû passer sur la carte morceau par morceau (mémoire vidéo trop petite).' : ''}
        </p>
      )}
    </div>
  )
}

/** Lit la vidéo par le processus principal (seul un nom voyage) et la montre ; libère l'adresse en partant. */
function DuelVideo({ file }: { file: string }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.jaris
      .readDuelVideo(file)
      .then((bytes) => {
        if (cancelled) return
        urlRef.current = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.endsWith('.mp4') ? 'video/mp4' : 'video/webm' }))
        setUrl(urlRef.current)
      })
      .catch(() => setUrl(null))
    return () => {
      cancelled = true
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [file])
  return url ? <video className="video-duel__video" src={url} controls loop /> : <div className="video-duel__missing">Chargement…</div>
}
