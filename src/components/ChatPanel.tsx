import { Fragment, useEffect, useRef, useState } from 'react'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
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
  const threadRef = useRef<HTMLDivElement>(null)

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

  const send = async (): Promise<void> => {
    const prompt = input.trim()
    if (!prompt || sending) return

    setError(null)
    setInput('')
    setSending(true)
    setProgress(null)
    setStreamingReply('')
    // Étape 31 : joué directement ici (pas via IPC main -> renderer comme les autres cues, voir App.tsx)
    // puisque l'action vient de CETTE fenêtre — inutile d'attendre un aller-retour pour un son immédiat.
    void playSoundCueIfEnabled('send')
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
