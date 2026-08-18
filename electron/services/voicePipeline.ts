import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { JarisEmotion, VoiceReplyPayload } from '../../shared/ipc'
import { VoiceClient } from './voiceClient'
import { synthesizeSpeech } from './tts'
import { appendConversationEntry, getConversationHistory } from './conversationStore'
import { converse } from './assistant'
import { extractMemoryFromExchange } from './memoryExtractor'
import type { OllamaMessage } from './ollama'
import { restoreReminders } from './reminders'
import { getProfile } from './profileStore'
import { getLiveGpuStatus } from './hardwareScan'
import { checkGpuTempSafety } from './resourceMonitor'

/**
 * Derniers échanges (user/assistant) gardés en mémoire courte, pour que Jaris comprenne une
 * correction/précision ("répète juste l'adresse") sans devoir tout redire depuis le début. Une fenêtre
 * glissante plutôt qu'un vrai reset explicite : le contexte ancien sort tout seul au fil des échanges,
 * pas besoin de deviner "quand" une conversation est vraiment terminée.
 *
 * Rechargée depuis conversation-history.json (déjà tenu à jour par appendConversationEntry) à chaque
 * démarrage de Jaris : sans ça, redémarrer l'appli (ou revenir le lendemain) effaçait tout le contexte
 * d'un coup, alors que pour l'utilisateur c'est juste une pause dans la même conversation.
 */
const MAX_HISTORY_MESSAGES = 12

/** Retour à idle après une erreur (pas d'audio en cours, donc pas besoin d'attendre une fin de lecture). */
const ERROR_IDLE_DELAY_MS = 2500
/** Petit délai pour laisser l'expression "happy" s'afficher un instant une fois la phrase terminée. */
const IDLE_SETTLE_DELAY_MS = 400
/**
 * Filet de sécurité si le renderer ne prévient jamais que la lecture audio est finie (fenêtre fermée,
 * lecture bloquée...) : évite de rester bloqué indéfiniment sur "happy" plutôt que de dépendre d'un
 * minuteur fixe déconnecté de la durée réelle de la phrase.
 */
const AUDIO_FALLBACK_IDLE_MS = 20000

/** Laisse le temps à Jaris de dire l'avertissement d'arrêt (this.speak) avant de vraiment fermer l'appli. */
const SHUTDOWN_DELAY_MS = 4000

/** Distance d'édition entre deux mots, pour repérer les mots proches phonétiquement de "arobase". */
function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

const AROBASE_VARIANTS = ['arobase', 'arrobase']

const EMAIL_PROVIDERS = [
  'gmail',
  'outlook',
  'hotmail',
  'yahoo',
  'icloud',
  'live',
  'laposte',
  'orange',
  'free',
  'wanadoo',
  'sfr',
  'protonmail',
  'gmx',
  'aol'
]
const EMAIL_DOMAIN_PATTERN = new RegExp(
  `\\b([\\w-]+(?:\\.[\\w-]+)*)\\.(${EMAIL_PROVIDERS.join('|')})\\.(com|fr|net|org|be|ch|ca|co)\\b`,
  'gi'
)

/**
 * Certains modèles de transcription reconnaissent la ponctuation dictée ("point" -> ".") mais
 * confondent parfois "arobase" avec "point" et transforment tout en points ("milano.iris.gmail.com"
 * au lieu de "milano.iris@gmail.com") : impossible à corriger mot par mot puisque le "@" a déjà disparu
 * de la transcription. On détecte plutôt le motif "texte.fournisseur-mail.extension" et on remet le @
 * au bon endroit, juste avant le nom du fournisseur.
 */
function fixSpokenEmailAt(text: string): string {
  return text.replace(EMAIL_DOMAIN_PATTERN, (match, localPart: string, provider: string, tld: string) =>
    match.includes('@') ? match : `${localPart}@${provider}.${tld}`
  )
}

/**
 * La transcription du mot "arobase" varie parfois d'une fois sur l'autre (rubaze, arobaz...) plutôt
 * que de donner le symbole : une correspondance figée ne suffit pas, on compare chaque mot par
 * distance d'édition à "arobase"/"arrobase" pour tolérer ces variations.
 */
function normalizeSpokenSymbols(text: string): string {
  const withEmailFixed = fixSpokenEmailAt(text)
  return withEmailFixed.replace(/[^\s.,!?;:]+/g, (word) => {
    const cleaned = word.toLowerCase()
    if (cleaned.length < 5 || cleaned.length > 9) return word
    const closeEnough = AROBASE_VARIANTS.some((variant) => levenshteinDistance(cleaned, variant) <= 3)
    return closeEnough ? '@' : word
  })
}

/**
 * Orchestre le cycle complet : mot d'activation -> capture -> transcription ->
 * réflexion (Ollama, avec outils : ouvrir une appli, programmer un rappel) ->
 * réponse parlée. Les rappels qui se déclenchent tout seuls passent par le
 * même canal de réponse (announceReminder -> speak).
 */
export class VoicePipeline extends EventEmitter {
  private voice = new VoiceClient()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private history: OllamaMessage[] = []
  /**
   * Incrémenté à chaque nouveau mot d'activation détecté : distingue l'échange "courant" de tout échange
   * précédent encore en cours de traitement (réflexion Ollama, synthèse vocale), pour pouvoir l'abandonner
   * proprement plutôt que de le laisser répondre par-dessus la nouvelle demande de l'utilisateur.
   */
  private generation = 0
  private abortController: AbortController | null = null

  async start(): Promise<void> {
    this.voice.on('wake', () => {
      // Le sidecar Python écoute le mot d'activation en continu, indépendamment de ce que fait Electron :
      // un nouveau "wake" peut donc arriver alors que la réponse précédente est encore en train d'être
      // réfléchie ou dite à voix haute. Il doit toujours primer sur ce qui est en cours.
      this.interrupt()
      this.setEmotion('listening')
    })
    this.voice.on('transcript', (text: string) => {
      void this.handleTranscript(text)
    })
    this.voice.on('log', (message: string) => this.emit('log', message))
    this.voice.on('error', (err: Error) => {
      this.emit('log', `Erreur pipeline vocal : ${err.message}`)
      this.setEmotion('surprised')
      this.scheduleIdle(ERROR_IDLE_DELAY_MS)
    })

    // Recharge les derniers échanges de la fois précédente (même après un redémarrage de Jaris ou un
    // jour d'écart) : pour l'utilisateur, revenir le lendemain sur le même sujet doit continuer la
    // conversation, pas repartir de zéro comme si de rien n'était.
    const pastEntries = await getConversationHistory(MAX_HISTORY_MESSAGES / 2)
    this.history = pastEntries.flatMap((entry): OllamaMessage[] => [
      { role: 'user', content: entry.transcript },
      { role: 'assistant', content: entry.reply }
    ])

    await restoreReminders((message) => void this.announceReminder(message))
    await this.voice.start()
    this.setEmotion('idle')
  }

  stop(): void {
    this.clearIdleTimer()
    this.voice.stop()
  }

  triggerWake(): void {
    this.voice.triggerWake()
  }

  /**
   * Vide le contexte court terme en mémoire (voir MAX_HISTORY_MESSAGES ci-dessus), en plus du fichier
   * conversation-history.json effacé séparément (voir clearConversationHistory) : sans ça, supprimer
   * l'historique depuis le menu Options n'empêcherait pas Jaris de continuer à se souvenir des derniers
   * échanges déjà chargés en mémoire depuis le démarrage en cours.
   */
  clearHistory(): void {
    this.history = []
  }

  /** Le renderer prévient dès que la lecture audio de la réponse est terminée : c'est le vrai signal pour repasser en idle, pas une estimation. */
  notifyAudioEnded(): void {
    this.scheduleIdle(IDLE_SETTLE_DELAY_MS)
  }

  /**
   * Un nouveau mot d'activation prime toujours sur ce que Jaris est en train de faire : annule la requête
   * Ollama en cours s'il y en a une (this.abortController), et prévient le renderer (évènement 'interrupt',
   * voir main.ts) de couper net une réponse en train d'être lue à voix haute. Toute suite d'un traitement
   * de l'ancienne génération (voir les vérifications `myGeneration !== this.generation` plus bas) est alors
   * silencieusement abandonnée au lieu de répondre par-dessus la nouvelle demande.
   */
  private interrupt(): void {
    this.clearIdleTimer()
    this.generation++
    this.abortController?.abort()
    this.abortController = null
    this.emit('interrupt')
  }

  private async announceReminder(message: string): Promise<void> {
    this.clearIdleTimer()
    const myGeneration = this.generation
    this.setEmotion('thinking')
    await this.speak(`Rappel : ${message}`, '', myGeneration)
  }

  private async handleTranscript(rawText: string): Promise<void> {
    const myGeneration = this.generation
    const transcript = normalizeSpokenSymbols(rawText.trim())
    if (transcript) this.emit('transcript', transcript)

    if (!transcript) {
      await this.speak("Je n'ai rien entendu, réessaie.", '', myGeneration)
      return
    }

    // "listening" (mis par le handler 'wake') reste affiché jusqu'ici, le temps réel de la capture +
    // transcription côté sidecar : "thinking" n'apparaît qu'à partir du moment où on a vraiment une
    // phrase à traiter, pas dès le mot d'activation.
    this.setEmotion('thinking')

    // Sécurité thermique GPU vérifiée avant même d'appeler le LLM (pas dans converse) : si la requête doit
    // être annulée, inutile de charger encore plus un GPU déjà chaud avec un appel d'inférence.
    const gpuStatus = checkGpuTempSafety((await getLiveGpuStatus()).tempC)
    if (gpuStatus.action === 'abort' || gpuStatus.action === 'shutdown') {
      this.emit('log', `Sécurité thermique GPU : ${gpuStatus.message}`)
      await this.speak(gpuStatus.message as string, transcript, myGeneration)
      // Délai pour laisser l'avertissement être dit avant de fermer réellement l'appli (voir main.ts,
      // qui écoute cet évènement pour faire un vrai app.quit()).
      if (gpuStatus.action === 'shutdown') setTimeout(() => this.emit('shutdown'), SHUTDOWN_DELAY_MS)
      return
    }

    const controller = new AbortController()
    this.abortController = controller

    let reply: string
    try {
      const profile = await getProfile()
      reply = await converse(
        transcript,
        profile?.name ?? null,
        (message) => void this.announceReminder(message),
        (message) => this.emit('log', message),
        this.history,
        controller.signal
      )
      if (gpuStatus.action === 'warn') reply = `${gpuStatus.message} ${reply}`

      this.history.push({ role: 'user', content: transcript }, { role: 'assistant', content: reply })
      this.history.splice(0, Math.max(0, this.history.length - MAX_HISTORY_MESSAGES))

      // En arrière-plan, sans attendre : la mémoire longue durée s'enrichit toute seule à partir de la
      // conversation, sans compter sur le fait que l'utilisateur pense à dire "retiens que..." à chaque
      // fois. Ne retarde jamais la réponse déjà en train d'être dite (this.speak juste après).
      void extractMemoryFromExchange(transcript, reply, (message) => this.emit('log', message))
    } catch (err) {
      // Un nouveau mot d'activation a coupé la réflexion en cours : l'utilisateur a déjà commencé à
      // reformuler sa demande, inutile de dire une erreur pour une question qu'il a lui-même abandonnée.
      if (controller.signal.aborted) return
      this.emit('log', `Erreur Ollama : ${err instanceof Error ? err.message : String(err)}`)
      reply = "Je n'arrive pas à réfléchir pour le moment, vérifie qu'Ollama tourne bien."
    } finally {
      if (this.abortController === controller) this.abortController = null
    }

    if (myGeneration !== this.generation) return
    await this.speak(reply, transcript, myGeneration)
  }

  private async speak(reply: string, transcript = '', myGeneration = this.generation): Promise<void> {
    try {
      const audio = await synthesizeSpeech(reply)
      // Supplanté par un nouveau mot d'activation pendant la synthèse vocale : ne joue jamais une réponse
      // devenue obsolète par-dessus la nouvelle demande de l'utilisateur.
      if (myGeneration !== this.generation) return
      const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer

      const payload: VoiceReplyPayload = { transcript, reply, audio: audioBuffer }
      this.emit('reply', payload)
      this.setEmotion('happy')

      if (transcript) {
        await appendConversationEntry({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          transcript,
          reply
        })
      }

      this.scheduleIdle(AUDIO_FALLBACK_IDLE_MS)
    } catch (err) {
      if (myGeneration !== this.generation) return
      this.emit('log', `Erreur de synthèse vocale : ${err instanceof Error ? err.message : String(err)}`)
      this.setEmotion('surprised')
      this.scheduleIdle(ERROR_IDLE_DELAY_MS)
    }
  }

  private setEmotion(emotion: JarisEmotion): void {
    this.emit('emotion', emotion)
  }

  private scheduleIdle(delayMs: number): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.setEmotion('idle'), delayMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
