import { useEffect, useRef, useState } from 'react'
import { useReportActivity } from '@/lib/useReportActivity'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import logo from '@/assets/jaris-logo-64.png'
import Workspace from '@/components/Workspace'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { renderFormattedText } from '@/lib/formatReply'
import { formatChatProgress } from '@/lib/formatChatProgress'
import { ELAPSED_HINT_MS, formatDuration } from '@/lib/formatCodeGenProgress'
import { useElapsedMs } from '@/lib/useElapsedMs'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { ChatMessage, ConversationList, WebActivity } from '../../shared/ipc'
import ModelEffortPicker from './ModelEffortPicker'
import WebActivityBlock from './WebActivityBlock'
import { mergeWebActivity } from '@/lib/webActivity'
import { DownloadIcon } from './icons'
import { t } from '@/lib/i18n'

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
  /**
   * Étape 346 : une réponse est en cours pour une question posée AILLEURS (petit widget, téléphone) dans la même
   * conversation. Sans ça, le Chat ouvert pendant la réflexion montrait la question seule, sans « réfléchit », et la
   * réponse n'apparaissait qu'au prochain changement de fenêtre.
   */
  const [externalBusy, setExternalBusy] = useState(false)
  const ownSendRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [streamingReply, setStreamingReply] = useState('')
  // Étape 273 : recherches web et pages lues pendant la réponse en cours (bloc dépliable, comme Claude).
  const [liveWeb, setLiveWeb] = useState<WebActivity[]>([])
  // Étape 392 : l'orbe de Jaris (barre d'icônes) devient orange pendant la réflexion, verte pendant la réponse.
  useReportActivity('chat', sending || externalBusy ? (streamingReply ? 'happy' : 'thinking') : null)
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  /** Conversations (étape 96) : la liste complète et laquelle est active — affichées par Workspace. */
  const [conversations, setConversations] = useState<ConversationList | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  /**
   * Étape 328 : conversation où la question en cours a été posée, et conversation affichée. Une réponse arrivée après
   * un changement de fil s'enregistre dans la sienne (côté main) : ici, elle ne doit ni s'écrire en direct ni
   * s'ajouter dans le fil qu'on regarde maintenant.
   */
  const sendingIn = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = conversations?.activeId ?? null
  const answerIsHere = (): boolean => sendingIn.current === null || sendingIn.current === activeIdRef.current
  /** Étape 185 : image tout juste enregistrée (index du message), le temps d'afficher ✓. */
  const [savedIndex, setSavedIndex] = useState<number | null>(null)
  /**
   * Étape 325 : « Jaris réfléchit… » sans durée paraissait figé pendant qu'un modèle se charge ou réfléchit 1 à 2 min
   * (mesuré : granite4.2:8b, 2 min 06, étape 245). Le temps écoulé s'affiche à côté, après une dizaine de secondes.
   */
  const elapsedMs = useElapsedMs(sending || externalBusy)

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
      // Pendant une réponse demandée d'ici, le fil affiché est tenu à jour par send() (avec la vignette de l'image
      // jointe, que le fil du main n'a pas) : une relecture le remplacerait.
      if (document.visibilityState !== 'visible' || ownSendRef.current) return
      void window.jaris.getChatHistory().then(setMessages)
      void window.jaris.listConversations().then(setConversations)
    }
    document.addEventListener('visibilitychange', refresh)
    // Étape 214 : un message envoyé depuis le téléphone rejoint la conversation active pendant que le Chat
    // est peut-être affiché : il doit apparaître tout de suite, pas au prochain changement de fenêtre.
    const unsubscribe = window.jaris.onChatHistoryChanged?.(refresh)
    const followBusy = (busy: boolean): void => {
      if (ownSendRef.current) return
      setExternalBusy(busy)
      // L'étape affichée (« Recherche sur internet… ») était celle de cette réponse : elle ne doit pas rester.
      if (!busy) setProgress(null)
    }
    void window.jaris.getChatBusy?.().then(followBusy)
    const unsubscribeBusy = window.jaris.onChatBusy?.(followBusy)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      unsubscribe?.()
      unsubscribeBusy?.()
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
      const list = await result
      activeIdRef.current = list.activeId
      setConversations(list)
      // Réponse en cours dans un autre fil : ce qui s'écrivait en direct n'appartient pas à celui-ci.
      setStreamingReply('')
      setLiveWeb([])
      setProgress(null)
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
    return window.jaris.onChatStreamToken((delta) => {
      if (answerIsHere()) setStreamingReply((prev) => prev + delta)
    })
  }, [])
  useEffect(() => {
    return window.jaris.onChatWebActivity((activity) => {
      if (!answerIsHere()) return
      setLiveWeb((prev) => mergeWebActivity(prev, activity))
      // Étape 274 : recherche terminée — « Recherche sur internet… » n'est plus vrai, Jaris lit les résultats.
      if (!activity.pending) setProgress(null)
    })
  }, [])

  // Toujours coller au dernier message : pendant que Jaris réfléchit, l'indicateur en bas doit rester
  // visible sans avoir à faire défiler à la main. Une recherche web qui commence ou se termine aussi (étape 274).
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending, streamingReply, liveWeb])

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
    ownSendRef.current = true
    setExternalBusy(false)
    setSending(true)
    setProgress(null)
    setStreamingReply('')
    setLiveWeb([])
    // Étape 31 : joué directement ici (pas via IPC main -> renderer comme les autres cues, voir App.tsx)
    // puisque l'action vient de CETTE fenêtre — inutile d'attendre un aller-retour pour un son immédiat.
    void playSoundCueIfEnabled('send')
    // Affiché tout de suite, sans attendre la réponse : côté main le message est de toute façon ajouté au
    // fil dès réception, donc les deux restent cohérents.
    setMessages((prev) => [...prev, { role: 'user', content: prompt, image: image?.dataUrl }])
    sendingIn.current = activeIdRef.current

    try {
      const reply = await window.jaris.sendChatMessage(prompt, image?.base64)
      if (answerIsHere()) setMessages((prev) => [...prev, reply])
      // Le titre d'une conversation est dérivé de son PREMIER message (conversationStore.ts) : sans cette
      // relecture, la liste afficherait encore "Nouvelle conversation" après le tout premier échange.
      setConversations(await window.jaris.listConversations())
    } catch (err) {
      if (answerIsHere()) setError(err instanceof Error ? err.message : String(err))
    } finally {
      ownSendRef.current = false
      sendingIn.current = null
      setSending(false)
      setProgress(null)
      setStreamingReply('')
      setLiveWeb([])
    }
  }

  return (
    <Workspace
      newLabel={t('chat.new')}
      label={t('app.mode.chat')}
      onNew={() => void applyConversationChange(window.jaris.createConversation())}
      items={(conversations?.conversations ?? []).map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        meta: formatRecentDate(Date.parse(conversation.updatedAt))
      }))}
      activeId={conversations?.activeId ?? null}
      onSelect={(id) => void applyConversationChange(window.jaris.selectConversation(id))}
      onDelete={(id) => void applyConversationChange(window.jaris.deleteConversation(id))}
      emptyLabel={t('code.listEmpty')}
    >
      <div className="chat-panel">
        <div className="chat-panel__thread" ref={threadRef}>
          {messages.length === 0 && !(sending && answerIsHere()) && !externalBusy && (
            <EmptyState
              title={t('app.voice.prompt')}
              description={t('chat.empty.hint')}
              suggestions={[t('chat.suggest.1'), t('chat.suggest.2'), t('chat.suggest.3')]}
              onSuggestion={(text) => void send(text)}
            />
          )}

          {messages.map((message, index) => (
            <div key={index} className={`chat-panel__message chat-panel__message--${message.role}`}>
              {message.role === 'assistant' && <img className="chat-panel__avatar" src={logo} alt="" />}
              <div className="chat-panel__body">
              {message.web && <WebActivityBlock items={message.web} />}
              {message.image && message.role === 'user' && (
                <img className="chat-panel__message-image" src={message.image} alt={t('chat.image.sent')} />
              )}
              {renderFormattedText(message.content)}
              {/* Étape 272 : réponse coupée par « Arrêter » — dit discrètement, pour qu'une phrase tronquée ne
                  passe pas pour une réponse complète. */}
              {message.stopped && message.content !== t('chat.stopped') && <p className="chat-panel__stopped">{t('chat.stopped')}</p>}
              {/* Étape 173 : image dessinée par Jaris, sous sa réponse et en grand. */}
              {message.image && message.role === 'assistant' && (
                <figure className="chat-panel__generated">
                  <img
                    className="chat-panel__message-image chat-panel__message-image--generated"
                    src={message.image}
                    alt={t('chat.image.drawn')}
                  />
                  {/* Étape 185 : Windows demande où l'enregistrer (fenêtre « Enregistrer sous », côté main). */}
                  <button
                    type="button"
                    className="chat-panel__save-image"
                    title={savedIndex === index ? t('chat.image.saved') : t('chat.image.download')}
                    aria-label={savedIndex === index ? t('chat.image.saved') : t('chat.image.download')}
                    onClick={() => void saveImage(message.image as string, index)}
                  >
                    {savedIndex === index ? '✓' : <DownloadIcon />}
                  </button>
                </figure>
              )}
              </div>
            </div>
          ))}

          {((sending && answerIsHere()) || (externalBusy && !sending)) && (
            <div className={`chat-panel__message chat-panel__message--${streamingReply ? 'assistant' : 'pending'}`}>
              <img className="chat-panel__avatar" src={logo} alt="" />
              <div className="chat-panel__body">
                {/* Étape 274 (Léo : « il est mal fait », capture du bloc collé à côté de « Recherche sur internet… ») :
                    le bloc au-dessus, l'indicateur en dessous ; et pas d'indicateur pendant qu'une recherche est en
                    cours, le bloc dit déjà ce qui est cherché. */}
                <WebActivityBlock items={liveWeb} />
                {streamingReply ? (
                  renderFormattedText(streamingReply)
                ) : (
                  !liveWeb[liveWeb.length - 1]?.pending && (
                    <div className="chat-panel__thinking">
                      <span className="chat-panel__typing" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="chat-panel__progress">
                        {progress ?? t('app.status.thinking')}
                        {/* Étape 325 : à côté de l'étape en cours (recherche, lecture d'une page…), jamais à sa place. */}
                        {elapsedMs >= ELAPSED_HINT_MS && <span className="chat-panel__elapsed"> · {formatDuration(elapsedMs)}</span>}
                      </span>
                    </div>
                  )
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
          placeholder={t('chat.placeholder')}
          submitLabel={t('common.send')}
          busyLabel={t('chat.sending')}
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
