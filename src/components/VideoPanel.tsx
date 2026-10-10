import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import Workspace from '@/components/Workspace'
import { formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { mediaRatio, mediaRatioStyle } from '@/lib/mediaRatio'
import type { ImageAttachment } from '@/lib/imageAttachment'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { imageStepFromLog } from '../../shared/imageGallery'
import { DEFAULT_VIDEO_SECONDS, normalizeVideoSeconds, videoQualityLabel, type VideoQuality, type VideoSeconds } from '../../shared/videoModel'
import type { GeneratedVideoSummary, VideoStudioStatus } from '../../shared/ipc'
import { DownloadIcon } from './icons'
import VideoDurationPicker from './VideoDurationPicker'
import VideoQualityPicker from './VideoQualityPicker'
import { readSaved, writeSaved } from '@/lib/savedSetting'

const DURATION_KEY = 'jaris.videoSeconds'
/** Comme l'écran Image : les dernières créations en vignettes sur l'accueil (étape 213). */
const GALLERY_SIZE = 8
const QUALITY_KEY = 'jaris.videoQuality'

/**
 * Qualité de départ (étape 205) : la dernière choisie si cette machine la propose encore, sinon la plus fidèle déjà
 * téléchargée, sinon la plus fidèle que la machine peut faire tourner.
 */
function initialQuality(status: VideoStudioStatus): VideoQuality | null {
  const saved = status.qualities.find((q) => q.id === readSaved(QUALITY_KEY))
  if (saved) return saved.id
  const installed = status.qualities.filter((q) => q.installed)
  return (installed[installed.length - 1] ?? status.qualities[status.qualities.length - 1])?.id ?? null
}

/** Dernière durée choisie, gardée d'une ouverture à l'autre (confort seulement : illisible → 2 s). */
function readSavedSeconds(): VideoSeconds {
  const saved = readSaved(DURATION_KEY)
  return saved === null ? DEFAULT_VIDEO_SECONDS : normalizeVideoSeconds(Number(saved))
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
  const [quality, setQuality] = useState<VideoQuality | null>(null)
  const [generating, setGenerating] = useState(false)
  const [logLine, setLogLine] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [videos, setVideos] = useState<GeneratedVideoSummary[]>([])
  const [selected, setSelected] = useState<GeneratedVideoSummary | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<{ kind: 'done' | 'stopped'; durationMs: number } | null>(null)
  const stoppedRef = useRef(false)
  // Vignettes de l'accueil (étape 213, Léo : « sur image on voit toutes les images, sur vidéo on ne voit rien »).
  // Chaque vidéo arrive en entier par l'IPC et devient une adresse blob: locale, libérée quand la vidéo est
  // supprimée ou que l'écran se ferme — sinon chaque passage par l'onglet garderait toutes ces vidéos en mémoire.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const thumbnailsRef = useRef<Record<string, string>>({})
  thumbnailsRef.current = thumbnails

  const refreshVideos = async (): Promise<GeneratedVideoSummary[]> => {
    const list = await window.jaris.listGeneratedVideos()
    setVideos(list)
    return list
  }

  const refreshStatus = async (): Promise<VideoStudioStatus> => {
    const next = await window.jaris.getVideoStudioStatus()
    setStatus(next)
    setQuality((current) => (current && next.qualities.some((q) => q.id === current) ? current : initialQuality(next)))
    return next
  }

  useEffect(() => {
    void refreshStatus()
    void refreshVideos()
  }, [])
  useEffect(() => window.jaris.onVideoStudioLog(setLogLine), [])
  // Vidéo créée depuis le téléphone : elle apparaît aussi ici sans avoir à rouvrir le mode.
  useEffect(() => window.jaris.onStudioGalleryChanged?.(() => void refreshVideos()), [])

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
    setRatio(null)
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

  const ready = status !== null && status.supported && status.capable && status.qualities.some((q) => q.installed)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    for (const video of videos.slice(0, GALLERY_SIZE)) {
      if (thumbnailsRef.current[video.fileName]) continue
      void window.jaris
        .readGeneratedVideo(video.fileName)
        .then((bytes) => {
          if (cancelled) return
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/webm' }))
          setThumbnails((prev) => {
            // Arrivée en double (deux rafraîchissements rapprochés) : garder la première, libérer l'autre.
            if (prev[video.fileName]) {
              URL.revokeObjectURL(url)
              return prev
            }
            return { ...prev, [video.fileName]: url }
          })
        })
        .catch(() => {
          // Vidéo effacée entre la liste et la lecture : la vignette reste vide, rien de plus.
        })
    }
    return () => {
      cancelled = true
    }
  }, [videos, ready])

  useEffect(
    () => () => {
      for (const url of Object.values(thumbnailsRef.current)) URL.revokeObjectURL(url)
    },
    []
  )

  /** Le bandeau de fin et l'erreur décrivent UNE vidéo : effacés dès qu'on en change (leçon de l'étape 102). */
  const clearFeedback = (): void => {
    setLastOutcome(null)
    setError(null)
    setSaved(false)
    setLogLine(null)
  }

  const install = async (level: VideoQuality): Promise<void> => {
    setError(null)
    setInstalling(true)
    setLogLine(null)
    try {
      await window.jaris.installVideoStudio(level)
      await refreshStatus()
      void playSoundCueIfEnabled('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const generate = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || generating || installing || !quality) return
    clearFeedback()
    if (!status?.qualities.find((q) => q.id === quality)?.installed) {
      setError(`La qualité ${videoQualityLabel(quality)} n'est pas encore téléchargée : clique sur le bouton de qualité puis « Télécharger ».`)
      return
    }
    setGenerating(true)
    stoppedRef.current = false
    const startedAt = Date.now()
    const image = attachment
      ? { base64: attachment.base64, mimeType: attachment.dataUrl.slice(5, attachment.dataUrl.indexOf(';')) }
      : undefined
    try {
      const video = await window.jaris.generateStudioVideo(text, image ?? null, seconds, quality)
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
    writeSaved(DURATION_KEY, String(value))
  }

  const chooseQuality = (value: VideoQuality): void => {
    setQuality(value)
    setError(null)
    writeSaved(QUALITY_KEY, value)
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
      setThumbnails((prev) => {
        if (!prev[fileName]) return prev
        URL.revokeObjectURL(prev[fileName])
        const next = { ...prev }
        delete next[fileName]
        return next
      })
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

  const current = status.qualities.find((q) => q.id === quality) ?? null

  if (!status.supported || !status.capable || !status.qualities.some((q) => q.installed)) {
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
                C'est lourd : {current?.downloadLabel} à télécharger, une seule fois. Et c'est lent : plusieurs minutes
                par vidéo, la carte graphique tourne à fond pendant ce temps.
              </p>
              {/* Étape 205 : la qualité se choisit AVANT de télécharger — seuls les crans possibles sur ce PC. */}
              {current && (
                <div className="video-install__quality">
                  <span>Qualité</span>
                  <VideoQualityPicker qualities={status.qualities} value={current.id} onChange={chooseQuality} />
                </div>
              )}
              <button className="image-install__button" onClick={() => current && void install(current.id)}>
                Installer la qualité {current?.label}
              </button>
            </>
          )}
          {error && <p className="code-panel__error">{error}</p>}
        </div>
      </div>
    )
  }

  const step = logLine ? imageStepFromLog(logLine) : null
  const gallery = videos.slice(0, GALLERY_SIZE)

  return (
    <Workspace
      newLabel="Nouvelle vidéo"
      label="Vidéo"
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
            <EmptyState
              title="Quelle vidéo veux-tu créer ?"
              description="Décris la scène : ce qui bouge, le décor, la lumière. Pour animer une image, joins-la avec le « + » du champ."
              suggestions={['Des vagues sur une plage au ralenti', 'Un renard qui court dans la neige', 'Une ville la nuit en accéléré']}
              onSuggestion={setPrompt}
            />
            {gallery.length > 0 && (
              // Étape 268 : même section que le mode Image (titrée, centrée, juste sous les suggestions).
              <section className="image-panel__recent">
                <h2 className="image-panel__recent-title">Tes dernières vidéos</h2>
                <ul className="image-panel__gallery video-panel__gallery" aria-label="Dernières vidéos">
                  {gallery.map((video) => (
                    <li key={video.fileName}>
                      <button className="image-panel__thumb video-panel__thumb" onClick={() => open(video.fileName)} title={video.label}>
                        {thumbnails[video.fileName] ? (
                          // Première image affichée à l'arrêt, lecture au survol : on voit ce qui bouge sans tout lancer.
                          <video
                            src={thumbnails[video.fileName]}
                            muted
                            loop
                            playsInline
                            preload="auto"
                            aria-label={video.label}
                            onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                            onMouseLeave={(e) => {
                              e.currentTarget.pause()
                              e.currentTarget.currentTime = 0
                            }}
                          />
                        ) : (
                          <span className="image-panel__thumb-empty" />
                        )}
                        <span className="video-panel__thumb-play" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {selected && (
          <div className="code-panel__result image-panel__result">
            {/* Étape 271 (Léo : « c'est mal présenté les vidéos ») : plus de titre ici, l'en-tête de la fenêtre le
                donne déjà ; la vidéo prend toute la place disponible à ses proportions (voir mediaRatioStyle).
                Étape 272 (« pourquoi les boutons sont aussi écartés de la vidéo ») : les actions sont collées au
                coin haut-droit de la vidéo elle-même (la figure fait sa largeur), plus au bord de la zone. */}
            <div className="image-panel__stage">
              <figure className="image-panel__figure">
                <div className="code-panel__result-actions image-panel__actions">
                  <button className="image-panel__save" onClick={() => void save()} title="Enregistrer la vidéo où tu veux">
                    <DownloadIcon /> {saved ? 'Enregistrée' : 'Enregistrer'}
                  </button>
                  <button onClick={() => void window.jaris.openGeneratedVideos(selected.fileName)} title="Montrer la vidéo dans son dossier">
                    Ouvrir le dossier
                  </button>
                </div>
                {videoUrl && (
                  <video
                    className="image-panel__image video-panel__video"
                    src={videoUrl}
                    controls
                    autoPlay
                    loop
                    style={mediaRatioStyle(ratio)}
                    onLoadedMetadata={(e) => setRatio(mediaRatio(e.currentTarget.videoWidth, e.currentTarget.videoHeight))}
                  />
                )}
              </figure>
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

        {/* Étape 205 : une autre qualité se télécharge depuis son bouton ; l'avancement s'affiche ici. */}
        {installing && (
          <div className="code-panel__live">
            <div className="code-panel__live-text">
              <span className="code-panel__live-title">Téléchargement de la qualité {current?.label}…</span>
              <span className="code-panel__live-detail">{logLine ?? 'Préparation du téléchargement…'}</span>
            </div>
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
          attachment={attachment}
          onAttachmentChange={setAttachment}
          onError={setError}
          rows={2}
          busy={generating || installing}
          onStop={generating ? stop : undefined}
          extraActions={
            <>
              {current && (
                <VideoQualityPicker
                  qualities={status.qualities}
                  value={current.id}
                  onChange={chooseQuality}
                  onDownload={(level) => void install(level)}
                  disabled={generating || installing}
                />
              )}
              <VideoDurationPicker value={seconds} onChange={chooseSeconds} disabled={generating} />
            </>
          }
        />
      </div>
    </Workspace>
  )
}
