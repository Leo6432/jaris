import { randomUUID } from 'crypto'
import { converse } from './assistant'
import { appendConversationEntry, getConversationHistory } from './conversationStore'
import { extractMemoryFromExchange } from './memoryExtractor'
import { getLiveGpuStatus } from './hardwareScan'
import { getProfile } from './profileStore'
import { checkGpuTempSafety } from './resourceMonitor'
import type { OllamaMessage } from './ollama'
import type { ChatMessage } from '../../shared/ipc'

/** Même fenêtre glissante que le pipeline vocal : le contexte ancien sort tout seul au fil des échanges. */
const MAX_HISTORY_MESSAGES = 12

/**
 * Nombre de messages gardés pour l'AFFICHAGE du fil de discussion, bien plus large que la fenêtre envoyée
 * au modèle ci-dessus : pouvoir remonter dans ce qui a été dit ne coûte rien, alors qu'envoyer tout
 * l'historique au modèle à chaque message coûterait du contexte (et donc de la VRAM) pour rien.
 */
const MAX_VISIBLE_MESSAGES = 200

/**
 * Mode Chat (étape 30) : exactement le même Jaris que la voix — mêmes outils, même mémoire markdown, même
 * historique de conversation — mais piloté au clavier et sans synthèse vocale. L'état vit ici (côté main)
 * plutôt que dans le renderer pour que passer d'un mode à l'autre dans la colonne latérale ne perde pas la
 * discussion en cours.
 *
 * L'historique court terme est amorcé avec les derniers échanges de conversation-history.json, alimenté
 * aussi bien par la voix que par le chat : demander quelque chose à l'oral puis enchaîner par écrit (ou
 * l'inverse) continue la même conversation au lieu de repartir de zéro.
 */
class ChatSession {
  private history: OllamaMessage[] = []
  private visible: ChatMessage[] = []
  private loaded = false

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const pastEntries = await getConversationHistory(MAX_HISTORY_MESSAGES / 2)
    this.history = pastEntries.flatMap((entry): OllamaMessage[] => [
      { role: 'user', content: entry.transcript },
      { role: 'assistant', content: entry.reply }
    ])
  }

  /** Messages à afficher dans le fil (vide au premier lancement : on n'y remet pas l'historique vocal). */
  getVisibleMessages(): ChatMessage[] {
    return this.visible
  }

  /** Vidé en même temps que l'historique global, depuis le menu Options (voir clearConversationHistory). */
  clear(): void {
    this.history = []
    this.visible = []
    this.loaded = false
  }

  async send(
    prompt: string,
    onReminderFire: (message: string) => void,
    onLog: (message: string) => void
  ): Promise<ChatMessage> {
    await this.ensureLoaded()
    this.pushVisible({ role: 'user', content: prompt })

    // Même sécurité thermique qu'à la voix : inutile de lancer une inférence sur un GPU déjà trop chaud.
    // Le relevé est réutilisé par converse() plus bas au lieu d'en relancer un second.
    const live = await getLiveGpuStatus()
    const gpuStatus = checkGpuTempSafety(live.tempC)
    if (gpuStatus.action === 'abort' || gpuStatus.action === 'shutdown') {
      onLog(`Sécurité thermique GPU : ${gpuStatus.message}`)
      return this.pushVisible({ role: 'assistant', content: gpuStatus.message as string })
    }

    let reply: string
    try {
      const profile = await getProfile()
      reply = await converse(
        prompt,
        profile?.name ?? null,
        onReminderFire,
        onLog,
        this.history,
        undefined,
        live,
        'chat'
      )
      if (gpuStatus.action === 'warn') reply = `${gpuStatus.message}\n\n${reply}`
    } catch (err) {
      onLog(`Erreur Ollama (chat) : ${err instanceof Error ? err.message : String(err)}`)
      return this.pushVisible({
        role: 'assistant',
        content: "Je n'arrive pas à réfléchir pour le moment, vérifie qu'Ollama tourne bien."
      })
    }

    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply })
    this.history.splice(0, Math.max(0, this.history.length - MAX_HISTORY_MESSAGES))

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
