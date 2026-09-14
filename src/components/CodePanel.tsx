import { useEffect, useRef, useState } from 'react'
import {
  ACCEPTED_IMAGE_TYPES,
  fileToImageAttachment,
  findImageInDataTransfer,
  type ImageAttachment
} from '@/lib/imageAttachment'
import type { GeneratedApp, GeneratedAppSummary } from '../../shared/ipc'

type View = 'preview' | 'code'

/**
 * Mode Code (étape 30) : décrire une application en français et la voir tourner, générée à 100% en local.
 * Une fois une première version obtenue, les demandes suivantes sont traitées comme des modifications du
 * fichier en cours (contexte ciblé : seul ce fichier est renvoyé au modèle, pas tout l'historique).
 */
export default function CodePanel(): JSX.Element {
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [statusLines, setStatusLines] = useState<string[]>([])
  const [appResult, setAppResult] = useState<GeneratedApp | null>(null)
  const [view, setView] = useState<View>('preview')
  const [error, setError] = useState<string | null>(null)
  const [recentApps, setRecentApps] = useState<GeneratedAppSummary[]>([])
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  const statusRef = useRef<HTMLPreElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Repéré par Léo en usage réel ("si on relance jarvis, on a plus rien dans le code") : chaque génération
  // est bien enregistrée sur le disque (generated-apps/<horodatage>-<slug>/), mais rien ne remontrait cette
  // liste après un redémarrage — l'écran de départ repartait toujours à zéro même si le fichier existait
  // toujours. Chargée une fois au montage ; regénérée après chaque génération réussie (voir refreshRecentApps).
  useEffect(() => {
    void window.jaris.getGeneratedApps().then(setRecentApps)
  }, [])

  useEffect(() => {
    return window.jaris.onCodeGenStatus((message) => setStatusLines((prev) => [...prev, message]))
  }, [])

  useEffect(() => {
    statusRef.current?.scrollTo({ top: statusRef.current.scrollHeight })
  }, [statusLines])

  /**
   * Étape 91 : une maquette ou une capture d'écran vaut mieux qu'un long paragraphe pour décrire une
   * interface. L'image est lue par le modèle de VISION puis transmise au modèle de code sous forme de texte
   * (voir generateApp) : les deux ne tiennent pas ensemble en VRAM.
   */
  const attachImage = async (file: File | Blob, name = ''): Promise<void> => {
    try {
      setError(null)
      setAttachment(await fileToImageAttachment(file, name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    // Une image seule suffit ("reproduis cette maquette") : le texte n'est plus obligatoire s'il y a une image.
    if ((!prompt && !attachment) || generating) return

    setError(null)
    setGenerating(true)
    setStatusLines([])
    try {
      // appResult présent = demande de modification : le fichier actuel part avec la demande.
      const result = await window.jaris.generateApp(
        prompt || 'Reproduis fidèlement l\'interface de l\'image jointe.',
        appResult?.html,
        attachment?.base64
      )
      setAppResult(result)
      setDescription('')
      setAttachment(null)
      setView('preview')
      void window.jaris.getGeneratedApps().then(setRecentApps)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const openRecent = async (path: string): Promise<void> => {
    setError(null)
    try {
      const result = await window.jaris.loadGeneratedApp(path)
      setAppResult(result)
      setView('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startOver = (): void => {
    setAppResult(null)
    setStatusLines([])
    setError(null)
    setDescription('')
    setAttachment(null)
  }

  const handlePaste = (event: React.ClipboardEvent): void => {
    const file = findImageInDataTransfer(event.clipboardData.items)
    if (!file) return
    event.preventDefault()
    void attachImage(file)
  }

  const handleDrop = (event: React.DragEvent): void => {
    const file = findImageInDataTransfer(event.dataTransfer.items)
    if (!file) return
    event.preventDefault()
    void attachImage(file, file.name)
  }

  return (
    <div className="code-panel">
      <div className="code-panel__composer" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onPaste={handlePaste}
          placeholder={
            appResult
              ? 'Que veux-tu changer ? (ex: ajoute un mode sombre, trie les tâches par date…)'
              : "Décris l'application à créer, ou joins une maquette à reproduire… (Ctrl+V pour coller une image)"
          }
          rows={3}
          disabled={generating}
        />

        {attachment && (
          <div className="code-panel__attachment">
            <img src={attachment.dataUrl} alt="Aperçu de la maquette jointe" />
            <span className="code-panel__attachment-name">{attachment.name || 'Image collée'}</span>
            <button onClick={() => setAttachment(null)} disabled={generating}>
              Retirer
            </button>
          </div>
        )}

        <div className="code-panel__actions">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void attachImage(file, file.name)
              event.target.value = ''
            }}
          />
          <button onClick={() => fileInputRef.current?.click()} disabled={generating}>
            Image
          </button>
          <button
            className="code-panel__generate"
            onClick={() => void generate()}
            disabled={generating || (!description.trim() && !attachment)}
          >
            {generating ? 'Génération…' : appResult ? 'Modifier' : "Générer l'application"}
          </button>
          {appResult && !generating && (
            <>
              <button onClick={startOver}>Nouvelle application</button>
              <button onClick={() => void window.jaris.openGeneratedApp(appResult.path)}>Ouvrir le dossier</button>
            </>
          )}
        </div>
      </div>

      {error && <p className="code-panel__error">{error}</p>}

      {!appResult && !generating && recentApps.length > 0 && (
        <div className="code-panel__recents">
          <div className="code-panel__section-title">Récents</div>
          <ul>
            {recentApps.map((recent) => (
              <li key={recent.path}>
                <button onClick={() => void openRecent(recent.path)}>
                  <span className="code-panel__recent-label">{recent.label}</span>
                  <span className="code-panel__recent-date">{new Date(recent.timestamp).toLocaleString('fr-FR')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(generating || statusLines.length > 0) && (
        <pre ref={statusRef} className="code-panel__status">
          {statusLines.join('\n')}
        </pre>
      )}

      {appResult && appResult.issues.length > 0 && (
        <div className="code-panel__issues">
          <strong>
            L'application a été générée mais {appResult.issues.length === 1 ? "un problème n'a pas pu être corrigé" : `${appResult.issues.length} problèmes n'ont pas pu être corrigés`} :
          </strong>
          <ul>
            {appResult.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          Relance la génération, ou reformule ta demande en plus simple.
        </div>
      )}

      {appResult && (
        <div className="code-panel__result">
          <div className="code-panel__view-tabs">
            <button
              className={`code-panel__view-tab${view === 'preview' ? ' code-panel__view-tab--active' : ''}`}
              onClick={() => setView('preview')}
            >
              Aperçu
            </button>
            <button
              className={`code-panel__view-tab${view === 'code' ? ' code-panel__view-tab--active' : ''}`}
              onClick={() => setView('code')}
            >
              Code
            </button>
          </div>

          {view === 'preview' ? (
            // sandbox sans allow-same-origin : le code généré par le modèle tourne dans une origine opaque,
            // sans accès à Jaris ni aux fichiers locaux. Conséquence assumée : localStorage y est bloqué
            // (d'où le try/catch imposé dans les consignes de génération), mais il refonctionne dès que le
            // fichier est ouvert normalement dans un navigateur depuis le dossier du projet.
            <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts" src={appResult.previewUrl} />
          ) : (
            <pre className="code-panel__code">{appResult.html}</pre>
          )}

          <p className="code-panel__hint">
            Enregistré dans <code>{appResult.path}</code>. L'aperçu tourne isolé, sans accès au reste de la
            machine : la sauvegarde de données (localStorage) n'y fonctionne pas, mais marche en ouvrant le
            fichier depuis le dossier.
          </p>
        </div>
      )}
    </div>
  )
}
