import { useEffect, useRef, useState } from 'react'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import logo from '@/assets/jaris-logo-64.png'
import Workspace from '@/components/Workspace'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { renderFormattedText } from '@/lib/formatReply'
import { formatChatProgress } from '@/lib/formatChatProgress'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { ChatMessage, ConversationList } from '../../shared/ipc'
import ModelEffortPicker from './ModelEffortPicker'
import { DownloadIcon } from './icons'

/**
 * Mode Chat (étape 30) : la même conversation que la voix, au clavier. Le fil vit côté main
 * (chatSession.ts) et pas ici, pour qu'il survive au changement de mode dans la colonne latérale.
 *
 * Étape 97 : la liste des conversations est rendue par `Workspace`, le composant partagé avec le mode Code
 * (colonne de gauche façon Claude/ChatGPT) — elle était jusque-là un menu déroulant propre à cet écran.
 */
export default function ChatPanel(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [streamingReply, setStreamingReply] = useState('')
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  /** Conversations (étape 96) : la liste complète et laquelle est active — affichées par Workspace. */
  const [conversations, setConversations] = useState<ConversationList | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  /** Étape 185 : image tout juste enregistrée (index du message), le temps d'afficher ✓. */
  const [savedIndex, setSavedIndex] = useState<number | null>(null)

  const saveImage = async (dataUrl: string, index: number): Promise<void> => {
    const result = await window.jaris.saveGeneratedImage(dataUrl)
    if (result.error) setError(result.error)
    if (!result.saved) return
    setSavedIndex(index)
    setTimeout(() => setSavedIndex((current) => (current === index ? null : current)), 2000)
  }

  useEffect(() => {
    void window.jaris.getChatHistory().then(setMessages)
    void window.jaris.listConversations().then(setConversations)
  }, [])

  /**
   * Une question posée depuis le widget texte (ChatWidget.tsx, au repli du mode Chat) part dans la MÊME
   * conversation, mais dans une autre fenêtre : cette fenêtre-ci n'est jamais détruite (juste cachée), donc
   * sans relecture son fil resterait figé sur ce qu'il affichait avant le repli, et l'échange fait depuis le
   * widget n'apparaîtrait jamais. Même famille de piège que les deux historiques court terme voix/chat
   * désynchronisés : deux vues de la même donnée doivent la relire, pas la deviner.
   */
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState !== 'visible') return
      void window.jaris.getChatHistory().then(setMessages)
      void window.jaris.listConversations().then(setConversations)
    }
    document.addEventListener('visibilitychange', refresh)
    // Étape 214 : un message envoyé depuis le téléphone rejoint la conversation active pendant que le Chat
    // est peut-être affiché : il doit apparaître tout de suite, pas au prochain changement de fenêtre.
    const unsubscribe = window.jaris.onChatHistoryChanged?.(refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      unsubscribe?.()
    }
  }, [])

  /**
   * Toute action sur les conversations (créer, changer, supprimer) renvoie la liste à jour ET remet le fil
   * à zéro côté main : le fil affiché est donc relu derrière, jamais deviné ici. Sans cette relecture, le
   * nouveau fil s'ouvrirait avec les messages de l'ancien encore à l'écran.
   */
  const applyConversationChange = async (result: Promise<ConversationList>): Promise<void> => {
    setError(null)
    try {
      setConversations(await result)
      setMessages(await window.jaris.getChatHistory())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // computer_use_task (étape 34) peut prendre plusieurs minutes (jusqu'à 20 allers-retours capture d'écran
  // + clic) sans jamais donner signe de vie autrement — constaté en usage réel : Léo pensait Jaris bloqué
  // après plusieurs minutes à voir juste "Jaris réfléchit…" sans rien de plus. onLog (déjà diffusé côté main
  // pour chaque étape, voir computerUse.ts/assistant.ts) remplace ce texte statique par la dernière étape en
  // cours tant qu'une réponse est en vol.
  useEffect(() => {
    return window.jaris.onLog((message) => {
      const visible = formatChatProgress(message)
      if (visible) setProgress(visible)
    })
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

  /** `text` : une suggestion de l'écran vide, envoyée telle quelle sans passer par le champ. */
  const send = async (text?: string): Promise<void> => {
    const prompt = (text ?? input).trim()
    const image = text === undefined ? attachment : null
    if ((!prompt && !image) || sending) return

    setError(null)
    if (text === undefined) {
      setInput('')
      setAttachment(null)
    }
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
      // Le titre d'une conversation est dérivé de son PREMIER message (conversationStore.ts) : sans cette
      // relecture, la liste afficherait encore "Nouvelle conversation" après le tout premier échange.
      setConversations(await window.jaris.listConversations())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      setProgress(null)
      setStreamingReply('')
    }
  }

  return (
    <Workspace
      newLabel="Nouvelle conversation"
      label="Chat"
      onNew={() => void applyConversationChange(window.jaris.createConversation())}
      items={(conversations?.conversations ?? []).map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        meta: formatRecentDate(Date.parse(conversation.updatedAt))
      }))}
      activeId={conversations?.activeId ?? null}
      onSelect={(id) => void applyConversationChange(window.jaris.selectConversation(id))}
      onDelete={(id) => void applyConversationChange(window.jaris.deleteConversation(id))}
      emptyLabel="Aucune conversation pour l'instant."
    >
      <div className="chat-panel">
        <div className="chat-panel__thread" ref={threadRef}>
          {messages.length === 0 && !sending && (
            <EmptyState
              title="Que puis-je faire pour toi ?"
              description="Écris à Jaris comme tu lui parles. Il a les mêmes outils qu'à la voix : ouvrir une application, chercher sur le web, regarder ton écran, retenir une information, envoyer un mail, dessiner une image."
              suggestions={['Résume mes mails non lus', 'Quel temps demain à Lyon ?', 'Ouvre Spotify et mets du jazz']}
              onSuggestion={(text) => void send(text)}
            />
          )}

          {messages.map((message, index) => (
            <div key={index} className={`chat-panel__message chat-panel__message--${message.role}`}>
              {message.role === 'assistant' && <img className="chat-panel__avatar" src={logo} alt="" />}
              <div className="chat-panel__body">
              {message.image && message.role === 'user' && (
                <img className="chat-panel__message-image" src={message.image} alt="Image envoyée à Jaris" />
              )}
              {renderFormattedText(message.content)}
              {/* Étape 272 : réponse coupée par « Arrêter » — dit discrètement, pour qu'une phrase tronquée ne
                  passe pas pour une réponse complète. */}
              {message.stopped && message.content !== 'Réponse arrêtée.' && <p className="chat-panel__stopped">Réponse arrêtée.</p>}
              {/* Étape 173 : image dessinée par Jaris, sous sa réponse et en grand. */}
              {message.image && message.role === 'assistant' && (
                <figure className="chat-panel__generated">
                  <img
                    className="chat-panel__message-image chat-panel__message-image--generated"
                    src={message.image}
                    alt="Image dessinée par Jaris"
                  />
                  {/* Étape 185 : Windows demande où l'enregistrer (fenêtre « Enregistrer sous », côté main). */}
                  <button
                    type="button"
                    className="chat-panel__save-image"
                    title={savedIndex === index ? 'Image enregistrée' : "Télécharger l'image"}
                    aria-label={savedIndex === index ? 'Image enregistrée' : "Télécharger l'image"}
                    onClick={() => void saveImage(message.image as string, index)}
                  >
                    {savedIndex === index ? '✓' : <DownloadIcon />}
                  </button>
                </figure>
              )}
              </div>
            </div>
          ))}

          {sending && (
            <div className={`chat-panel__message chat-panel__message--${streamingReply ? 'assistant' : 'pending'}`}>
              <img className="chat-panel__avatar" src={logo} alt="" />
              <div className="chat-panel__body">
                {streamingReply ? (
                  renderFormattedText(streamingReply)
                ) : (
                  <>
                    <span className="chat-panel__typing" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="chat-panel__progress">{progress ?? 'Jaris réfléchit…'}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {error && <p className="chat-panel__error">{error}</p>}

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          placeholder="Écris à Jaris…"
          submitLabel="Envoyer"
          busyLabel="Envoi…"
          busy={sending}
          onStop={() => window.jaris.cancelChat()}
          extraActions={<ModelEffortPicker mode="chat" disabled={sending} />}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          onError={setError}
          submitOnEnter
        />
      </div>
    </Workspace>
  )
}
