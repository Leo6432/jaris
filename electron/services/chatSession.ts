import { randomUUID } from 'crypto'
import { config } from '../config'
import { converse, type ConverseRestrictions } from './assistant'
import { IMAGE_CHAT_SYSTEM_PROMPT, describeImage } from './vision'
import { appendConversationEntry, getConversationHistory } from './conversationStore'
import { clearSessionHistory, getSessionHistory, pushSessionExchange } from './conversationSession'
import { extractMemoryFromExchange } from './memoryExtractor'
import { getLiveGpuStatus } from './hardwareScan'
import { getProfile } from './profileStore'
import { checkGpuTempSafety } from './resourceMonitor'
import { readGeneratedImageDataUrl, type GeneratedImage } from './imageGenerator'
import type { ChatMessage, SoundCue, WebActivity } from '../../shared/ipc'

/**
 * Nombre de messages gardés pour l'AFFICHAGE du fil de discussion, bien plus large que la fenêtre envoyée
 * au modèle (conversationSession.ts) : pouvoir remonter dans ce qui a été dit ne coûte rien, alors qu'envoyer
 * tout l'historique au modèle à chaque message coûterait du contexte (et donc de la VRAM) pour rien.
 */
const MAX_VISIBLE_MESSAGES = 200

/**
 * Mode Chat (étape 30) : exactement le même Jaris que la voix — mêmes outils, même mémoire markdown, même
 * historique de conversation — mais piloté au clavier et sans synthèse vocale. L'état vit ici (côté main)
 * plutôt que dans le renderer pour que passer d'un mode à l'autre dans la colonne latérale ne perde pas la
 * discussion en cours.
 *
 * Étape 47 : le contexte court terme envoyé au modèle (conversationSession.ts) est PARTAGÉ avec le pipeline
 * vocal — relu à chaque envoi plutôt que gardé dans une copie locale à ce fichier, contrairement à avant où
 * chat et voix chargeaient chacun leur propre copie indépendante au premier usage (donc désynchronisées dès
 * qu'on passait de l'un à l'autre en pleine conversation). Demander quelque chose à l'oral puis enchaîner
 * par écrit (ou l'inverse) continue donc vraiment la même conversation, immédiatement.
 */
class ChatSession {
  private visible: ChatMessage[] = []
  private loaded = false
  /**
   * Étape 272 (Léo : « pouvoir interrompre l'IA comme sur ChatGPT ») : les réponses du Chat en cours, que le
   * bouton « Arrêter » interrompt. Pas celles venues du téléphone (`restrictions`), qui ont leur propre écran.
   */
  private running = new Set<AbortController>()

  /** Arrête les réponses du Chat en cours ; le texte déjà écrit est gardé (voir send()). */
  cancel(): void {
    for (const controller of this.running) controller.abort()
  }

  /**
   * Amorcé depuis la conversation ACTIVE (voix ET chat, voir étape 47) au premier appel seulement : repéré
   * par Léo en usage réel ("si on relance jarvis, on a plus rien dans le chat") — avant ça, `visible`
   * repartait vide à chaque lancement même si le modèle, lui, se souvenait déjà des derniers échanges
   * (`conversationSession.ts` chargeait bien son propre historique court terme).
   *
   * Étape 96 : il y a désormais PLUSIEURS conversations (demande de Léo), et `getConversationHistory` rend
   * celle qui est active — c'est aussi celle dans laquelle le canal vocal écrit, pour que passer de la voix
   * à l'écrit continue toujours la même discussion. Changer de fil appelle `reset()` juste en dessous.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const pastEntries = await getConversationHistory(MAX_VISIBLE_MESSAGES / 2)
    const images = await Promise.all(pastEntries.map((entry) => (entry.image ? readGeneratedImageDataUrl(entry.image) : null)))
    this.visible = pastEntries.flatMap((entry, i): ChatMessage[] => [
      { role: 'user', content: entry.transcript },
      {
        role: 'assistant',
        content: entry.reply,
        ...(images[i] ? { image: images[i] as string } : {}),
        // Étape 273 : le bloc « A cherché sur le web » revient après un redémarrage.
        ...(entry.web?.length ? { web: entry.web } : {})
      }
    ])
  }

  /** Messages à afficher dans le fil, amorcés depuis le disque au premier appel (voir ensureLoaded). */
  async getVisibleMessages(): Promise<ChatMessage[]> {
    await this.ensureLoaded()
    return this.visible
  }

  /** Vidé en même temps que l'historique global, depuis le menu Options (voir clearConversationHistory). */
  clear(): void {
    clearSessionHistory()
    this.visible = []
    this.loaded = true
  }

  /**
   * Étape 96 : appelé après un changement de conversation (ou la création d'une nouvelle). Remet à zéro le
   * fil AFFICHÉ et le contexte court terme envoyé au modèle — sans ça, le nouveau fil s'ouvrirait avec les
   * messages de l'ancien à l'écran, et Jaris répondrait en tenant compte d'une discussion dont Léo vient
   * justement de sortir. Le rechargement se fait au prochain getVisibleMessages()/send() (ensureLoaded),
   * qui relit la conversation devenue active.
   */
  reset(): void {
    clearSessionHistory()
    this.visible = []
    this.loaded = false
  }

  /**
   * Image jointe (étape 91) : traitée par le modèle de VISION, pas par le modèle de conversation — ce
   * dernier ne sait pas lire une image, et les deux ne tiennent pas ensemble en VRAM sur une carte 8 Go
   * (contrainte déjà documentée dans assistant.ts pour look_at_screen). La réponse du modèle de vision est
   * donc renvoyée telle quelle, exactement comme le court-circuit look_at_screen : la reformuler avec le
   * modèle de conversation forcerait un rechargement complet de modèle pour un gain nul.
   *
   * L'échange rejoint quand même l'historique partagé sous forme de TEXTE (la question et la réponse, jamais
   * l'image) : une question de suivi ("et la couleur du bouton ?") garde donc le contexte, sans jamais faire
   * grossir conversation-history.json avec des mégaoctets d'image en base64.
   */
  private async answerAboutImage(prompt: string, imageBase64: string, onLog: (message: string) => void): Promise<string> {
    const profile = await getProfile()
    onLog("Lecture de l'image…")
    return describeImage(
      imageBase64,
      prompt || "Décris cette image.",
      profile?.visionModel ?? config.ollama.visionModel,
      IMAGE_CHAT_SYSTEM_PROMPT
    )
  }

  async send(
    prompt: string,
    onReminderFire: (message: string) => void,
    onLog: (message: string) => void,
    // Étape 31 : contrairement à la Voix (qui tire ses cues ambiants de ses propres transitions
    // d'émotion, voir voicePipeline.ts), le Chat n'a pas d'état "émotion" — il émet lui-même ses cues
    // ambiants (réflexion/succès/échec) autour de converse(), et lui transmet le même callback pour ses
    // cues d'outil (clic/scan, voir TOOL_SOUND_CUES dans assistant.ts) : un seul callback pour les deux.
    onSoundCue?: (cue: SoundCue) => void,
    onToken?: (delta: string) => void,
    imageBase64?: string,
    // Étape 214 : message venu du téléphone (voir phoneAccess.ts), dans la MÊME conversation que le Chat.
    restrictions?: ConverseRestrictions,
    // Onglet Vocal du téléphone : réponse courte, sans liste ni gras, puisqu'elle sera lue à voix haute.
    channel: 'chat' | 'voice' = 'chat',
    // Étape 273 : chaque recherche web ou page lue, dès qu'elle a lieu (bloc dépliable affiché en direct).
    onWebActivity?: (activity: WebActivity) => void
  ): Promise<ChatMessage> {
    // Sans ça, un message envoyé avant que le premier getVisibleMessages() (appelé au montage de
    // ChatPanel.tsx) ait fini de charger l'historique pourrait écraser la restauration en cours.
    await this.ensureLoaded()
    this.pushVisible({ role: 'user', content: prompt })
    onSoundCue?.('thinking')

    // Même sécurité thermique qu'à la voix : inutile de lancer une inférence sur un GPU déjà trop chaud.
    // Le relevé est réutilisé par converse() plus bas au lieu d'en relancer un second.
    const live = await getLiveGpuStatus()
    const gpuStatus = checkGpuTempSafety(live.tempC)
    if (gpuStatus.action === 'abort' || gpuStatus.action === 'shutdown') {
      onLog(`Sécurité thermique GPU : ${gpuStatus.message}`)
      onSoundCue?.('error')
      return this.pushVisible({ role: 'assistant', content: gpuStatus.message as string })
    }

    let reply: string
    // Étape 173 : image dessinée pendant ce tour (generate_image), affichée sous la réponse et gardée sur le disque.
    let generated: GeneratedImage | null = null
    const controller = new AbortController()
    if (!restrictions) this.running.add(controller)
    // Ce qui s'est déjà affiché : gardé si Léo arrête la réponse en route, comme ChatGPT.
    let streamed = ''
    const relayToken = (delta: string): void => {
      streamed += delta
      onToken?.(delta)
    }
    // Étape 273 : gardé avec la réponse (affichage et historique), et relayé en direct.
    const web: WebActivity[] = []
    const relayWeb = (activity: WebActivity): void => {
      web.push(activity)
      onWebActivity?.(activity)
    }
    try {
      const profile = await getProfile()
      // Étape 47 : session partagée avec le pipeline vocal (conversationSession.ts), relue à chaque envoi —
      // un échange dit à voix haute juste avant est donc déjà visible ici.
      const history = await getSessionHistory()
      reply = imageBase64
        ? await this.answerAboutImage(prompt, imageBase64, onLog)
        : await converse(
            prompt,
            profile?.name ?? null,
            onReminderFire,
            onLog,
            history,
            controller.signal,
            live,
            channel,
            relayToken,
            onSoundCue,
            (image) => {
              generated = image
            },
            restrictions,
            relayWeb
          )
      if (gpuStatus.action === 'warn') reply = `${gpuStatus.message}\n\n${reply}`
      // La lecture d'une image ne s'interrompt pas en route : sa réponse arrivée après « Arrêter » est écartée.
      if (controller.signal.aborted) return this.stopped(prompt, streamed, web)
    } catch (err) {
      if (controller.signal.aborted) return this.stopped(prompt, streamed, web)
      this.running.delete(controller)
      const detail = err instanceof Error ? err.message : String(err)
      onLog(`Erreur Ollama (chat) : ${detail}`)
      onSoundCue?.('error')
      // Le détail (déjà clair et actionnable, voir ollama.ts : "Impossible de joindre Ollama...",
      // "Ollama a répondu 500 : ...") est ajouté au lieu d'être perdu derrière un message générique — même
      // logique que pour un outil qui échoue (voir assistant.ts) : ne jamais cacher la vraie cause.
      return this.pushVisible({
        role: 'assistant',
        content: `Je n'arrive pas à réfléchir pour le moment : ${detail}`,
        ...(web.length ? { web } : {})
      })
    }

    this.running.delete(controller)
    onSoundCue?.('success')
    pushSessionExchange(prompt, reply)

    // Exactement comme à la voix : la mémoire longue durée s'enrichit toute seule, et l'échange rejoint
    // l'historique commun (onglet Historique du menu Options, et amorçage du contexte au prochain lancement).
    void extractMemoryFromExchange(prompt, reply, onLog)
    const image = generated as GeneratedImage | null
    await appendConversationEntry({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      transcript: prompt,
      reply,
      ...(image ? { image: image.fileName } : {}),
      ...(web.length ? { web } : {})
    })

    const imageUrl = image ? await readGeneratedImageDataUrl(image.fileName) : null
    return this.pushVisible({ role: 'assistant', content: reply, ...(imageUrl ? { image: imageUrl } : {}), ...(web.length ? { web } : {}) })
  }

  /**
   * Réponse arrêtée par Léo : ni son d'erreur ni message rouge, c'est lui qui l'a voulu. Le début déjà affiché
   * reste, et rejoint l'historique comme un échange normal (le modèle le voit au tour suivant) ; rien d'affiché,
   * l'échange n'est pas enregistré — une réponse vide ne ferait que brouiller le contexte.
   */
  private async stopped(prompt: string, streamed: string, web: WebActivity[] = []): Promise<ChatMessage> {
    for (const running of this.running) if (running.signal.aborted) this.running.delete(running)
    const partial = streamed.trim()
    if (partial) {
      pushSessionExchange(prompt, partial)
      await appendConversationEntry({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        transcript: prompt,
        reply: partial,
        ...(web.length ? { web } : {})
      })
    }
    return this.pushVisible({ role: 'assistant', content: partial || 'Réponse arrêtée.', stopped: true, ...(web.length ? { web } : {}) })
  }

  private pushVisible(message: ChatMessage): ChatMessage {
    this.visible = [...this.visible, message].slice(-MAX_VISIBLE_MESSAGES)
    return message
  }
}

export const chatSession = new ChatSession()
