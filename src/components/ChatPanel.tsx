import { Fragment, useEffect, useRef, useState } from 'react'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import {
  ACCEPTED_IMAGE_TYPES,
  fileToImageAttachment,
  findImageInDataTransfer,
  type ImageAttachment
} from '@/lib/imageAttachment'
import type { ChatMessage } from '../../shared/ipc'

/**
 * Le canal "chat" du prompt système (assistant.ts) autorise le modèle à utiliser du markdown léger (listes,
 * blocs de code) et il lui arrive d'utiliser **gras** même si ce n'est pas explicitement demandé — jusqu'ici
 * affiché tel quel avec les astérisques littéraux. Seul le gras est interprété ici (le reste : listes,
 * retours à la ligne, restent du texte brut géré par `white-space: pre-wrap` en CSS) : pas la peine d'une
 * vraie dépendance markdown pour un seul cas d'usage.
 */
function renderFormattedText(content: string): JSX.Element {
  const parts = content.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\*\*([^*]+)\*\*$/.exec(part)
        return match ? <strong key={index}>{match[1]}</strong> : <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}

/**
 * Mode Chat (étape 30) : la même conversation que la voix, au clavier. Le fil vit côté main
 * (chatSession.ts) et pas ici, pour qu'il survive au changement de mode dans la colonne latérale.
 */
export default function ChatPanel(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [streamingReply, setStreamingReply] = useState('')
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.jaris.getChatHistory().then(setMessages)
  }, [])

  // computer_use_task (étape 34) peut prendre plusieurs minutes (jusqu'à 20 allers-retours capture d'écran
  // + clic) sans jamais donner signe de vie autrement — constaté en usage réel : Léo pensait Jaris bloqué
  // après plusieurs minutes à voir juste "Jaris réfléchit…" sans rien de plus. onLog (déjà diffusé côté main
  // pour chaque étape, voir computerUse.ts/assistant.ts) remplace ce texte statique par la dernière étape en
  // cours tant qu'une réponse est en vol.
  useEffect(() => {
    return window.jaris.onLog(setProgress)
  }, [])

  // Étape 48 : la réponse s'affiche au fil de sa génération plutôt que d'un bloc à la fin — un tour qui
  // appelle un outil ne "raconte" en général rien pendant qu'il tourne (voir le commentaire d'onToken,
  // ollama.ts), donc ces fragments n'arrivent en pratique que pendant le tour qui répond vraiment, juste
  // après les étapes d'outil éventuelles montrées par `progress` ci-dessus.
  useEffect(() => {
    return window.jaris.onChatStreamToken((delta) => setStreamingReply((prev) => prev + delta))
  }, [])

  // Toujours coller au dernier message : pendant que Jaris réfléchit, l'indicateur en bas doit rester
  // visible sans avoir à faire défiler à la main.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending, streamingReply])

  /**
   * Étape 91 : une image seule (sans texte) est un envoi parfaitement légitime — "regarde ça" — donc le
   * bouton ne s'active pas uniquement sur du texte, contrairement à avant. Le backend remplace alors la
   * question vide par "Décris cette image." (voir chatSession.ts).
   */
  const attachImage = async (file: File | Blob, name = ''): Promise<void> => {
    try {
      setError(null)
      setAttachment(await fileToImageAttachment(file, name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const send = async (): Promise<void> => {
    const prompt = input.trim()
    const image = attachment
    if ((!prompt && !image) || sending) return

    setError(null)
    setInput('')
    setAttachment(null)
    setSending(true)
    setProgress(null)
    setStreamingReply('')
    // Étape 31 : joué directement ici (pas via IPC main -> renderer comme les autres cues, voir App.tsx)
    // puisque l'action vient de CETTE fenêtre — inutile d'attendre un aller-retour pour un son immédiat.
    void playSoundCueIfEnabled('send')
    // Affiché tout de suite, sans attendre la réponse : côté main le message est de toute façon ajouté au
    // fil dès réception, donc les deux restent cohérents.
    setMessages((prev) => [...prev, { role: 'user', content: prompt, image: image?.dataUrl }])

    try {
      const reply = await window.jaris.sendChatMessage(prompt, image?.base64)
      setMessages((prev) => [...prev, reply])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      setProgress(null)
      setStreamingReply('')
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Entrée envoie, Maj+Entrée passe à la ligne : convention attendue dans une fenêtre de chat.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  // Coller (Ctrl+V) une capture d'écran est le geste le plus courant pour "envoyer une image" : sans ça, il
  // faudrait d'abord l'enregistrer dans un fichier juste pour pouvoir la choisir. Le glisser-déposer passe
  // par le même chemin, pour la même raison.
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
    <div className="chat-panel">
      <div className="chat-panel__thread" ref={threadRef}>
        {messages.length === 0 && !sending && (
          <p className="chat-panel__empty">
            Écris à Jaris comme tu lui parles. Il a exactement les mêmes outils qu'à la voix : ouvrir une
            application, chercher sur le web, regarder ton écran, retenir une information, envoyer un mail.
          </p>
        )}

        {messages.map((message, index) => (
          <div key={index} className={`chat-panel__message chat-panel__message--${message.role}`}>
            {message.image && (
              <img className="chat-panel__message-image" src={message.image} alt="Image envoyée à Jaris" />
            )}
            {renderFormattedText(message.content)}
          </div>
        ))}

        {sending && (
          <div className={`chat-panel__message chat-panel__message--${streamingReply ? 'assistant' : 'pending'}`}>
            {streamingReply ? renderFormattedText(streamingReply) : (progress ?? 'Jaris réfléchit…')}
          </div>
        )}
      </div>

      {error && <p className="chat-panel__error">{error}</p>}

      {attachment && (
        <div className="chat-panel__attachment">
          <img src={attachment.dataUrl} alt="Aperçu de l'image à envoyer" />
          <span className="chat-panel__attachment-name">{attachment.name || 'Image collée'}</span>
          <button className="chat-panel__attachment-remove" onClick={() => setAttachment(null)} disabled={sending}>
            Retirer
          </button>
        </div>
      )}

      <div className="chat-panel__composer" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Écris ton message… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne, Ctrl+V pour coller une image)"
          rows={2}
        />
        {/* Un input file caché plutôt qu'un dialogue natif via IPC : le renderer a déjà tout ce qu'il faut
            pour lire et réduire l'image (canvas), et un aller-retour vers le main process n'apporterait rien. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void attachImage(file, file.name)
            // Remis à zéro pour que rechoisir LE MÊME fichier juste après déclenche bien un nouvel onChange.
            event.target.value = ''
          }}
        />
        <button className="chat-panel__attach" onClick={() => fileInputRef.current?.click()} disabled={sending}>
          Image
        </button>
        <button onClick={() => void send()} disabled={sending || (!input.trim() && !attachment)}>
          {sending ? '…' : 'Envoyer'}
        </button>
      </div>
    </div>
  )
}
