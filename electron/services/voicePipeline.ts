import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { JarisEmotion, VoiceReplyPayload } from '../../shared/ipc'
import { VoiceClient } from './voiceClient'
import { synthesizeSpeech } from './tts'
import { appendConversationEntry } from './conversationStore'
import { converse } from './assistant'
import { restoreReminders } from './reminders'
import { getProfile } from './profileStore'

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

  async start(): Promise<void> {
    this.voice.on('wake', () => {
      this.clearIdleTimer()
      this.setEmotion('listening')
      this.setEmotion('thinking') // la capture + transcription se font côté sidecar, sans étape intermédiaire visible
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

  /** Le renderer prévient dès que la lecture audio de la réponse est terminée : c'est le vrai signal pour repasser en idle, pas une estimation. */
  notifyAudioEnded(): void {
    this.scheduleIdle(IDLE_SETTLE_DELAY_MS)
  }

  private async announceReminder(message: string): Promise<void> {
    this.clearIdleTimer()
    this.setEmotion('thinking')
    await this.speak(`Rappel : ${message}`)
  }

  private async handleTranscript(rawText: string): Promise<void> {
    const transcript = normalizeSpokenSymbols(rawText.trim())
    if (transcript) this.emit('transcript', transcript)

    let reply: string
    if (!transcript) {
      reply = "Je n'ai rien entendu, réessaie."
    } else {
      try {
        const profile = await getProfile()
        reply = await converse(
          transcript,
          profile?.name ?? null,
          (message) => void this.announceReminder(message),
          (message) => this.emit('log', message)
        )
      } catch (err) {
        this.emit('log', `Erreur Ollama : ${err instanceof Error ? err.message : String(err)}`)
        reply = "Je n'arrive pas à réfléchir pour le moment, vérifie qu'Ollama tourne bien."
      }
    }

    await this.speak(reply, transcript)
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
