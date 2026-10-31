import { useEffect, useRef, useState } from 'react'
import { useReportActivity } from '@/lib/useReportActivity'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import MediaPending from '@/components/MediaPending'
import Workspace from '@/components/Workspace'
import { formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { mediaRatio, mediaRatioStyle } from '@/lib/mediaRatio'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { imageStepFromLog } from '../../shared/imageGallery'
import type { GeneratedImageSummary, ImageStudioStatus } from '../../shared/ipc'
import { DownloadIcon } from './icons'
import { t } from '@/lib/i18n'

/** Nombre d'images montrées en vignettes sur l'accueil du mode Image (chacune voyage en entier par l'IPC). */
const GALLERY_SIZE = 8

/**
 * Mode Image (étape 200, Léo : « enlève Montage, on le remplace par Image comme ChatGPT »). Même présentation
 * que le Chat et le Code — liste à gauche, image au centre, champ en bas — et, sans image ouverte, les
 * dernières images en vignettes comme la page Images de ChatGPT. Le dessin lui-même est celui de l'étape 173
 * (FLUX.2 klein, en local) : rien n'est envoyé sur internet.
 */
export default function ImagePanel(): JSX.Element {
  const [status, setStatus] = useState<ImageStudioStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  useReportActivity('image', generating ? 'thinking' : null)
  const [logLine, setLogLine] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [images, setImages] = useState<GeneratedImageSummary[]>([])
  const [selected, setSelected] = useState<GeneratedImageSummary | null>(null)
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  // Proportions de l'image affichée (étape 271), rangées AVEC l'adresse qu'elles décrivent. Les effacer dans un
  // useEffect à chaque nouvelle image perdait la course quand l'image était déjà en mémoire : son chargement
  // arrivait avant l'effet, qui effaçait alors la bonne valeur, et l'image restait à sa taille d'origine.
  const [loadedRatio, setLoadedRatio] = useState<{ url: string; ratio: number | null } | null>(null)
  const ratio = loadedRatio && loadedRatio.url === selectedUrl ? loadedRatio.ratio : null
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** Étape 291 : la demande en cours, rappelée au centre pendant le dessin (le champ est vidé dès l'envoi). */
  const [pendingPrompt, setPendingPrompt] = useState('')
  /** Un dessin arrêté : dit en une ligne discrète au-dessus du champ, plus dans un bandeau. */
  const [stoppedAfterMs, setStoppedAfterMs] = useState<number | null>(null)
  const stoppedRef = useRef(false)

  const refreshImages = async (): Promise<GeneratedImageSummary[]> => {
    const list = await window.jaris.listGeneratedImages()
    setImages(list)
    return list
  }

  useEffect(() => {
    void window.jaris.getImageStudioStatus().then(setStatus)
    void refreshImages()
  }, [])
  useEffect(() => window.jaris.onImageStudioLog(setLogLine), [])
  // Image créée depuis le téléphone : elle apparaît aussi ici sans avoir à rouvrir le mode.
  useEffect(() => window.jaris.onStudioGalleryChanged?.(() => void refreshImages()), [])

  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [generating])

  const ready = status !== null && status.supported && status.capable && status.installed

  // Vignettes de l'accueil : seulement les plus récentes, pas encore chargées, et seulement quand la galerie est
  // réellement affichée (pas derrière l'écran d'installation : chaque image voyage en entier par l'IPC).
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    for (const image of images.slice(0, GALLERY_SIZE)) {
      if (thumbnails[image.fileName]) continue
      void window.jaris.readGeneratedImage(image.fileName).then((url) => {
        if (!cancelled && url) setThumbnails((prev) => ({ ...prev, [image.fileName]: url }))
      })
    }
    return () => {
      cancelled = true
    }
    // `thumbnails` volontairement absent : il ne fait que grossir, relancer la boucle ne chargerait rien de neuf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, ready])

  useEffect(() => {
    setSelectedUrl(null)
    if (!selected) return
    let cancelled = false
    void window.jaris.readGeneratedImage(selected.fileName).then((url) => {
      if (cancelled) return
      if (url) setSelectedUrl(url)
      else setError(t('image.missing'))
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  /** L'arrêt et l'erreur décrivent UNE image : effacés dès qu'on en change (leçon de l'étape 102). */
  const clearFeedback = (): void => {
    setStoppedAfterMs(null)
    setError(null)
    setSaved(false)
    setLogLine(null)
  }

  const install = async (): Promise<void> => {
    setError(null)
    setInstalling(true)
    setLogLine(null)
    try {
      await window.jaris.installImageStudio()
      setStatus(await window.jaris.getImageStudioStatus())
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
    // Comme ChatGPT : le champ se vide dès l'envoi, la demande est rappelée au-dessus de l'image en cours.
    setPendingPrompt(text)
    setPrompt('')
    setSelected(null)
    setGenerating(true)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      const image = await window.jaris.generateStudioImage(text)
      // La fin se voit : l'image prend la place du cadre d'attente (plus de bandeau « Terminé en… »), et un bip.
      setSelected(image)
      void playSoundCueIfEnabled('success')
      void refreshImages()
    } catch (err) {
      // Rien n'est perdu : la demande revient dans le champ, prête à être relancée ou corrigée.
      setPrompt(text)
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

  const stop = (): void => {
    stoppedRef.current = true
    window.jaris.cancelStudioImage()
  }

  const open = (fileName: string): void => {
    clearFeedback()
    setSelected(images.find((image) => image.fileName === fileName) ?? null)
  }

  const remove = async (fileName: string): Promise<void> => {
    setError(null)
    try {
      await window.jaris.deleteGeneratedImage(fileName)
      setThumbnails((prev) => {
        const next = { ...prev }
        delete next[fileName]
        return next
      })
      await refreshImages()
      if (selected?.fileName === fileName) startOver()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async (): Promise<void> => {
    if (!selectedUrl) return
    setSaved(false)
    const result = await window.jaris.saveGeneratedImage(selectedUrl)
    if (result.error) setError(result.error)
    else if (result.saved) setSaved(true)
  }

  const startOver = (): void => {
    setSelected(null)
    clearFeedback()
  }

  if (!status) return <div className="image-panel image-panel--loading" />

  if (!ready) {
    return (
      <div className="image-panel image-install">
        <div className="image-install__card">
          <h2>{t('image.install.title')}</h2>
          <p className="image-install__lead">{t('image.install.lead')}</p>
          {!status.supported ? (
            <p className="code-panel__error">{t('image.install.windowsOnly')}</p>
          ) : !status.capable ? (
            <p className="code-panel__error">{t('image.install.notCapable', { reason: status.reason ?? '' })}</p>
          ) : installing ? (
            <div className="options-menu__progress">
              <div className="options-menu__progress-label">{logLine ?? t('media.preparingDownload')}</div>
              <div className="options-menu__progress-sub">
                <span>{t('media.keepOpen')}</span>
              </div>
            </div>
          ) : (
            <>
              <p className="image-install__lead">{t('image.install.missing', { size: status.downloadLabel })}</p>
              <button className="image-install__button" onClick={() => void install()}>
                {t('image.install.button')}
              </button>
            </>
          )}
          {error && <p className="code-panel__error">{error}</p>}
        </div>
      </div>
    )
  }

  const step = logLine ? imageStepFromLog(logLine) : null
  const gallery = images.slice(0, GALLERY_SIZE)

  return (
    <Workspace
      newLabel={t('image.new')}
      label={t('app.mode.image')}
      onNew={startOver}
      items={images.map((image) => ({ id: image.fileName, title: image.label, meta: formatRecentDate(image.timestamp) }))}
      activeId={selected?.fileName ?? null}
      onSelect={open}
      onDelete={(fileName) => void remove(fileName)}
      emptyLabel={t('image.listEmpty')}
    >
      <div className="code-panel image-panel">
        {!selected && !generating && (
          <div className="image-panel__home">
            <EmptyState
              title={t('image.empty.title')}
              description={t('image.empty.hint')}
              suggestions={[t('image.suggest.1'), t('image.suggest.2'), t('image.suggest.3')]}
              onSuggestion={setPrompt}
            />
            {gallery.length > 0 && (
              // Étape 268 : une section titrée, centrée à la largeur du champ de saisie, juste sous les
              // suggestions (elle était repoussée en bas de l'écran et collée à gauche).
              <section className="image-panel__recent">
                <h2 className="image-panel__recent-title">{t('image.recent')}</h2>
                <ul className="image-panel__gallery" aria-label={t('image.recent.label')}>
                  {gallery.map((image) => (
                    <li key={image.fileName}>
                      <button className="image-panel__thumb" onClick={() => open(image.fileName)} title={image.label}>
                        {thumbnails[image.fileName] ? <img src={thumbnails[image.fileName]} alt={image.label} /> : <span className="image-panel__thumb-empty" />}
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
            {/* Étape 271 : même lecteur que la vidéo — plus de titre répété (l'en-tête le donne), l'image à toute
                la place disponible ; étape 272 : les actions collées à son coin haut-droit. */}
            <div className="image-panel__stage">
              <figure className="image-panel__figure">
                <div className="code-panel__result-actions image-panel__actions">
                  <button className="image-panel__save" onClick={() => void save()} disabled={!selectedUrl} title={t('image.save.title')}>
                    <DownloadIcon /> {saved ? t('media.saved') : t('media.save')}
                  </button>
                  <button onClick={() => void window.jaris.openGeneratedImages(selected.fileName)} title={t('image.reveal')}>
                    {t('common.openFolder')}
                  </button>
                </div>
                {selectedUrl && (
                  <img
                    className="image-panel__image"
                    src={selectedUrl}
                    alt={selected.label}
                    style={mediaRatioStyle(ratio)}
                    onLoad={(e) => setLoadedRatio({ url: selectedUrl, ratio: mediaRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) })}
                  />
                )}
              </figure>
            </div>
          </div>
        )}

        {/* Étape 291 (Léo : « image c'est une catastrophe, pourquoi c'est tout en haut ») : l'attente au centre,
            dans un cadre aux proportions de l'image ; l'arrêt passe par le bouton du champ, comme dans le Chat. */}
        {generating && (
          <MediaPending
            shape="square"
            title={t('image.creating')}
            prompt={pendingPrompt}
            detail={step ? t('media.step', { step: step.step, total: step.total }) : logLine}
            fraction={step ? step.step / step.total : null}
            elapsedMs={elapsedMs}
          />
        )}

        {!generating && stoppedAfterMs !== null && <p className="media-note">{t('image.stoppedAfter', { duration: formatDuration(stoppedAfterMs) })}</p>}

        {error && <p className="code-panel__error">{error}</p>}

        <Composer
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => void generate()}
          placeholder={t('image.placeholder')}
          submitLabel={t('image.submit')}
          busyLabel={t('image.busy')}
          busy={generating}
          onStop={stop}
          attachment={null}
          onAttachmentChange={() => {}}
          onError={setError}
          imagesAllowed={false}
          rows={2}
        />
      </div>
    </Workspace>
  )
}
