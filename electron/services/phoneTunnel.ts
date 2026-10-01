import { spawn, type ChildProcessByStdio } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { createInterface } from 'readline'
import type { Readable, Writable } from 'stream'

/** État du tunnel, sans les appareils (ajoutés par phoneAccessManager). */
export type TunnelState =
  | { state: 'off' }
  | { state: 'starting'; message?: string }
  | { state: 'login'; actionUrl: string }
  | { state: 'enable_funnel'; actionUrl?: string; message?: string }
  | { state: 'ready'; address: string; warning?: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; message: string }

type TunnelEvent =
  | { event: 'starting' }
  | { event: 'login'; url: string }
  | { event: 'enable_funnel'; url?: string; text?: string }
  | { event: 'preparing'; text: string }
  | { event: 'ready'; url: string; warning?: string }
  | { event: 'tls_error'; message: string }
  | { event: 'error'; message: string }
  | { event: 'logged_out' }

type TunnelProcess = ChildProcessByStdio<Writable, Readable, Readable>

/** Seules des adresses HTTPS de Tailscale sont ouvertes dans le navigateur ou montrées comme « ton adresse ». */
export function isTailscaleUrl(value: string, kind: 'action' | 'address'): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    return kind === 'address' ? url.hostname.endsWith('.ts.net') : url.hostname === 'login.tailscale.com' || url.hostname.endsWith('.tailscale.com')
  } catch {
    return false
  }
}

/**
 * Lance et suit jaris-tunnel (étape 214, voir tunnel/main.go). Le programme Go parle par lignes JSON ; ici on
 * les transforme en un état simple pour l'écran Options → Téléphone. Fermer son entrée standard l'arrête :
 * le tunnel ne survit jamais à Jaris.
 */
export class PhoneTunnel extends EventEmitter {
  private proc: TunnelProcess | null = null
  private current: TunnelState = { state: 'off' }

  constructor(
    private readonly binaryPath: string,
    private readonly stateDir: string,
    private readonly spawnFn: typeof spawn = spawn
  ) {
    super()
  }

  get state(): TunnelState {
    return this.current
  }

  private set(next: TunnelState): void {
    this.current = next
    this.emit('change', next)
  }

  private run(args: string[], onEvent: (event: TunnelEvent) => void): TunnelProcess | null {
    if (!existsSync(this.binaryPath)) {
      this.set({ state: 'unsupported', message: "Le module téléphone n'est pas présent dans cette installation de Jaris." })
      return null
    }
    const proc = this.spawnFn(this.binaryPath, ['--state', this.stateDir, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      try {
        onEvent(JSON.parse(line) as TunnelEvent)
      } catch {
        // ligne non JSON : ignorée
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => console.error('[jaris-tunnel]', chunk.toString()))
    return proc as TunnelProcess
  }

  /** Démarre le tunnel vers le serveur local (127.0.0.1:port). Sans effet s'il tourne déjà. */
  start(localPort: number): void {
    if (this.proc) return
    this.set({ state: 'starting' })
    const proc = this.run(['--target', `127.0.0.1:${localPort}`], (event) => {
      if (this.proc !== proc) return
      switch (event.event) {
        case 'starting':
          this.set({ state: 'starting' })
          break
        case 'login':
          if (isTailscaleUrl(event.url, 'action')) this.set({ state: 'login', actionUrl: event.url })
          break
        case 'enable_funnel':
          this.set({
            state: 'enable_funnel',
            ...(event.url && isTailscaleUrl(event.url, 'action') ? { actionUrl: event.url } : {}),
            ...(event.text ? { message: event.text } : {})
          })
          break
        case 'preparing':
          this.set({ state: 'starting', message: event.text })
          break
        case 'ready':
          if (isTailscaleUrl(event.url, 'address')) this.set({ state: 'ready', address: event.url, ...(event.warning ? { warning: event.warning } : {}) })
          else this.set({ state: 'error', message: `Adresse inattendue reçue de Tailscale : ${event.url}` })
          break
        case 'tls_error':
          // Une connexion sécurisée a échoué (téléphone ou vérification) : on le dit au lieu de le cacher.
          if (this.current.state === 'ready') this.set({ ...this.current, warning: `Connexion sécurisée refusée : ${event.message}` })
          else if (this.current.state === 'starting') this.set({ state: 'starting', message: `${this.current.message ?? 'Démarrage…'} (dernière erreur : ${event.message})` })
          break
        case 'error':
          this.set({ state: 'error', message: event.message })
          break
      }
    })
    if (!proc) return
    this.proc = proc
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      if (this.current.state !== 'error' && this.current.state !== 'off') {
        this.set({ state: 'error', message: `Le tunnel s'est arrêté (code ${code}).` })
      }
    })
    proc.on('error', (err) => {
      if (this.proc !== proc) return
      this.proc = null
      this.set({ state: 'error', message: err.message })
    })
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    if (proc) {
      proc.stdin.end()
      setTimeout(() => proc.kill(), 3000).unref()
    }
    this.set({ state: 'off' })
  }

  /** Déconnecte ce PC du compte Tailscale (il faudra se reconnecter pour réactiver). */
  logout(): Promise<void> {
    this.stop()
    return new Promise((resolve, reject) => {
      let done = false
      const proc = this.run(['--logout'], (event) => {
        if (event.event === 'logged_out') {
          done = true
          resolve()
        } else if (event.event === 'error') {
          done = true
          reject(new Error(event.message))
        }
      })
      if (!proc) {
        resolve()
        return
      }
      proc.on('exit', () => {
        if (!done) resolve()
      })
      proc.on('error', (err) => {
        if (!done) reject(err)
      })
      setTimeout(() => {
        if (!done) proc.kill()
      }, 30_000).unref()
    })
  }
}
