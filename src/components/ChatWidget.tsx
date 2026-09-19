import { useEffect, useRef, useState } from 'react'
import { renderFormattedText } from '@/lib/formatReply'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'

// Délai de disparition automatique de la réponse, volontairement confortable pour la lecture
// (300ms par mot) — voir computeReplyDismissDelayMs et l'effet plus bas. Une réponse courte reste au
// moins 5 secondes. À la demande de Léo, aucune limite haute ne coupe une réponse longue avant que son
// temps de lecture calculé soit écoulé.
const REPLY_DISMISS_MS_PER_WORD = 300
const MIN_REPLY_DISMISS_MS = 5000

/** Exportée pour être testée directement (le vrai délai, plusieurs secondes à minutes, est trop lent à
 * attendre dans un test — voir scripts/test-chat-widget-ui.mjs, qui vérifie séparément que l'effet s'en
 * sert vraiment via de vraies attentes bornées sur le plancher de 4s, l'horloge simulée de Playwright
 * s'étant révélée instable dans cet environnement). */
export function computeReplyDismissDelayMs(reply: string): number {
  const words = reply.trim().split(/\s+/).filter(Boolean).length
  return Math.max(MIN_REPLY_DISMISS_MS, words * REPLY_DISMISS_MS_PER_WORD)
}

/**
 * Le widget quand on quitte Jaris depuis le mode Chat : une barre de texte au même endroit que le cercle
 * vocal (en haut au centre, même pilule HUD), pour poser une question écrite sans rouvrir l'application.
 *
 * Demande de Léo : "quand on se met dans chat, et on part ... ça met une barre de texte en haut au centre
 * comme le widget vocal, et on peut lui demander une question sans aller directement sur l'application" —
 * puis, en précisant : "comme pour le vocal en inactif, sauf qu'à la place d'avoir un cercle, et qui
 * écoute, ... une barre de texte pour le chat", et la réponse "comme pour le widget vocal mais à la place
 * une barre".
 *
 * La question part par le MÊME chemin que le mode Chat (`sendChatMessage`), donc elle atterrit dans la même
 * conversation : ce qui est demandé ici se retrouve dans le fil en rouvrant Jaris, et la voix continue le
 * même fil. Rien de dupliqué côté main — le widget n'est qu'une deuxième porte d'entrée sur le Chat.
 */
export default function ChatWidget({ inactive = false }: { inactive?: boolean }): JSX.Element {
  const [input, setInput] = useState('')
  const [question, setQuestion] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const expanded = question !== null

  /**
   * La fenêtre native ne peut pas deviner qu'une question vient de partir : rien ne passe par le main quand
   * on tape dans la barre (contrairement au widget vocal, que `pipeline.on('emotion')` redimensionne tout
   * seul). C'est donc ce renderer qui lui donne sa hauteur — MESURÉE sur ce qu'il dessine vraiment, pour
   * que la fenêtre et son contenu viennent d'une seule source.
   *
   * Mesurée plutôt que fixe parce qu'une fois dépliée, cette fenêtre capte les clics sur toute sa surface
   * et reste ouverte tant qu'on ne l'a pas fermée : une hauteur taillée pour la réponse la plus longue
   * laisserait, sur une réponse courte, des centaines de pixels invisibles qui avalent les clics en haut de
   * l'écran. Le widget vocal peut s'en passer, lui se replie tout seul.
   *
   * Le nœud observé est la RACINE (barre + réponse), pas seulement la réponse : c'est la hauteur totale du
   * contenu que la fenêtre doit contenir. Il existe à chaque rendu, donc un `ref` classique suffit ici —
   * pas le cas de figure qui impose une callback ref (un nœud rendu conditionnellement).
   */
  useEffect(() => {
    const node = rootRef.current
    if (!node || inactive || !expanded) {
      window.jaris.setChatWidgetHeight(null)
      return
    }
    const report = (): void => {
      // Le BAS du contenu (et non sa seule hauteur) plus le padding du bas : le conteneur ajoute un peu de
      // marge autour (voir `.app--widget-chat`), et prendre `bottom` plutôt que `height` compte aussi ce qui
      // sépare le contenu du haut de la fenêtre sans avoir à supposer que les deux marges sont égales.
      // `document.documentElement.scrollHeight`, essayé d'abord, ne marche PAS ici : il renvoie le maximum
      // entre le contenu et la fenêtre, donc la hauteur actuelle de la fenêtre dès que le contenu est plus
      // court — exactement ce qu'on cherche à recalculer (mesuré : 400 renvoyé pour 169 de contenu réel).
      const parent = node.parentElement
      const paddingBottom = parent ? parseFloat(getComputedStyle(parent).paddingBottom) : 0
      window.jaris.setChatWidgetHeight(Math.ceil(node.getBoundingClientRect().bottom + paddingBottom))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [expanded, inactive])

  useEffect(() => {
    if (!inactive) inputRef.current?.focus()
  }, [inactive])

  useEffect(() => {
    // Ne jamais utiliser trim() ici : un espace est déjà un caractère saisi et fait donc partie du
    // brouillon que Léo demande de protéger quand il clique ailleurs. Après l'envoi, le champ redevient
    // vide mais `expanded` reste vrai pendant la réflexion ET une fois la réponse affichée : protéger les
    // deux évite que la question disparaisse précisément pendant que Léo attend de pouvoir lire la réponse.
    window.jaris.setChatWidgetKeepOpen(input.length > 0 || expanded)
  }, [input, expanded])

  useEffect(() => {
    if (!inactive) return
    // Le prochain + doit rouvrir une simple barre, pas ressusciter l'ancienne réponse dépliée. Le texte en
    // cours de saisie est conservé comme brouillon ; seuls les éléments de réponse sont remis au repos.
    setQuestion(null)
    setReply('')
    setError(null)
    setProgress(null)
  }, [inactive])

  useEffect(() => {
    return window.jaris.onChatStreamToken((delta) => setReply((prev) => prev + delta))
  }, [])

  // Même raison que dans ChatPanel : un appel d'outil (recherche web, pilotage de l'écran...) peut prendre
  // des minutes sans le moindre fragment de réponse — sans ces étapes, la barre semblerait bloquée.
  useEffect(() => {
    return window.jaris.onLog(setProgress)
  }, [])

  const send = async (): Promise<void> => {
    const prompt = input.trim()
    if (!prompt || sending) return

    setError(null)
    setInput('')
    setQuestion(prompt)
    setReply('')
    setProgress(null)
    setSending(true)
    void playSoundCueIfEnabled('send')

    try {
      const message = await window.jaris.sendChatMessage(prompt)
      setReply(message.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      setProgress(null)
    }
  }

  /** Retour à la simple barre : la fenêtre se replie et rend l'écran à ce qu'il y avait derrière. */
  const dismiss = (): void => {
    setQuestion(null)
    setReply('')
    setError(null)
    setProgress(null)
  }

  /**
   * Léo : "quand on envoie un message dans le widget chat, ça réponse doit disparaitre après, ça doit
   * varier selon la longueur de la réponse" — la réponse se referme donc TOUTE SEULE après un délai de
   * lecture, plus long pour un texte plus long, plutôt que de rester ouverte indéfiniment.
   *
   * Ne se déclenche QUE sur une réponse reçue avec succès (`!sending`, `!error`) : un message d'erreur reste
   * affiché jusqu'à une action explicite, il n'y a rien à "laisser le temps de lire" dans un texte d'échec
   * qui appelle plutôt une action de la part de Léo. Suspendu tant que la souris survole le widget ou qu'un
   * brouillon est en cours de saisie : le but même de ce délai est de laisser le temps de lire, le couper
   * pendant que Léo est justement en train de lire ou de composer une suite serait contre-productif.
   */
  useEffect(() => {
    if (inactive || sending || error || !reply || hovering || input.length > 0) return
    const timer = setTimeout(() => {
      dismiss()
      // Le repli doit arriver APRÈS le délai de lecture, jamais dès la fin de génération. Relâcher d'abord
      // la protection est indispensable : `expanded` est encore vrai dans ce rendu et le main refuserait
      // sinon de remettre la fenêtre en mode inactif.
      window.jaris.setChatWidgetKeepOpen(false)
      window.jaris.collapseChatWidget()
    }, computeReplyDismissDelayMs(reply))
    return () => clearTimeout(timer)
  }, [inactive, sending, error, reply, hovering, input])

  if (inactive) {
    return (
      <button
        className="chat-widget__idle"
        type="button"
        title="Jaris Chat — appuie sur + pour écrire"
        aria-label="Jaris Chat inactif"
        onClick={() => window.jaris.openSettings()}
      >
        <ChatIcon />
      </button>
    )
  }

  return (
    <div
      className={`chat-widget${expanded ? ' chat-widget--expanded' : ''}`}
      ref={rootRef}
      onMouseEnter={() => {
        setHovering(true)
        window.jaris.armChatWidgetPointer()
      }}
      onMouseLeave={() => {
        setHovering(false)
        window.jaris.collapseChatWidget()
      }}
    >
      {!expanded && (
        <form
          className="chat-widget__bar"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <input
            ref={inputRef}
            className="chat-widget__input"
            type="text"
            value={input}
            placeholder="Pose ta question à Jaris…"
            aria-label="Pose ta question à Jaris"
            disabled={sending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Échap referme la réponse sans avoir à viser un bouton — le geste attendu pour une fenêtre
              // qui flotte par-dessus tout le reste.
              if (event.key === 'Escape') dismiss()
            }}
          />
          <button className="chat-widget__send" type="submit" disabled={sending || !input.trim()} title="Envoyer">
            <SendIcon />
          </button>
        </form>
      )}

      {expanded && (
        <div className="chat-widget__answer">
          <p className="chat-widget__question">« {question} »</p>
          {error ? (
            <p className="chat-widget__error">{error}</p>
          ) : (
            <div className="chat-widget__reply">
              {reply ? renderFormattedText(reply) : (progress ?? 'Jaris réfléchit…')}
            </div>
          )}
          <div className="chat-widget__actions">
            <button className="chat-widget__action" onClick={() => window.jaris.openSettings()}>
              Ouvrir le Chat
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
      <path d="M5 5.5h14v9H10l-4 3v-3H5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 9h7M8.5 12h4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** Même famille que l'icône de pièce jointe du composeur : un SVG inline qui hérite de `currentColor`. */
function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M4 12h13M12 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
