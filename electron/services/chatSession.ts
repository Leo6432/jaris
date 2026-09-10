import { randomUUID } from 'crypto'
import { converse } from './assistant'
import { appendConversationEntry, getConversationHistory } from './conversationStore'
import { clearSessionHistory, getSessionHistory, pushSessionExchange } from './conversationSession'
import { extractMemoryFromExchange } from './memoryExtractor'
import { getLiveGpuStatus } from './hardwareScan'
import { getProfile } from './profileStore'
import { checkGpuTempSafety } from './resourceMonitor'
import type { ChatMessage, SoundCue } from '../../shared/ipc'

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
   * Amorcé depuis conversation-history.json (voix ET chat, voir étape 47) au premier appel seulement :
   * repéré par Léo en usage réel ("si on relance jarvis, on a plus rien dans le chat") — avant ça, `visible`
   * repartait vide à chaque lancement même si le modèle, lui, se souvenait déjà des derniers échanges
   * (`conversationSession.ts` chargeait bien son propre historique court terme). Jaris n'a qu'UNE seule
   * conversation continue (voix + chat unifiées), pas plusieurs fils nommés façon Claude/ChatGPT : rouvrir
   * l'onglet Chat après un redémarrage montre donc la suite de CETTE conversation, y compris ce qui a été
   * dit à voix haute entre-temps.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const pastEntries = await getConversationHistory(MAX_VISIBLE_MESSAGES / 2)
    this.visible = pastEntries.flatMap((entry): ChatMessage[] => [
      { role: 'user', content: entry.transcript },
      { role: 'assistant', content: entry.reply }
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

  async send(
    prompt: string,
    onReminderFire: (message: string) => void,
    onLog: (message: string) => void,
    // Étape 31 : contrairement à la Voix (qui tire ses cues ambiants de ses propres transitions
    // d'émotion, voir voicePipeline.ts), le Chat n'a pas d'état "émotion" — il émet lui-même ses cues
    // ambiants (réflexion/succès/échec) autour de converse(), et lui transmet le même callback pour ses
    // cues d'outil (clic/scan, voir TOOL_SOUND_CUES dans assistant.ts) : un seul callback pour les deux.
    onSoundCue?: (cue: SoundCue) => void,
    onToken?: (delta: string) => void
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
    try {
      const profile = await getProfile()
      // Étape 47 : session partagée avec le pipeline vocal (conversationSession.ts), relue à chaque envoi —
      // un échange dit à voix haute juste avant est donc déjà visible ici.
      const history = await getSessionHistory()
      reply = await converse(
        prompt,
        profile?.name ?? null,
        onReminderFire,
        onLog,
        history,
        undefined,
        live,
        'chat',
        onToken,
        onSoundCue
      )
      if (gpuStatus.action === 'warn') reply = `${gpuStatus.message}\n\n${reply}`
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      onLog(`Erreur Ollama (chat) : ${detail}`)
      onSoundCue?.('error')
      // Le détail (déjà clair et actionnable, voir ollama.ts : "Impossible de joindre Ollama...",
      // "Ollama a répondu 500 : ...") est ajouté au lieu d'être perdu derrière un message générique — même
      // logique que pour un outil qui échoue (voir assistant.ts) : ne jamais cacher la vraie cause.
      return this.pushVisible({
        role: 'assistant',
        content: `Je n'arrive pas à réfléchir pour le moment : ${detail}`
      })
    }

    onSoundCue?.('success')
    pushSessionExchange(prompt, reply)

    // Exactement comme à la voix : la mémoire longue durée s'enrichit toute seule, et l'échange rejoint
    // l'historique commun (onglet Historique du menu Options, et amorçage du contexte au prochain lancement).
    void extractMemoryFromExchange(prompt, reply, onLog)
    await appendConversationEntry({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      transcript: prompt,
      reply
    })

    return this.pushVisible({ role: 'assistant', content: reply })
  }

  private pushVisible(message: ChatMessage): ChatMessage {
    this.visible = [...this.visible, message].slice(-MAX_VISIBLE_MESSAGES)
    return message
  }
}

export const chatSession = new ChatSession()
