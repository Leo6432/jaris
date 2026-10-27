import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import MediaPending from '@/components/MediaPending'
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
import { t } from '@/lib/i18n'

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
  /** Étape 291 : la demande en cours, rappelée au centre pendant la création (le champ est vidé dès l'envoi). */
  const [pendingPrompt, setPendingPrompt] = useState('')
  /** Une vidéo arrêtée : dite en une ligne discrète au-dessus du champ, plus dans un bandeau. */
  const [stoppedAfterMs, setStoppedAfterMs] = useState<number | null>(null)
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
        if (!cancelled) setError(t('video.missing'))
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

  /** L'arrêt et l'erreur décrivent UNE vidéo : effacés dès qu'on en change (leçon de l'étape 102). */
  const clearFeedback = (): void => {
    setStoppedAfterMs(null)
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
      setError(t('video.qualityMissing', { quality: videoQualityLabel(quality) }))
      return
    }
    stoppedRef.current = false
    const startedAt = Date.now()
    const sentAttachment = attachment
    const image = sentAttachment
      ? { base64: sentAttachment.base64, mimeType: sentAttachment.dataUrl.slice(5, sentAttachment.dataUrl.indexOf(';')) }
      : undefined
    // Comme ChatGPT : le champ se vide dès l'envoi, la demande est rappelée au-dessus de la vidéo en cours.
    setPendingPrompt(text)
    setPrompt('')
    setAttachment(null)
    setSelected(null)
    setGenerating(true)
    try {
      const video = await window.jaris.generateStudioVideo(text, image ?? null, seconds, quality)
      // La fin se voit : la vidéo prend la place du cadre d'attente (plus de bandeau « Terminé en… »), et un bip.
      setSelected(video)
      void playSoundCueIfEnabled('success')
      void refreshVideos()
    } catch (err) {
      // Rien n'est perdu : la demande (et l'image jointe) reviennent dans le champ, prêtes à être relancées.
      setPrompt(text)
      setAttachment(sentAttachment)
      if (stoppedRef.current) {
        setStoppedAfterMs(Date.now() - startedAt)
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
          <h2>{t('video.install.title')}</h2>
          <p className="image-install__lead">{t('video.install.lead')}</p>
          {!status.supported ? (
            <p className="code-panel__error">{t('video.install.windowsOnly')}</p>
          ) : !status.capable ? (
            <p className="code-panel__error">{t('video.install.notCapable', { reason: status.reason ?? '' })}</p>
          ) : installing ? (
            <div className="options-menu__progress">
              <div className="options-menu__progress-label">{logLine ?? t('media.preparingDownload')}</div>
              <div className="options-menu__progress-sub">
                <span>{t('media.keepOpen')}</span>
              </div>
            </div>
          ) : (
            <>
              <p className="image-install__lead">{t('video.install.heavy', { size: current?.downloadLabel ?? '' })}</p>
              {/* Étape 205 : la qualité se choisit AVANT de télécharger — seuls les crans possibles sur ce PC. */}
              {current && (
                <div className="video-install__quality">
                  <span>{t('video.quality')}</span>
                  <VideoQualityPicker qualities={status.qualities} value={current.id} onChange={chooseQuality} />
                </div>
              )}
              <button className="image-install__button" onClick={() => current && void install(current.id)}>
                {t('video.install.button', { quality: current?.label ?? '' })}
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
      newLabel={t('video.new')}
      label={t('app.mode.video')}
      onNew={startOver}
      items={videos.map((video) => ({ id: video.fileName, title: video.label, meta: formatRecentDate(video.timestamp) }))}
      activeId={selected?.fileName ?? null}
      onSelect={open}
      onDelete={(fileName) => void remove(fileName)}
      emptyLabel={t('video.listEmpty')}
    >
      <div className="code-panel image-panel video-panel">
        {!selected && !generating && !installing && (
          <div className="image-panel__home">
            <EmptyState
              title={t('video.empty.title')}
              description={t('video.empty.hint')}
              suggestions={[t('video.suggest.1'), t('video.suggest.2'), t('video.suggest.3')]}
              onSuggestion={setPrompt}
            />
            {gallery.length > 0 && (
              // Étape 268 : même section que le mode Image (titrée, centrée, juste sous les suggestions).
              <section className="image-panel__recent">
                <h2 className="image-panel__recent-title">{t('video.recent')}</h2>
                <ul className="image-panel__gallery video-panel__gallery" aria-label={t('video.recent.label')}>
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
                  <button className="image-panel__save" onClick={() => void save()} title={t('video.save.title')}>
                    <DownloadIcon /> {saved ? t('media.saved') : t('media.save')}
                  </button>
                  <button onClick={() => void window.jaris.openGeneratedVideos(selected.fileName)} title={t('video.reveal')}>
                    {t('common.openFolder')}
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

        {/* Étape 291 : comme le mode Image, l'attente au centre dans un cadre aux proportions de la vidéo ; l'arrêt
            passe par le bouton du champ. */}
        {generating && (
          <MediaPending
            shape="wide"
            title={t('video.creating')}
            prompt={pendingPrompt}
            detail={step ? t('media.step', { step: step.step, total: step.total }) : logLine}
            fraction={step ? step.step / step.total : null}
            elapsedMs={elapsedMs}
          />
        )}

        {/* Étape 205 : une autre qualité se télécharge depuis son bouton ; l'avancement s'affiche ici. */}
        {installing && (
          <MediaPending shape="wide" title={t('video.downloadingQuality', { quality: current?.label ?? '' })} detail={logLine ?? t('media.preparingDownload')} />
        )}

        {!generating && stoppedAfterMs !== null && <p className="media-note">{t('video.stoppedAfter', { duration: formatDuration(stoppedAfterMs) })}</p>}

        {error && <p className="code-panel__error">{error}</p>}

        <Composer
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => void generate()}
          placeholder={attachment ? t('video.placeholder.animate') : t('video.placeholder')}
          submitLabel={t('video.submit')}
          busyLabel={t('video.busy')}
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
