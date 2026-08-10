import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { JarisEmotion, VoiceReplyPayload } from '../../shared/ipc'
import { VoiceClient } from './voiceClient'
import { synthesizeSpeech } from './tts'
import { appendConversationEntry } from './conversationStore'

const BACK_TO_IDLE_DELAY_MS = 2500

/**
 * Orchestre le cycle complet : mot d'activation -> capture -> transcription ->
 * réponse parlée. Pas encore de LLM (étape 4) : Jaris confirme ce qu'il a
 * compris, ce qui prouve que toute la chaîne audio fonctionne de bout en bout.
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
      this.scheduleIdle()
    })

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

  private async handleTranscript(rawText: string): Promise<void> {
    const transcript = rawText.trim()
    if (transcript) this.emit('transcript', transcript)

    const reply = transcript ? `J'ai entendu : ${transcript}` : "Je n'ai rien entendu, réessaie."

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
    } catch (err) {
      this.emit('log', `Erreur de synthèse vocale : ${err instanceof Error ? err.message : String(err)}`)
      this.setEmotion('surprised')
    } finally {
      this.scheduleIdle()
    }
  }

  private setEmotion(emotion: JarisEmotion): void {
    this.emit('emotion', emotion)
  }

  private scheduleIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.setEmotion('idle'), BACK_TO_IDLE_DELAY_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
