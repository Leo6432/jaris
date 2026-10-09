import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import Workspace from '@/components/Workspace'
import { formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { mediaRatio, mediaRatioStyle } from '@/lib/mediaRatio'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { imageStepFromLog } from '../../shared/imageGallery'
import type { GeneratedImageSummary, ImageStudioStatus } from '../../shared/ipc'
import { DownloadIcon } from './icons'

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
  const [logLine, setLogLine] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [images, setImages] = useState<GeneratedImageSummary[]>([])
  const [selected, setSelected] = useState<GeneratedImageSummary | null>(null)
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)
  // Proportions de l'image affichée (étape 271) : remises à zéro à chaque nouvelle image.
  useEffect(() => setRatio(null), [selectedUrl])
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<{ kind: 'done' | 'stopped'; durationMs: number } | null>(null)
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
      else setError("Cette image n'existe plus sur le disque.")
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  /** Le bandeau de fin et l'erreur décrivent UNE image : effacés dès qu'on en change (leçon de l'étape 102). */
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
    setGenerating(true)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      const image = await window.jaris.generateStudioImage(text)
      setPrompt('')
      setSelected(image)
      setLastOutcome({ kind: 'done', durationMs: Date.now() - startedAt })
      void playSoundCueIfEnabled('success')
      void refreshImages()
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
          <span className="image-install__eyebrow">Image</span>
          <h2>Créer des images</h2>
          <p className="image-install__lead">
            Décris une image en français : Jaris la dessine sur ton PC (FLUX.2 klein), sans rien envoyer sur internet.
          </p>
          {!status.supported ? (
            <p className="code-panel__error">La création d'images n'est disponible que sur Windows pour l'instant.</p>
          ) : !status.capable ? (
            <p className="code-panel__error">Ton PC n'a pas assez de puissance pour dessiner : {status.reason}.</p>
          ) : installing ? (
            <div className="options-menu__progress">
              <div className="options-menu__progress-label">{logLine ?? 'Préparation du téléchargement…'}</div>
              <div className="options-menu__progress-sub">
                <span>Laisse Jaris ouvert pendant l'installation.</span>
              </div>
            </div>
          ) : (
            <>
              <p className="image-install__lead">Le modèle de dessin n'est pas encore installé : {status.downloadLabel} à télécharger, une seule fois.</p>
              <button className="image-install__button" onClick={() => void install()}>
                Installer le modèle d'image
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
      newLabel="Nouvelle image"
      label="Image"
      onNew={startOver}
      items={images.map((image) => ({ id: image.fileName, title: image.label, meta: formatRecentDate(image.timestamp) }))}
      activeId={selected?.fileName ?? null}
      onSelect={open}
      onDelete={(fileName) => void remove(fileName)}
      emptyLabel="Aucune image pour l'instant."
    >
      <div className="code-panel image-panel">
        {!selected && !generating && (
          <div className="image-panel__home">
            <EmptyState
              title="Qu'est-ce qu'on dessine ?"
              description="Décris l'image à créer : le sujet, le style, les couleurs. Les images sont générées sur ton ordinateur, sans limite."
              suggestions={['Un phare au crépuscule, aquarelle', 'Un chat astronaute, style affiche', 'Une cuisine scandinave lumineuse']}
              onSuggestion={setPrompt}
            />
            {gallery.length > 0 && (
              // Étape 268 : une section titrée, centrée à la largeur du champ de saisie, juste sous les
              // suggestions (elle était repoussée en bas de l'écran et collée à gauche).
              <section className="image-panel__recent">
                <h2 className="image-panel__recent-title">Tes dernières images</h2>
                <ul className="image-panel__gallery" aria-label="Dernières images">
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
                  <button className="image-panel__save" onClick={() => void save()} disabled={!selectedUrl} title="Enregistrer l'image où tu veux">
                    <DownloadIcon /> {saved ? 'Enregistrée' : 'Enregistrer'}
                  </button>
                  <button onClick={() => void window.jaris.openGeneratedImages(selected.fileName)} title="Montrer l'image dans son dossier">
                    Ouvrir le dossier
                  </button>
                </div>
                {selectedUrl && (
                  <img
                    className="image-panel__image"
                    src={selectedUrl}
                    alt={selected.label}
                    style={mediaRatioStyle(ratio)}
                    onLoad={(e) => setRatio(mediaRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
                  />
                )}
              </figure>
            </div>
          </div>
        )}

        {generating && (
          <div className="code-panel__live">
            <div className="code-panel__live-text">
              <span className="code-panel__live-title">{step ? `Dessin : étape ${step.step} sur ${step.total}` : logLine ?? "Préparation du dessin…"}</span>
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
                ? `Terminé en ${formatDuration(lastOutcome.durationMs)} — ton image est prête.`
                : `Dessin arrêté après ${formatDuration(lastOutcome.durationMs)}.`}
            </span>
          </p>
        )}

        {error && <p className="code-panel__error">{error}</p>}

        <Composer
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => void generate()}
          placeholder="Décris l'image à créer…"
          submitLabel="Créer l'image"
          busyLabel="Dessin…"
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
