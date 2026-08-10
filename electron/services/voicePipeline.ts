import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import type { JarisEmotion, VoiceReplyPayload } from '../../shared/ipc'
import { WakeWordListener } from './wakeword'
import { SttClient } from './sttClient'
import { synthesizeSpeech } from './tts'
import { appendConversationEntry } from './conversationStore'

const BACK_TO_IDLE_DELAY_MS = 2500

/**
 * Orchestre le cycle complet : mot d'activation -> capture -> transcription ->
 * réponse parlée. Pas encore de LLM (étape 4) : Jaris confirme ce qu'il a
 * compris, ce qui prouve que toute la chaîne audio fonctionne de bout en bout.
 */
export class VoicePipeline extends EventEmitter {
  private wakeWord = new WakeWordListener()
  private stt = new SttClient()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  async start(): Promise<void> {
    await this.stt.start()

    this.wakeWord.on('wake', () => {
      this.clearIdleTimer()
      this.setEmotion('listening')
    })
    this.wakeWord.on('utterance', (wavPath: string) => {
      void this.handleUtterance(wavPath)
    })
    this.wakeWord.on('error', (err: Error) => {
      this.emit('log', `Erreur wake word : ${err.message}`)
      this.setEmotion('surprised')
      this.scheduleIdle()
    })

    this.wakeWord.start()
    this.setEmotion('idle')
  }

  stop(): void {
    this.clearIdleTimer()
    this.wakeWord.stop()
    this.stt.stop()
  }

  private async handleUtterance(wavPath: string): Promise<void> {
    this.setEmotion('thinking')
    try {
      const transcript = (await this.stt.transcribe(wavPath)).trim()
      if (!transcript) {
        this.setEmotion('idle')
        return
      }
      this.emit('transcript', transcript)

      const reply = `J'ai entendu : ${transcript}`
      const audio = await synthesizeSpeech(reply)

      const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
      const payload: VoiceReplyPayload = { transcript, reply, audio: audioBuffer }
      this.emit('reply', payload)
      this.setEmotion('happy')

      await appendConversationEntry({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        transcript,
        reply
      })
    } catch (err) {
      this.emit('log', `Erreur pipeline vocal : ${err instanceof Error ? err.message : String(err)}`)
      this.setEmotion('surprised')
    } finally {
      await unlink(wavPath).catch(() => {})
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
