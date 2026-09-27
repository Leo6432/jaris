import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import Workspace from '@/components/Workspace'
import { formatCodeGenProgress, formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import type { CodeGenProgress, GeneratedVideo, GeneratedVideoSummary, MontageInstallProgress, MontageStatus } from '../../shared/ipc'
import { MONTAGE_DISK_LABEL, MONTAGE_DOWNLOAD_LABEL } from '../../shared/montage'
import { DownloadIcon } from './icons'
import ModelPicker from './ModelPicker'

type View = 'video' | 'code'

/** Ce que dit la barre pendant l'installation : une phrase par étape, jamais un nom technique. */
export function formatMontageInstall(progress: MontageInstallProgress | null): string {
  if (!progress || progress.phase === 'download') {
    return `Téléchargement de Remotion${progress?.percent != null ? ` : ${progress.percent} %` : '…'}`
  }
  if (progress.phase === 'extract') return 'Décompression de Remotion… (une à deux minutes)'
  return `Téléchargement du navigateur qui filme les vidéos${progress.percent != null ? ` : ${progress.percent} %` : '…'}`
}

/**
 * Montage (étape 189, Léo : « un bouton montage à gauche qui n'est pas installé par défaut, faut cliquer et il
 * te dit que c'est lourd, et ça fait avec Remotion »). Tant qu'il n'est pas installé, l'écran dit ce que ça
 * fait, ce que ça pèse et ce que coûte la licence, AVANT le moindre téléchargement. Ensuite : même présentation
 * que le mode Code (liste à gauche, vidéo au centre, champ en bas), dont il réutilise le bandeau d'avancement.
 */
export default function MontagePanel(): JSX.Element {
  const [status, setStatus] = useState<MontageStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installProgress, setInstallProgress] = useState<MontageInstallProgress | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [statusLines, setStatusLines] = useState<string[]>([])
  const [video, setVideo] = useState<GeneratedVideo | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [view, setView] = useState<View>('video')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [recent, setRecent] = useState<GeneratedVideoSummary[]>([])
  const [progress, setProgress] = useState<CodeGenProgress | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [lastOutcome, setLastOutcome] = useState<{ kind: 'done' | 'stopped'; durationMs: number } | null>(null)
  const stoppedRef = useRef(false)

  useEffect(() => {
    void window.jaris.getMontageStatus().then(setStatus)
    void window.jaris.getGeneratedVideos().then(setRecent)
  }, [])
  useEffect(() => window.jaris.onMontageInstallProgress(setInstallProgress), [])
  useEffect(() => window.jaris.onMontageGenStatus((message) => setStatusLines((prev) => [...prev, message])), [])
  useEffect(() => window.jaris.onMontageGenProgress(setProgress), [])

  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [generating])

  // La vidéo passe en octets par l'IPC puis devient une adresse blob: locale ; l'ancienne est libérée à
  // chaque changement pour ne pas garder plusieurs vidéos en mémoire.
  useEffect(() => {
    if (!video?.hasVideo) {
      setVideoUrl(null)
      return
    }
    let url: string | null = null
    let cancelled = false
    void window.jaris
      .readGeneratedVideo(video.path)
      .then((bytes) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }))
        setVideoUrl(url)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [video])

  /** Le bandeau de fin, le journal et l'erreur décrivent UNE fabrication : effacés dès qu'on change de vidéo (leçon de l'étape 102). */
  const clearFeedback = (): void => {
    setStatusLines([])
    setLastOutcome(null)
    setError(null)
    setSaved(false)
  }

  const install = async (): Promise<void> => {
    setError(null)
    setInstalling(true)
    setInstallProgress(null)
    try {
      await window.jaris.installMontage()
      setStatus(await window.jaris.getMontageStatus())
      void playSoundCueIfEnabled('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const uninstall = async (): Promise<void> => {
    setConfirmUninstall(false)
    setError(null)
    try {
      await window.jaris.uninstallMontage()
      setStatus(await window.jaris.getMontageStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    if (!prompt || generating) return
    clearFeedback()
    setGenerating(true)
    setProgress(null)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      const result = await window.jaris.generateMontage(prompt, video?.code)
      setVideo(result)
      setView('video')
      setDescription('')
      setLastOutcome({ kind: 'done', durationMs: Date.now() - startedAt })
      void playSoundCueIfEnabled('success')
      void window.jaris.getGeneratedVideos().then(setRecent)
    } catch (err) {
      if (stoppedRef.current) {
        setLastOutcome({ kind: 'stopped', durationMs: Date.now() - startedAt })
      } else {
        setError(err instanceof Error ? err.message : String(err))
        void playSoundCueIfEnabled('error')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  const stop = (): void => {
    stoppedRef.current = true
    window.jaris.cancelMontageGen()
  }

  const open = async (path: string): Promise<void> => {
    clearFeedback()
    try {
      setVideo(await window.jaris.loadGeneratedVideo(path))
      setView('video')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (path: string): Promise<void> => {
    setError(null)
    try {
      await window.jaris.deleteGeneratedVideo(path)
      setRecent(await window.jaris.getGeneratedVideos())
      if (video?.path === path) startOver()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async (): Promise<void> => {
    if (!video) return
    setSaved(false)
    const result = await window.jaris.saveGeneratedVideo(video.path)
    if (result.error) setError(result.error)
    else if (result.saved) setSaved(true)
  }

  const startOver = (): void => {
    setVideo(null)
    clearFeedback()
    setDescription('')
  }

  if (!status) return <div className="montage-panel montage-panel--loading" />

  if (!status.installed) {
    return (
      <div className="montage-panel montage-install">
        <div className="montage-install__card">
          <span className="montage-install__eyebrow">Module optionnel</span>
          <h2>Montage vidéo</h2>
          <p className="montage-install__lead">
            Décris une vidéo en français (titres animés, textes, graphiques, intro…) : Jaris l'écrit avec
            Remotion et la fabrique en MP4 sur ta machine.
          </p>
          <ul className="montage-install__facts">
            <li>
              <strong>C'est lourd :</strong> {MONTAGE_DOWNLOAD_LABEL} à télécharger et {MONTAGE_DISK_LABEL} sur le
              disque. Rien n'est installé tant que tu ne cliques pas.
            </li>
            <li>
              <strong>C'est lent :</strong> quelques minutes par vidéo (le modèle écrit la vidéo, puis Remotion la
              filme image par image).
            </li>
            <li>
              <strong>Pas de vraies images filmées :</strong> du texte, des formes, des couleurs et des
              graphiques animés. La qualité dépend du modèle Code de ta machine.
            </li>
            <li>
              <strong>Licence Remotion :</strong> gratuite pour toi (un particulier), mais ce n'est pas un logiciel
              libre — une entreprise de plus de 3 personnes doit payer une licence.
            </li>
          </ul>
          {!status.supported ? (
            <p className="code-panel__error">Le Montage n'est disponible que sur Windows pour l'instant.</p>
          ) : installing ? (
            <div className="options-menu__progress">
              <div className="options-menu__progress-label">{formatMontageInstall(installProgress)}</div>
              {installProgress?.percent != null && (
                <div className="options-menu__progress-bar">
                  <div className="options-menu__progress-bar-fill" style={{ width: `${installProgress.percent}%` }} />
                </div>
              )}
              <div className="options-menu__progress-sub">
                <span>Laisse Jaris ouvert pendant l'installation.</span>
              </div>
            </div>
          ) : (
            <button className="montage-install__button" onClick={() => void install()}>
              Installer le Montage
            </button>
          )}
          {error && <p className="code-panel__error">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <Workspace
      newLabel="Nouvelle vidéo"
      onNew={startOver}
      items={recent.map((item) => ({ id: item.path, title: item.label, meta: formatRecentDate(item.timestamp) }))}
      activeId={video?.path ?? null}
      onSelect={(path) => void open(path)}
      onDelete={(path) => void remove(path)}
      emptyLabel="Aucune vidéo pour l'instant."
    >
      <div className="code-panel montage-panel">
        {!video && !generating && (
          <div className="montage-panel__intro">
            <p className="code-panel__intro">
              Décris ta vidéo : ce qu'on voit, les textes exacts, les couleurs et la durée (ex : « intro de 6
              secondes, fond bleu nuit, le titre JARIS apparaît en grand puis “Ton assistant local” en dessous »).
            </p>
            {confirmUninstall ? (
              <p className="montage-panel__uninstall">
                Retirer Remotion et libérer {MONTAGE_DISK_LABEL} ? Tes vidéos restent.
                <button className="montage-panel__uninstall-yes" onClick={() => void uninstall()}>
                  Retirer
                </button>
                <button onClick={() => setConfirmUninstall(false)}>Annuler</button>
              </p>
            ) : (
              <button className="montage-panel__uninstall-link" onClick={() => setConfirmUninstall(true)}>
                Désinstaller le Montage
              </button>
            )}
          </div>
        )}

        {video && (
          <div className="code-panel__result">
            <div className="code-panel__result-bar">
              <div className="code-panel__view-tabs">
                <button
                  className={`code-panel__view-tab${view === 'video' ? ' code-panel__view-tab--active' : ''}`}
                  onClick={() => setView('video')}
                >
                  Vidéo
                </button>
                <button
                  className={`code-panel__view-tab${view === 'code' ? ' code-panel__view-tab--active' : ''}`}
                  onClick={() => setView('code')}
                >
                  Code
                </button>
              </div>
              {!generating && video.hasVideo && (
                <div className="code-panel__result-actions">
                  <button className="montage-panel__save" onClick={() => void save()} title="Enregistrer la vidéo où tu veux">
                    <DownloadIcon /> {saved ? 'Enregistrée' : 'Enregistrer'}
                  </button>
                </div>
              )}
            </div>
            {view === 'video' ? (
              video.hasVideo ? (
                videoUrl && <video className="montage-panel__video" src={videoUrl} controls autoPlay loop />
              ) : (
                <p className="code-panel__hint">La vidéo n'a pas été fabriquée : redemande-la ou modifie ta description.</p>
              )
            ) : (
              <pre className="code-panel__code">{video.code}</pre>
            )}
          </div>
        )}

        {generating && (
          <div className="code-panel__live">
            <div className="code-panel__live-text">
              <span className="code-panel__live-title">{formatCodeGenProgress(progress, elapsedMs).title}</span>
              <span className="code-panel__live-detail">{formatCodeGenProgress(progress, elapsedMs).detail}</span>
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
                : `Fabrication arrêtée après ${formatDuration(lastOutcome.durationMs)}.`}
            </span>
          </p>
        )}

        {statusLines.length > 0 && <pre className="code-panel__status">{statusLines.join('\n')}</pre>}
        {error && <p className="code-panel__error">{error}</p>}

        <Composer
          value={description}
          onChange={setDescription}
          onSubmit={() => void generate()}
          placeholder={video ? 'Que veux-tu changer ? (ex : titre plus gros, fond rouge, 10 secondes…)' : 'Décris la vidéo à créer…'}
          submitLabel={video ? 'Modifier' : 'Créer la vidéo'}
          busyLabel="Fabrication…"
          busy={generating}
          extraActions={<ModelPicker mode="code" disabled={generating} />}
          attachment={null}
          onAttachmentChange={() => {}}
          onError={setError}
          imagesAllowed={false}
          rows={3}
        />
      </div>
    </Workspace>
  )
}
