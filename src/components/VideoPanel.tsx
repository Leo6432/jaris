import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import Workspace from '@/components/Workspace'
import { formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import type { ImageAttachment } from '@/lib/imageAttachment'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { imageStepFromLog } from '../../shared/imageGallery'
import { DEFAULT_VIDEO_SECONDS, normalizeVideoSeconds, type VideoSeconds } from '../../shared/videoModel'
import type { GeneratedVideoSummary, VideoStudioStatus } from '../../shared/ipc'
import { DownloadIcon } from './icons'
import VideoDurationPicker from './VideoDurationPicker'

const DURATION_KEY = 'jaris.videoSeconds'

/** Dernière durée choisie, gardée d'une ouverture à l'autre (confort seulement : illisible → 2 s). */
function readSavedSeconds(): VideoSeconds {
  try {
    return normalizeVideoSeconds(Number(localStorage.getItem(DURATION_KEY)))
  } catch {
    return DEFAULT_VIDEO_SECONDS
  }
}

/**
 * Mode Vidéo (étape 203, Léo : « ajoute vidéo : Wan 2.2-TI2V-5B »). Même présentation que le mode Image — liste à
 * gauche, vidéo au centre, champ en bas — avec le modèle Wan 2.2 TI2V 5B, en local. Une image jointe avec le
 * « + » du champ est animée (image → vidéo) ; sans image, la vidéo part du texte seul.
 */
export default function VideoPanel(): JSX.Element {
  const [status, setStatus] = useState<VideoStudioStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  const [seconds, setSeconds] = useState<VideoSeconds>(readSavedSeconds)
  const [generating, setGenerating] = useState(false)
  const [logLine, setLogLine] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [videos, setVideos] = useState<GeneratedVideoSummary[]>([])
  const [selected, setSelected] = useState<GeneratedVideoSummary | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<{ kind: 'done' | 'stopped'; durationMs: number } | null>(null)
  const stoppedRef = useRef(false)

  const refreshVideos = async (): Promise<GeneratedVideoSummary[]> => {
    const list = await window.jaris.listGeneratedVideos()
    setVideos(list)
    return list
  }

  useEffect(() => {
    void window.jaris.getVideoStudioStatus().then(setStatus)
    void refreshVideos()
  }, [])
  useEffect(() => window.jaris.onVideoStudioLog(setLogLine), [])

  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [generating])

  // La vidéo arrive en octets par l'IPC puis devient une adresse blob: locale, libérée à chaque changement.
  useEffect(() => {
    setVideoUrl(null)
    if (!selected) return
    let url: string | null = null
    let cancelled = false
    window.jaris
      .readGeneratedVideo(selected.fileName)
      .then((bytes) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/webm' }))
        setVideoUrl(url)
      })
      .catch(() => {
        if (!cancelled) setError("Cette vidéo n'existe plus sur le disque.")
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [selected])

  /** Le bandeau de fin et l'erreur décrivent UNE vidéo : effacés dès qu'on en change (leçon de l'étape 102). */
  const clearFeedback = (): void => {
    setLastOutcome(null)
    setError(null)
    setSaved(false)
    setLogLine(null)
  }

  const install = async (): Promise<void> => {
    setError(null)
    setInstalling(true)
    setLogLine(null)
    try {
      await window.jaris.installVideoStudio()
      setStatus(await window.jaris.getVideoStudioStatus())
      void playSoundCueIfEnabled('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const generate = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || generating) return
    clearFeedback()
    setGenerating(true)
    stoppedRef.current = false
    const startedAt = Date.now()
    const image = attachment
      ? { base64: attachment.base64, mimeType: attachment.dataUrl.slice(5, attachment.dataUrl.indexOf(';')) }
      : undefined
    try {
      const video = await window.jaris.generateStudioVideo(text, image ?? null, seconds)
      setPrompt('')
      setAttachment(null)
      setSelected(video)
      setLastOutcome({ kind: 'done', durationMs: Date.now() - startedAt })
      void playSoundCueIfEnabled('success')
      void refreshVideos()
    } catch (err) {
      if (stoppedRef.current) {
        setLastOutcome({ kind: 'stopped', durationMs: Date.now() - startedAt })
      } else {
        setError(err instanceof Error ? err.message : String(err))
        void playSoundCueIfEnabled('error')
      }
    } finally {
      setGenerating(false)
      setLogLine(null)
    }
  }

  const chooseSeconds = (value: VideoSeconds): void => {
    setSeconds(value)
    try {
      localStorage.setItem(DURATION_KEY, String(value))
    } catch {
      // Pas de stockage : la durée reste choisie jusqu'à la fermeture de Jaris.
    }
  }

  const stop = (): void => {
    stoppedRef.current = true
    window.jaris.cancelStudioVideo()
  }

  const open = (fileName: string): void => {
    clearFeedback()
    setSelected(videos.find((video) => video.fileName === fileName) ?? null)
  }

  const remove = async (fileName: string): Promise<void> => {
    setError(null)
    try {
      await window.jaris.deleteGeneratedVideo(fileName)
      await refreshVideos()
      if (selected?.fileName === fileName) startOver()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    setSaved(false)
    const result = await window.jaris.saveGeneratedVideo(selected.fileName)
    if (result.error) setError(result.error)
    else if (result.saved) setSaved(true)
  }

  const startOver = (): void => {
    setSelected(null)
    clearFeedback()
  }

  if (!status) return <div className="image-panel image-panel--loading" />

  if (!status.supported || !status.capable || !status.installed) {
    return (
      <div className="image-panel image-install">
        <div className="image-install__card">
          <span className="image-install__eyebrow">Vidéo</span>
          <h2>Créer des vidéos</h2>
          <p className="image-install__lead">
            Décris une scène en français, ou joins une image à animer : Jaris crée une courte vidéo (de 1 à 5 secondes)
            sur ton PC avec Wan 2.2, sans rien envoyer sur internet.
          </p>
          {!status.supported ? (
            <p className="code-panel__error">La création de vidéos n'est disponible que sur Windows pour l'instant.</p>
          ) : !status.capable ? (
            <p className="code-panel__error">Ton PC n'a pas assez de puissance pour créer des vidéos : {status.reason}.</p>
          ) : installing ? (
            <div className="options-menu__progress">
              <div className="options-menu__progress-label">{logLine ?? 'Préparation du téléchargement…'}</div>
              <div className="options-menu__progress-sub">
                <span>Laisse Jaris ouvert pendant l'installation.</span>
              </div>
            </div>
          ) : (
            <>
              <p className="image-install__lead">
                C'est lourd : {status.downloadLabel} à télécharger, une seule fois. Et c'est lent : plusieurs minutes par
                vidéo, la carte graphique tourne à fond pendant ce temps.
              </p>
              <button className="image-install__button" onClick={() => void install()}>
                Installer le modèle vidéo
              </button>
            </>
          )}
          {error && <p className="code-panel__error">{error}</p>}
        </div>
      </div>
    )
  }

  const step = logLine ? imageStepFromLog(logLine) : null

  return (
    <Workspace
      newLabel="Nouvelle vidéo"
      onNew={startOver}
      items={videos.map((video) => ({ id: video.fileName, title: video.label, meta: formatRecentDate(video.timestamp) }))}
      activeId={selected?.fileName ?? null}
      onSelect={open}
      onDelete={(fileName) => void remove(fileName)}
      emptyLabel="Aucune vidéo pour l'instant."
    >
      <div className="code-panel image-panel video-panel">
        {!selected && !generating && (
          <div className="image-panel__home">
            <p className="code-panel__intro">
              Décris la scène : ce qui bouge, le décor, la lumière (ex : « un chat roux marche dans la neige au
              coucher du soleil, caméra qui le suit »). Pour animer une image, joins-la avec le « + » du champ.
            </p>
          </div>
        )}

        {selected && (
          <div className="code-panel__result image-panel__result">
            <div className="code-panel__result-bar">
              <span className="image-panel__title">{selected.label}</span>
              <div className="code-panel__result-actions">
                <button className="image-panel__save" onClick={() => void save()} title="Enregistrer la vidéo où tu veux">
                  <DownloadIcon /> {saved ? 'Enregistrée' : 'Enregistrer'}
                </button>
                <button onClick={() => void window.jaris.openGeneratedVideos(selected.fileName)} title="Montrer la vidéo dans son dossier">
                  Ouvrir le dossier
                </button>
              </div>
            </div>
            <div className="image-panel__stage">
              {videoUrl && <video className="image-panel__image video-panel__video" src={videoUrl} controls autoPlay loop />}
            </div>
          </div>
        )}

        {generating && (
          <div className="code-panel__live">
            <div className="code-panel__live-text">
              <span className="code-panel__live-title">
                {step ? `Vidéo : étape ${step.step} sur ${step.total}` : logLine ?? 'Préparation de la vidéo…'}
              </span>
              <span className="code-panel__live-detail">{formatDuration(elapsedMs)}</span>
              {step && (
                <div className="options-menu__progress-bar image-panel__progress">
                  <div className="options-menu__progress-bar-fill" style={{ width: `${Math.round((step.step / step.total) * 100)}%` }} />
                </div>
              )}
            </div>
            <button className="code-panel__live-stop" onClick={stop}>
              Arrêter
            </button>
          </div>
        )}

        {!generating && lastOutcome !== null && (
          <p className={`code-panel__done${lastOutcome.kind === 'stopped' ? ' code-panel__done--stopped' : ''}`}>
            <span>
              {lastOutcome.kind === 'done'
                ? `Terminé en ${formatDuration(lastOutcome.durationMs)} — ta vidéo est prête.`
                : `Vidéo arrêtée après ${formatDuration(lastOutcome.durationMs)}.`}
            </span>
          </p>
        )}

        {error && <p className="code-panel__error">{error}</p>}

        <Composer
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => void generate()}
          placeholder={attachment ? "Décris le mouvement à donner à l'image…" : 'Décris la vidéo à créer…'}
          submitLabel="Créer la vidéo"
          busyLabel="Vidéo…"
          busy={generating}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          onError={setError}
          rows={2}
          extraActions={<VideoDurationPicker value={seconds} onChange={chooseSeconds} disabled={generating} />}
        />
      </div>
    </Workspace>
  )
}
