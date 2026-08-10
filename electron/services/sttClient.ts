import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { config } from '../config'

interface PendingRequest {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

type SttEvent =
  | { event: 'ready'; model: string; device: string }
  | { event: 'fatal'; message: string }
  | { id: string; event: 'result'; text: string }
  | { id: string; event: 'error'; message: string }

/** Sidecar Python persistant (faster-whisper). Un seul process pour toute la session. */
export class SttClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, PendingRequest>()

  start(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise((resolveReady, rejectReady) => {
      const proc = spawn(
        config.whisper.pythonBin,
        [
          '-u',
          join(__dirname, '../../python/stt_server.py'),
          '--model',
          config.whisper.model,
          '--device',
          config.whisper.device,
          '--compute-type',
          config.whisper.computeType,
          '--language',
          config.whisper.language
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      this.proc = proc

      let settled = false
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let payload: SttEvent
        try {
          payload = JSON.parse(line)
        } catch {
          return
        }

        if (payload.event === 'ready') {
          settled = true
          resolveReady()
          return
        }
        if (payload.event === 'fatal') {
          settled = true
          rejectReady(new Error(payload.message))
          return
        }
        if ('id' in payload) {
          const pending = this.pending.get(payload.id)
          if (!pending) return
          this.pending.delete(payload.id)
          if (payload.event === 'result') pending.resolve(payload.text)
          else pending.reject(new Error(payload.message))
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[stt]', chunk.toString())
      })

      proc.on('exit', (code) => {
        this.proc = null
        this.ready = null
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`sidecar STT arrêté (code ${code})`))
        }
        this.pending.clear()
        if (!settled) rejectReady(new Error(`sidecar STT arrêté avant d'être prêt (code ${code})`))
      })

      proc.on('error', (err) => {
        if (!settled) rejectReady(err)
      })
    })

    return this.ready
  }

  async transcribe(audioPath: string): Promise<string> {
    await this.start()
    if (!this.proc) throw new Error('sidecar STT indisponible')

    const id = randomUUID()
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.proc.stdin.write(JSON.stringify({ id, audio_path: audioPath }) + '\n')
    return result
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}
