import { ChildProcessByStdio, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'
import type { AudioInputDevice } from '../../shared/ipc'

type VoiceServerProcess = ChildProcessByStdio<Writable, Readable, Readable>

type VoiceServerEvent =
  | { event: 'ready' }
  | { event: 'wake' }
  | { event: 'transcript'; text: string }
  | { event: 'log'; message: string }
  | { event: 'error'; message: string }
  | { event: 'fatal'; message: string }
  | { event: 'mic_test_started' }
  | { event: 'mic_test_level'; level: number }
  | { event: 'mic_test_done'; detected: boolean }

const voiceServerScript = (): string => join(pythonScriptsDir(), 'voice_server.py')

/**
 * Sidecar Python persistant : écoute continue du micro, détection de double
 * clap (ou déclenchement manuel, voir triggerWake) et transcription (Cohere
 * Transcribe) dans un seul process. Émet 'wake', 'transcript' (text: string),
 * 'log', 'error', 'micTestLevel' (level: number) et 'micTestDone' (detected: boolean).
 */
export class VoiceClient extends EventEmitter {
  private proc: VoiceServerProcess | null = null
  private ready: Promise<void> | null = null

  /**
   * @param inputDeviceIndex Index PortAudio choisi dans Options → Voix (voir Profile.audioInputDeviceIndex),
   * prioritaire sur MIC_INPUT_DEVICE (.env) s'il est fourni. `undefined`/`null` = retombe sur .env.
   */
  start(inputDeviceIndex?: number | null): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise((resolveReady, rejectReady) => {
      const args = [
        '-u',
        voiceServerScript(),
        '--stt-model',
        config.stt.model,
        '--stt-device',
        config.stt.device,
        '--stt-language',
        config.stt.language
      ]
      if (inputDeviceIndex !== undefined && inputDeviceIndex !== null) {
        args.push('--input-device', String(inputDeviceIndex))
      } else if (config.voice.inputDevice !== '') {
        args.push('--input-device', config.voice.inputDevice)
      }

      const proc = spawn(config.python.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
          case 'mic_test_started':
            this.emit('micTestStarted')
            break
          case 'mic_test_level':
            this.emit('micTestLevel', payload.level)
            break
          case 'mic_test_done':
            this.emit('micTestDone', payload.detected)
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

  /** Force un déclenchement manuel (touche "+"), comme un double clap détecté. */
  triggerWake(): void {
    this.proc?.stdin.write('trigger\n')
  }

  /** Démarre le test micro sur le micro actuellement ouvert par le sidecar : reste actif jusqu'à stopTestMic() (voir mic_test_* dans voice_server.py). */
  testMic(): void {
    this.proc?.stdin.write('test-mic\n')
  }

  /** Arrête un test micro démarré par testMic(). */
  stopTestMic(): void {
    this.proc?.stdin.write('stop-mic-test\n')
  }
}

/**
 * Liste les micros détectés par PortAudio, via un process Python séparé et jetable (--list-devices) :
 * n'ouvre aucun micro et ne charge aucun modèle, donc n'entre jamais en conflit avec le sidecar déjà en
 * écoute (VoiceClient ci-dessus). Utilisé pour peupler le sélecteur de micro dans Options → Voix.
 */
export function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.python.bin, ['-u', voiceServerScript(), '--list-devices'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[voice_server --list-devices]', chunk.toString())
    })

    proc.on('error', reject)
    proc.on('close', () => {
      try {
        const payload = JSON.parse(stdout.trim()) as { devices?: AudioInputDevice[]; error?: string }
        if (payload.error) {
          reject(new Error(payload.error))
        } else {
          resolve(payload.devices ?? [])
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })
}
