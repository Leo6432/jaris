import { EventEmitter } from 'events'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Porcupine } from '@picovoice/porcupine-node'
import { PvRecorder } from '@picovoice/pvrecorder-node'
import { config } from '../config'
import { framesToWav } from './wav'

const SILENCE_RMS_THRESHOLD = 300
const SILENCE_DURATION_MS = 900
const MIN_UTTERANCE_MS = 400
const MAX_UTTERANCE_MS = 12_000

function rms(frame: Int16Array): number {
  let sumSquares = 0
  for (const sample of frame) sumSquares += sample * sample
  return Math.sqrt(sumSquares / frame.length)
}

type Mode = 'stopped' | 'wake' | 'capture'

/**
 * Écoute continue du mot d'activation "Jaris" (Porcupine), puis capture
 * l'énoncé qui suit jusqu'au silence et l'écrit dans un fichier WAV temporaire.
 *
 * Événements : 'wake' (mot détecté), 'utterance' (wavPath: string),
 * 'error' (Error).
 */
export class WakeWordListener extends EventEmitter {
  private porcupine: Porcupine | null = null
  private recorder: PvRecorder | null = null
  private mode: Mode = 'stopped'
  private captureFrames: Int16Array[] = []
  private silentMs = 0
  private capturedMs = 0

  start(): void {
    if (this.mode !== 'stopped') return

    this.porcupine = new Porcupine(
      config.porcupine.accessKey,
      [config.porcupine.keywordPath],
      [config.porcupine.sensitivity]
    )
    this.recorder = new PvRecorder(this.porcupine.frameLength)
    this.recorder.start()
    this.mode = 'wake'
    void this.loop()
  }

  stop(): void {
    this.mode = 'stopped'
    this.recorder?.stop()
    this.recorder?.release()
    this.porcupine?.release()
    this.recorder = null
    this.porcupine = null
  }

  private async loop(): Promise<void> {
    const recorder = this.recorder
    const porcupine = this.porcupine
    if (!recorder || !porcupine) return

    try {
      while (this.mode !== 'stopped') {
        const frame = await recorder.read()

        if (this.mode === 'wake') {
          if (porcupine.process(frame) !== -1) {
            this.beginCapture()
          }
        } else if (this.mode === 'capture') {
          this.captureFrames.push(frame)
          const frameMs = (frame.length / recorder.sampleRate) * 1000
          this.capturedMs += frameMs
          this.silentMs = rms(frame) < SILENCE_RMS_THRESHOLD ? this.silentMs + frameMs : 0

          const shouldStopOnSilence = this.silentMs > SILENCE_DURATION_MS && this.capturedMs > MIN_UTTERANCE_MS
          if (shouldStopOnSilence || this.capturedMs > MAX_UTTERANCE_MS) {
            await this.endCapture(recorder.sampleRate)
          }
        }
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private beginCapture(): void {
    this.mode = 'capture'
    this.captureFrames = []
    this.silentMs = 0
    this.capturedMs = 0
    this.emit('wake')
  }

  private async endCapture(sampleRate: number): Promise<void> {
    const wav = framesToWav(this.captureFrames, sampleRate)
    this.captureFrames = []
    this.mode = 'wake'

    const dir = await mkdtemp(join(tmpdir(), 'jaris-utterance-'))
    const wavPath = join(dir, 'utterance.wav')
    await writeFile(wavPath, wav)
    this.emit('utterance', wavPath)
  }
}
