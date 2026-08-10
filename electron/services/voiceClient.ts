import { ChildProcessByStdio, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { config } from '../config'

type VoiceServerProcess = ChildProcessByStdio<Writable, Readable, Readable>

type VoiceServerEvent =
  | { event: 'ready'; wakeword_model: string }
  | { event: 'wake' }
  | { event: 'transcript'; text: string }
  | { event: 'log'; message: string }
  | { event: 'error'; message: string }
  | { event: 'fatal'; message: string }

/**
 * Sidecar Python persistant : écoute continue du micro, mot d'activation
 * (openWakeWord) et transcription (faster-whisper) dans un seul process.
 * Émet 'wake', 'transcript' (text: string), 'log' et 'error'.
 */
export class VoiceClient extends EventEmitter {
  private proc: VoiceServerProcess | null = null
  private ready: Promise<void> | null = null

  start(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise((resolveReady, rejectReady) => {
      const args = [
        '-u',
        join(__dirname, '../../python/voice_server.py'),
        '--wakeword-model',
        config.wakeword.modelPath,
        '--melspec-model',
        config.wakeword.melspecModelPath,
        '--embedding-model',
        config.wakeword.embeddingModelPath,
        '--wakeword-threshold',
        String(config.wakeword.threshold),
        '--whisper-model',
        config.whisper.model,
        '--whisper-device',
        config.whisper.device,
        '--whisper-compute-type',
        config.whisper.computeType,
        '--whisper-language',
        config.whisper.language
      ]
      if (config.wakeword.inputDevice !== '') {
        args.push('--input-device', config.wakeword.inputDevice)
      }

      const proc = spawn(config.python.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = proc

      let settled = false
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let payload: VoiceServerEvent
        try {
          payload = JSON.parse(line)
        } catch {
          return
        }

        switch (payload.event) {
          case 'ready':
            settled = true
            resolveReady()
            break
          case 'fatal':
            settled = true
            rejectReady(new Error(payload.message))
            break
          case 'wake':
            this.emit('wake')
            break
          case 'transcript':
            this.emit('transcript', payload.text)
            break
          case 'log':
            this.emit('log', payload.message)
            break
          case 'error':
            this.emit('error', new Error(payload.message))
            break
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[voice_server]', chunk.toString())
      })

      proc.on('exit', (code) => {
        this.proc = null
        this.ready = null
        if (!settled) rejectReady(new Error(`sidecar vocal arrêté avant d'être prêt (code ${code})`))
      })

      proc.on('error', (err) => {
        if (!settled) rejectReady(err)
      })
    })

    return this.ready
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }

  /** Force un déclenchement, comme si le mot d'activation venait d'être détecté. */
  triggerWake(): void {
    this.proc?.stdin.write('trigger\n')
  }
}
