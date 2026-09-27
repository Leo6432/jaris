import { ChildProcessByStdio, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'
import { resolvePythonBin } from './pythonRuntime'
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
  | { event: 'mic_test_done'; detected: boolean; silentStream?: boolean }
  | { event: 'wake_test_heard'; text: string; matched: boolean; tooShort: boolean; peak: number }

const voiceServerScript = (): string => join(pythonScriptsDir(), 'voice_server.py')

/**
 * Où en est l'écoute vocale (étape 188) : un test micro envoyé à un sidecar qui charge encore ou qui s'est
 * arrêté n'obtient jamais de réponse — l'écran restait alors muet, comme si le micro n'entendait rien.
 */
export type VoiceListeningStatus =
  | { state: 'off' }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; message: string }

/**
 * Pourquoi un test (micro ou mot « Jaris ») ne peut pas tourner maintenant, en une phrase pour Léo ; `null`
 * quand l'écoute est prête. Le vrai message d'erreur est relayé tel quel, jamais remplacé par un générique.
 */
export function listeningUnavailableReason(status: VoiceListeningStatus): string | null {
  switch (status.state) {
    case 'ready':
      return null
    case 'loading':
      return "L'écoute démarre encore. Au premier lancement, Jaris télécharge la transcription (environ 2,5 Go) : réessaie dans quelques minutes."
    case 'failed':
      return `L'écoute n'a pas pu démarrer : ${status.message}`
    case 'off':
      return "L'écoute n'est pas lancée. Ferme puis rouvre Jaris."
  }
}

/**
 * Sidecar Python persistant : écoute continue du micro, détection du mot
 * d'activation "Jaris" (ou déclenchement manuel, voir triggerWake) et transcription
 * (Parakeet v3, en RAM — étape 158) dans un seul process. Émet 'wake', 'transcript' (text: string),
 * 'log', 'error', 'micTestLevel' (level: number) et 'micTestDone' (detected: boolean).
 */
export class VoiceClient extends EventEmitter {
  private proc: VoiceServerProcess | null = null
  private ready: Promise<void> | null = null
  private status: VoiceListeningStatus = { state: 'off' }

  getStatus(): VoiceListeningStatus {
    return this.status
  }

  /**
   * @param inputDeviceIndex Index PortAudio choisi dans Options → Voix (voir Profile.audioInputDeviceIndex),
   * prioritaire sur MIC_INPUT_DEVICE (.env) s'il est fourni. `undefined`/`null` = retombe sur .env.
   * @param wakewordEnabled Options → Activation (étape 81, Profile.activationWakeWordEnabled) : `false`
   * passe `--wakeword-disabled` à voice_server.py, qui ne transcrit alors plus chaque phrase entendue en
   * attendant le mot "Jaris" (étape 179) — rien à calculer pour un utilisateur qui préfère la touche "+"/l'orbe.
   */
  start(inputDeviceIndex?: number | null, wakewordEnabled = true): Promise<void> {
    if (this.ready) return this.ready

    this.status = { state: 'loading' }
    this.ready = new Promise((resolveReady, rejectReady) => {
      // Transcription : Parakeet v3, version épinglée dans voice_server.py (étape 158) — plus de réglage à passer.
      const args = ['-u', voiceServerScript()]
      if (inputDeviceIndex !== undefined && inputDeviceIndex !== null) {
        args.push('--input-device', String(inputDeviceIndex))
      } else if (config.voice.inputDevice !== '') {
        args.push('--input-device', config.voice.inputDevice)
      }
      if (!wakewordEnabled) {
        args.push('--wakeword-disabled')
      }

      const proc = spawn(resolvePythonBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      this.proc = proc
      // Un sidecar (re)démarré repart en écoute : l'état voulu est réappliqué tout de suite (lu par voice_server.py
      // dès qu'il a fini de charger, les lignes attendent dans le tube d'ici là).
      if (this.wakePaused) proc.stdin.write('pause-wake\n')

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
            if (this.proc === proc) this.status = { state: 'ready' }
            resolveReady()
            break
          case 'fatal':
            settled = true
            if (this.proc === proc) this.status = { state: 'failed', message: payload.message }
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
            this.emit('micTestDone', { detected: payload.detected, silentStream: payload.silentStream === true })
            break
          case 'wake_test_heard':
            this.emit('wakeTestHeard', { text: payload.text, matched: payload.matched, tooShort: payload.tooShort, peak: payload.peak })
            break
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[voice_server]', chunk.toString())
      })

      proc.on('exit', (code) => {
        // Un arrêt voulu (stop) a déjà détaché ce process : son statut n'a plus à changer.
        if (this.proc === proc && this.status.state !== 'failed') {
          this.status = {
            state: 'failed',
            message: settled ? `l'écoute s'est arrêtée toute seule (code ${code})` : `le programme d'écoute s'est arrêté avant d'être prêt (code ${code})`
          }
        }
        this.proc = null
        this.ready = null
        if (!settled) rejectReady(new Error(`sidecar vocal arrêté avant d'être prêt (code ${code})`))
      })

      proc.on('error', (err) => {
        if (this.proc === proc) this.status = { state: 'failed', message: err.message }
        if (!settled) rejectReady(err)
      })
    })

    return this.ready
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
    this.status = { state: 'off' }
  }

  private wakePaused = false

  /**
   * Étape 183 (Léo : « le détecteur de voix doit être actif que quand on est en vocal, et pas chat ni code ni
   * option ») : en pause, le sidecar ne transcrit plus rien en attendant « Jaris » — le micro reste ouvert (tests
   * d'Options, touche « + »), mais plus aucune phrase entendue n'est analysée.
   */
  setWakePaused(paused: boolean): void {
    if (paused === this.wakePaused) return
    this.wakePaused = paused
    this.proc?.stdin.write(paused ? 'pause-wake\n' : 'resume-wake\n')
  }

  /** Force un déclenchement manuel (touche "+"), comme si le mot d'activation "Jaris" avait été détecté. */
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

  /** Étape 180 : chaque phrase entendue est renvoyée telle que comprise ('wakeTestHeard'), sans réveiller Jaris. */
  testWakeWord(): void {
    this.proc?.stdin.write('test-wake\n')
  }

  stopTestWakeWord(): void {
    this.proc?.stdin.write('stop-test-wake\n')
  }
}

/**
 * Liste les micros détectés par PortAudio, via un process Python séparé et jetable (--list-devices) :
 * n'ouvre aucun micro et ne charge aucun modèle, donc n'entre jamais en conflit avec le sidecar déjà en
 * écoute (VoiceClient ci-dessus). Utilisé pour peupler le sélecteur de micro dans Options → Voix.
 */
export function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolvePythonBin(), ['-u', voiceServerScript(), '--list-devices'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    // setEncoding plutôt que `chunk.toString()` : un caractère accentué (2 octets en UTF-8) peut tomber À
    // CHEVAL sur deux morceaux du flux, et décoder chaque morceau séparément casse alors ce caractère en deux
    // "�" — exactement le symptôme corrigé côté Python juste à côté, mais pour une raison différente. Node
    // garde ici l'octet incomplet pour le morceau suivant (StringDecoder interne). Les noms de micros
    // Windows sont justement pleins d'accents ("Microphone (Réseau)"), et c'est cette liste qu'on lit.
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
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
