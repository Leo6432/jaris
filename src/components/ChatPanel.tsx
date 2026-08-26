import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../shared/ipc'

/**
 * Mode Chat (étape 30) : la même conversation que la voix, au clavier. Le fil vit côté main
 * (chatSession.ts) et pas ici, pour qu'il survive au changement de mode dans la colonne latérale.
 */
export default function ChatPanel(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.jaris.getChatHistory().then(setMessages)
  }, [])

  // Toujours coller au dernier message : pendant que Jaris réfléchit, l'indicateur en bas doit rester
  // visible sans avoir à faire défiler à la main.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  const send = async (): Promise<void> => {
    const prompt = input.trim()
    if (!prompt || sending) return

    setError(null)
    setInput('')
    setSending(true)
    // Affiché tout de suite, sans attendre la réponse : côté main le message est de toute façon ajouté au
    // fil dès réception, donc les deux restent cohérents.
    setMessages((prev) => [...prev, { role: 'user', content: prompt }])

    try {
      const reply = await window.jaris.sendChatMessage(prompt)
      setMessages((prev) => [...prev, reply])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Entrée envoie, Maj+Entrée passe à la ligne : convention attendue dans une fenêtre de chat.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
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
            {message.content}
          </div>
        ))}

        {sending && <div className="chat-panel__message chat-panel__message--pending">Jaris réfléchit…</div>}
      </div>

      {error && <p className="chat-panel__error">{error}</p>}

      <div className="chat-panel__composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Écris ton message… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
          rows={2}
        />
        <button onClick={() => void send()} disabled={sending || !input.trim()}>
          {sending ? '…' : 'Envoyer'}
        </button>
      </div>
    </div>
  )
}
