import { ChildProcessByStdio, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { config } from '../config'
import { pythonScriptsDir } from '../paths'
import { resolvePythonBin } from './pythonRuntime'
import { currentLanguage, t } from '../../shared/i18n'

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
 * Relecture croisée : une synthèse n'avait AUCUNE limite. Un tts_server.py figé laissait la phrase en cours attendre pour
 * toujours — et avec elle la file du téléphone (onglet Vocal), occupée jusqu'à la fermeture de Jaris. Le programme de
 * voix ne dit rien pendant qu'il synthétise : ce qui est surveillé, c'est le temps écoulé depuis son dernier signe de vie
 * (une phrase finie, un message) alors qu'une phrase attend — jamais la durée totale d'un long texte qui avance.
 */
export const TTS_IDLE_MS = 120_000

export interface TtsClientOptions {
  /** Remplacés par les tests. */
  idleMs?: number
  spawn?: typeof spawn
}

/**
 * Sidecar Python persistant pour la synthèse vocale (Supertonic HD) : le modèle est chargé une seule
 * fois au premier appel puis réutilisé pour chaque phrase, au lieu de relancer un process à chaque
 * réponse (contrairement à l'ancien Piper, appelé comme binaire natif à chaque fois).
 */
export class TtsClient extends EventEmitter {
  private proc: TtsServerProcess | null = null
  private ready: Promise<void> | null = null
  /** Les phrases demandées au programme EN COURS, dans l'ordre où il y répond. */
  private queue: PendingRequest[] = []
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private readonly idleMs: number
  private readonly spawnFn: typeof spawn

  constructor(options: TtsClientOptions = {}) {
    super()
    this.idleMs = options.idleMs ?? TTS_IDLE_MS
    this.spawnFn = options.spawn ?? spawn
  }

  /** (Re)part de zéro à chaque signe de vie ; arrêtée quand plus aucune phrase n'attend. */
  private watch(proc: TtsServerProcess): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    if (this.proc !== proc || !this.queue.length) return
    this.watchdog = setTimeout(() => this.stalled(proc), this.idleMs)
  }

  /** Plus aucun signe de vie : les phrases en attente échouent avec la raison, et la voix repart à la phrase suivante. */
  private stalled(proc: TtsServerProcess): void {
    if (this.proc !== proc) return
    this.watchdog = null
    const err = new Error(t('voice.ttsStalled', { seconds: Math.round(this.idleMs / 1000) }))
    const pending = this.queue.splice(0)
    this.proc = null
    this.ready = null
    proc.kill()
    for (const request of pending) request.reject(err)
  }

  start(): Promise<void> {
    if (this.ready) return this.ready

    const queue: PendingRequest[] = []
    this.queue = queue
    this.ready = new Promise((resolveReady, rejectReady) => {
      const proc = this.spawnFn(
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
      ) as TtsServerProcess
      this.proc = proc

      let settled = false
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let payload: TtsServerEvent
        try {
          payload = JSON.parse(line)
        } catch {
          this.watch(proc)
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
            queue.shift()?.resolve(payload.path)
            break
          case 'error':
            queue.shift()?.reject(new Error(payload.message))
            break
        }
        this.watch(proc)
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[tts_server]', chunk.toString())
        this.watch(proc)
      })

      proc.on('exit', (code) => {
        // Seulement s'il est encore le programme en cours : un nouveau, lancé juste après, reste en place.
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
          this.watch(proc)
        }
        const err = new Error(t('voice.ttsStoppedEarly', { code: String(code) }))
        if (!settled) rejectReady(err)
        for (const pending of queue.splice(0)) pending.reject(err)
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
    const proc = this.proc
    // Sorti entre-temps (la sortie a déjà rejeté les phrases en attente) : jamais une phrase écrite dans le vide.
    if (!proc) throw new Error(t('voice.ttsStoppedEarly', { code: '?' }))
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      // La première phrase en attente lance la surveillance ; les suivantes attendent leur tour sous la même.
      if (this.queue.length === 1) this.watch(proc)
      // Étape 293 : la langue de Jaris à chaque phrase (codes ISO identiques à ceux de Supertonic), sans relancer la voix.
      const request = { text: text.replace(/\n/g, ' '), voice, lang: currentLanguage() }
      proc.stdin.write(JSON.stringify(request) + '\n')
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }
}

export const ttsClient = new TtsClient()
