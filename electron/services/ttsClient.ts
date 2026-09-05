import { ChildProcessByStdio, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'
import { resolvePythonBin } from './pythonRuntime'

type TtsServerProcess = ChildProcessByStdio<Writable, Readable, Readable>

type TtsServerEvent =
  | { event: 'ready' }
  | { event: 'speech'; path: string }
  | { event: 'error'; message: string }
  | { event: 'fatal'; message: string }

interface PendingRequest {
  resolve: (path: string) => void
  reject: (err: Error) => void
}

/**
 * Sidecar Python persistant pour la synthèse vocale (Supertonic HD) : le modèle est chargé une seule
 * fois au premier appel puis réutilisé pour chaque phrase, au lieu de relancer un process à chaque
 * réponse (contrairement à l'ancien Piper, appelé comme binaire natif à chaque fois).
 */
class TtsClient extends EventEmitter {
  private proc: TtsServerProcess | null = null
  private ready: Promise<void> | null = null
  private queue: PendingRequest[] = []

  start(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise((resolveReady, rejectReady) => {
      const proc = spawn(
        resolvePythonBin(),
        [
          '-u',
          join(pythonScriptsDir(), 'tts_server.py'),
          '--voice',
          config.tts.voice,
          '--language',
          config.tts.language
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
      this.proc = proc

      let settled = false
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let payload: TtsServerEvent
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
          case 'speech':
            this.queue.shift()?.resolve(payload.path)
            break
          case 'error':
            this.queue.shift()?.reject(new Error(payload.message))
            break
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[tts_server]', chunk.toString())
      })

      proc.on('exit', (code) => {
        this.proc = null
        this.ready = null
        const err = new Error(`sidecar TTS arrêté avant d'être prêt (code ${code})`)
        if (!settled) rejectReady(err)
        for (const pending of this.queue.splice(0)) pending.reject(err)
      })

      proc.on('error', (err) => {
        if (!settled) rejectReady(err)
      })
    })

    return this.ready
  }

  /** Synthétise `text` avec `voice` (défaut : celle passée au démarrage du sidecar), renvoie le chemin du WAV généré (à supprimer par l'appelant). */
  async synthesize(text: string, voice?: string): Promise<string> {
    await this.start()
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      const request = { text: text.replace(/\n/g, ' '), voice }
      this.proc?.stdin.write(JSON.stringify(request) + '\n')
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}

export const ttsClient = new TtsClient()
