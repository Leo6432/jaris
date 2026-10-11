import { useEffect, useState } from 'react'
import JarisOrb from '@/components/JarisOrb'
import { t } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'
import type { StartupState, StartupStepId } from '../../shared/ipc'

const STEP_LABEL: Record<StartupStepId, MessageKey> = {
  engine: 'startup.step.engine',
  listening: 'startup.step.listening',
  voice: 'startup.step.voice',
  brain: 'startup.step.brain'
}

/** Étape 295 (Léo : « augmente un peu la taille de l'orbe ») : l'orbe porte la carte, le texte reste discret. */
export const STARTUP_ORB_SIZE = 176

const isTerminal = (state: string): boolean => state === 'done' || state === 'failed'

/**
 * Ce que l'écran annonce : la première étape pas encore terminée, dans l'ordre du démarrage (« Démarrage du
 * moteur… », puis l'écoute, la voix, le modèle), et « Prêt » à la fin. Avant la première réponse du processus
 * principal, la toute première étape.
 */
export function startupHeadline(state: StartupState | null): MessageKey {
  if (!state) return STEP_LABEL.engine
  if (state.ready) return 'startup.ready'
  const next = state.steps.find((step) => !isTerminal(step.state))
  return next ? STEP_LABEL[next.id] : 'startup.ready'
}

/** Part des étapes terminées, de 0 à 1 (1 dès que Jaris peut s'afficher, même après le délai maximal). */
export function startupFraction(state: StartupState | null): number {
  if (!state || state.steps.length === 0) return 0
  if (state.ready) return 1
  return state.steps.filter((step) => isTerminal(step.state)).length / state.steps.length
}

/**
 * Étape 294 — l'écran de démarrage, façon ChatGPT (Léo : « fais une petite animation de démarrage, comme ChatGPT…
 * je veux que ça se lance quand tout est ok »). L'orbe de Jaris s'anime au centre pendant que le moteur, l'écoute,
 * la voix et le modèle se préparent ; dès que tout est prêt, la carte s'efface et Jaris apparaît à sa place (le
 * processus principal ferme cette fenêtre juste après l'animation de sortie).
 */
export default function StartupSplash(): JSX.Element {
  const [state, setState] = useState<StartupState | null>(null)

  useEffect(() => {
    // Fenêtre Electron transparente : seule la carte se dessine, avec une marge qui la décolle des bords (un bord
    // arrondi collé au bord d'une fenêtre transparente laisse un coin carré sous Windows, voir CLAUDE.md).
    document.documentElement.classList.add('body--splash')
    document.body.classList.add('body--splash')
    void window.jaris.getStartupState().then(setState)
    return window.jaris.onStartupState(setState)
  }, [])

  const headline = t(startupHeadline(state))
  const fraction = startupFraction(state)
  return (
    <div className={`startup${state?.ready ? ' startup--leaving' : ''}`}>
      <div className="startup__card" role="status" aria-live="polite" aria-label={t('startup.aria')}>
        <JarisOrb emotion="idle" size={STARTUP_ORB_SIZE} />
        <div className="startup__name">Jaris</div>
        {/* La clé rejoue le fondu à chaque nouvelle étape annoncée. */}
        <div className="startup__step" key={headline}>
          {headline}
        </div>
        <div className="startup__bar" aria-hidden="true">
          <div className="startup__bar-fill" style={{ transform: `scaleX(${fraction})` }} />
        </div>
      </div>
    </div>
  )
}
