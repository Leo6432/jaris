import { useEffect, useRef, useState } from 'react'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import Composer from '@/components/Composer'
import Workspace from '@/components/Workspace'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { renderFormattedText } from '@/lib/formatReply'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { ChatMessage, ConversationList } from '../../shared/ipc'

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
    return () => document.removeEventListener('visibilitychange', refresh)
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

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          placeholder="Écris ton message…"
          submitLabel="Envoyer"
          busyLabel="Envoi…"
          busy={sending}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          onError={setError}
          submitOnEnter
          hint="Entrée pour envoyer · Maj+Entrée : nouvelle ligne · Ctrl+V : coller une image"
        />
      </div>
    </Workspace>
  )
}
