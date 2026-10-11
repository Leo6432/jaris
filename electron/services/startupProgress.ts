import { EventEmitter } from 'events'
import type { StartupState, StartupStepId, StartupStepState } from '../../shared/ipc'

/** Dans l'ordre où l'écran de démarrage les annonce. */
export const STARTUP_STEPS: readonly StartupStepId[] = ['engine', 'listening', 'voice', 'brain']

/**
 * Au-delà, Jaris s'affiche quand même et finit de se préparer en arrière-plan : un premier lancement peut
 * télécharger la transcription (~2,5 Go) ou attendre un Ollama qui ne démarre pas — l'écran de démarrage ne doit
 * jamais devenir un écran bloqué.
 */
export const STARTUP_DEADLINE_MS = 90_000

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const TERMINAL: ReadonlySet<StartupStepState> = new Set(['done', 'failed'])

/**
 * Étape 294 — ce qui reste à préparer avant d'afficher Jaris. Une étape qui ÉCHOUE compte comme terminée : elle ne
 * doit pas retenir l'écran indéfiniment (Jaris s'affiche, et ses messages habituels disent ce qui manque). Une étape
 * terminée ne revient jamais en arrière : le moteur vocal relancé plus tard (changement de micro) ne rouvre pas
 * l'écran de démarrage. Émet `change` à chaque évolution et `ready` une seule fois.
 */
export class StartupProgress extends EventEmitter {
  private readonly steps = new Map<StartupStepId, StartupStepState>()
  private timedOut = false
  private readyEmitted = false
  private readonly timer: unknown

  constructor(
    ids: readonly StartupStepId[] = STARTUP_STEPS,
    deadlineMs = STARTUP_DEADLINE_MS,
    private readonly timers: Timers = { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  ) {
    super()
    for (const id of ids) this.steps.set(id, 'pending')
    this.timer = timers.setTimeout(() => {
      if (this.readyEmitted) return
      this.timedOut = true
      this.changed()
    }, deadlineMs)
  }

  set(id: StartupStepId, state: StartupStepState): void {
    const current = this.steps.get(id)
    if (current === undefined || current === state || TERMINAL.has(current)) return
    this.steps.set(id, state)
    this.changed()
  }

  /** Marque l'étape en cours, puis terminée selon le résultat — une exception compte comme un échec. */
  track(id: StartupStepId, work: Promise<boolean>): void {
    this.set(id, 'running')
    work.then(
      (ok) => this.set(id, ok ? 'done' : 'failed'),
      () => this.set(id, 'failed')
    )
  }

  get ready(): boolean {
    return this.timedOut || [...this.steps.values()].every((state) => TERMINAL.has(state))
  }

  state(): StartupState {
    return { ready: this.ready, timedOut: this.timedOut && !this.allTerminal(), steps: [...this.steps].map(([id, state]) => ({ id, state })) }
  }

  /** Appelle `fn` dès que Jaris peut s'afficher (tout de suite si c'est déjà le cas). */
  whenReady(fn: () => void): void {
    if (this.readyEmitted) fn()
    else this.once('ready', fn)
  }

  private allTerminal(): boolean {
    return [...this.steps.values()].every((state) => TERMINAL.has(state))
  }

  private changed(): void {
    const state = this.state()
    this.emit('change', state)
    if (state.ready && !this.readyEmitted) {
      this.readyEmitted = true
      this.timers.clearTimeout(this.timer)
      this.emit('ready', state)
    }
  }
}
