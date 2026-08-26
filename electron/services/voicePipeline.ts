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
   * true tant qu'une phrase est en train d'être traitée (réflexion Ollama + réponse parlée) : le sidecar
   * Python écoute le mot d'activation en continu, indépendamment de ce que fait Electron, donc une nouvelle
   * phrase peut être captée pendant ce temps. Une phrase captée PENDANT LA RÉFLEXION (ex: "en fait le
   * ethereum" juste après "quel est le prix du bitcoin") n'a souvent aucun sens toute seule : elle est
   * fusionnée avec la phrase en cours et la réflexion recommence avec le tout, pour ne donner qu'UNE seule
   * réponse combinant les deux plutôt que deux réponses séparées. Une phrase captée pendant que la réponse
   * précédente est déjà en train d'être dite, elle, ne peut plus être fusionnée avec une réponse déjà
   * donnée : elle démarre son propre nouvel échange juste après (voir la fin de runTranscript).
   */
  private busy = false
  private pendingAdditions: string[] = []
  private abortController: AbortController | null = null

  async start(): Promise<void> {
    this.voice.on('wake', () => {
      this.clearIdleTimer()
      this.setEmotion('listening')
    })
    this.voice.on('transcript', (text: string) => {
      const addition = normalizeSpokenSymbols(text.trim())
      if (!addition) {
        if (!this.busy) void this.runTranscript('')
        return
      }
      if (this.busy) {
        this.pendingAdditions.push(addition)
        this.emit('log', `Phrase captée pendant la réflexion, fusion avec la question en cours : « ${addition} »`)
        // Annule la réflexion en cours s'il y en a une : elle repart tout de suite avec la phrase
        // fusionnée, au lieu de finir de répondre à une question probablement dépassée puis de répondre
        // une seconde fois séparément (voir runTranscript).
        this.abortController?.abort()
        this.setEmotion('thinking')
        return
      }
      void this.runTranscript(addition)
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
   * Public : un rappel programmé depuis le mode Chat (étape 30) doit être annoncé à voix haute exactement
   * comme un rappel programmé à la voix — c'est le même Jaris, l'utilisateur n'a aucune raison de rater un
   * rappel juste parce qu'il l'a demandé au clavier (voir le branchement dans main.ts).
   */
  async announceReminder(message: string): Promise<void> {
    this.clearIdleTimer()
    this.setEmotion('thinking')
    await this.speak(`Rappel : ${message}`)
  }

  /**
   * Traite une phrase. Si une nouvelle phrase arrive pendant la réflexion Ollama, elle est fusionnée avec
   * ce qui précède et la réflexion recommence avec le tout (boucle `while`) : une seule réponse est donnée
   * à la fin, jamais deux. Une fois la réponse donnée, si une phrase est arrivée entre-temps (pendant la
   * synthèse/lecture audio, trop tard pour être fusionnée avec une réponse déjà émise), elle démarre son
   * propre nouvel échange, enchaîné automatiquement sans que l'utilisateur ait besoin de redire le mot
   * d'activation.
   */
  private async runTranscript(firstPart: string): Promise<void> {
    this.busy = true
    let parts = firstPart ? [firstPart] : []

    while (true) {
      const combined = parts.join('. ').trim()
      if (combined) this.emit('transcript', combined)

      if (!combined) {
        await this.speak("Je n'ai rien entendu, réessaie.")
        break
      }

      // "listening" (mis par le handler 'wake') reste affiché jusqu'ici, le temps réel de la capture +
      // transcription côté sidecar : "thinking" n'apparaît qu'à partir du moment où on a vraiment une
      // phrase à traiter, pas dès le mot d'activation.
      this.setEmotion('thinking')

      // Sécurité thermique GPU vérifiée avant même d'appeler le LLM (pas dans converse) : si la requête
      // doit être annulée, inutile de charger encore plus un GPU déjà chaud avec un appel d'inférence.
      // Ce relevé est réutilisé plus bas dans converse() (passé en paramètre) au lieu d'en relancer un
      // second : un seul `nvidia-smi` par question, pas deux.
      const live = await getLiveGpuStatus()
      const gpuStatus = checkGpuTempSafety(live.tempC)
      if (gpuStatus.action === 'abort' || gpuStatus.action === 'shutdown') {
        this.emit('log', `Sécurité thermique GPU : ${gpuStatus.message}`)
        await this.speak(gpuStatus.message as string, combined)
        // Délai pour laisser l'avertissement être dit avant de fermer réellement l'appli (voir main.ts,
        // qui écoute cet évènement pour faire un vrai app.quit()).
        if (gpuStatus.action === 'shutdown') setTimeout(() => this.emit('shutdown'), SHUTDOWN_DELAY_MS)
        break
      }

      const controller = new AbortController()
      this.abortController = controller

      let reply = ''
      let aborted = false
      try {
        const profile = await getProfile()
        reply = await converse(
          combined,
          profile?.name ?? null,
          (message) => void this.announceReminder(message),
          (message) => this.emit('log', message),
          this.history,
          controller.signal,
          live
        )
        if (gpuStatus.action === 'warn') reply = `${gpuStatus.message} ${reply}`
      } catch (err) {
        if (controller.signal.aborted) {
          // Une phrase supplémentaire est arrivée pendant la réflexion : inutile de dire une erreur pour
          // une question de toute façon dépassée, on va la fusionner et recommencer juste en dessous.
          aborted = true
        } else {
          this.emit('log', `Erreur Ollama : ${err instanceof Error ? err.message : String(err)}`)
          reply = "Je n'arrive pas à réfléchir pour le moment, vérifie qu'Ollama tourne bien."
        }
      } finally {
        if (this.abortController === controller) this.abortController = null
      }

      // Une phrase est arrivée pendant la réflexion (annulation ci-dessus) ou pile au moment où la réponse
      // était prête (rare mais possible) : dans les deux cas, on la fusionne et on recommence, plutôt que
      // de répondre à côté ou de répondre deux fois.
      if (aborted || this.pendingAdditions.length > 0) {
        parts = [...parts, ...this.pendingAdditions]
        this.pendingAdditions = []
        this.emit('log', `Réflexion relancée avec la question fusionnée : « ${parts.join('. ')} »`)
        continue
      }

      this.history.push({ role: 'user', content: combined }, { role: 'assistant', content: reply })
      this.history.splice(0, Math.max(0, this.history.length - MAX_HISTORY_MESSAGES))

      // En arrière-plan, sans attendre : la mémoire longue durée s'enrichit toute seule à partir de la
      // conversation, sans compter sur le fait que l'utilisateur pense à dire "retiens que..." à chaque
      // fois. Ne retarde jamais la réponse déjà en train d'être dite (this.speak juste après).
      void extractMemoryFromExchange(combined, reply, (message) => this.emit('log', message))

      await this.speak(reply, combined)
      break
    }

    this.busy = false

    // Une phrase captée pendant la synthèse/lecture audio de la réponse qui vient d'être donnée : trop
    // tard pour la fusionner avec une réponse déjà dite, elle démarre son propre nouvel échange à la
    // suite, automatiquement.
    if (this.pendingAdditions.length > 0) {
      const queued = this.pendingAdditions.join('. ')
      this.pendingAdditions = []
      this.emit('log', `Phrase captée trop tard pour être fusionnée (réponse déjà donnée), nouvel échange : « ${queued} »`)
      void this.runTranscript(queued)
    }
  }

  private async speak(reply: string, transcript = ''): Promise<void> {
    try {
      const audio = await synthesizeSpeech(reply)
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
