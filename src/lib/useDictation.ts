import { useEffect, useRef, useState } from 'react'
import { DICTATION_MAX_MS, DictationRecorder } from '@/lib/dictation'
import { ipcErrorMessage } from '@/lib/ipcError'
import { t } from '@/lib/i18n'

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

/**
 * Étape 276 (micro du Chat) puis étape 450 (Duel Vocal, Léo : « parler et pas écrire, mais toujours le duel avec
 * 2 modèles ») : UNE seule dictée pour tous les écrans — un clic enregistre, un second arrête, le son part au
 * programme d'écoute de Jaris (Parakeet) et revient en texte. Ce que l'écran fait du texte (l'ajouter au champ, ou
 * l'envoyer tout de suite) est son affaire : `onText`.
 *
 * Garde-fous repris tels quels du champ du Chat :
 * - étape 346 : un double-clic ouvrait deux fois le micro (l'état React n'a pas encore changé au second clic), le
 *   premier enregistreur restait ouvert, micro allumé ;
 * - écran quitté en pleine dictée : le micro est rendu à Windows, rien n'est transcrit ;
 * - longue dictée arrêtée toute seule avant la limite de taille acceptée par Jaris.
 */
export function useDictation({
  onText,
  onError,
  onDone
}: {
  /** Texte transcrit, jamais vide. */
  onText: (text: string) => void
  onError: (message: string) => void
  /** Après chaque dictée, réussie ou non (le champ du Chat y reprend le focus). */
  onDone?: () => void
}): { state: DictationState; seconds: number; available: boolean; toggle: () => Promise<void> } {
  const [state, setState] = useState<DictationState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<DictationRecorder | null>(null)
  const startingRef = useRef(false)
  const mountedRef = useRef(true)
  const timers = useRef<{ stop?: number; tick?: number }>({})
  // Les rappels les plus récents : une dictée commencée avant un nouveau rendu envoie son texte à l'écran actuel.
  const callbacks = useRef({ onText, onError, onDone })
  callbacks.current = { onText, onError, onDone }
  const available = typeof window !== 'undefined' && typeof window.jaris?.transcribeDictation === 'function'

  const clearTimers = (): void => {
    window.clearTimeout(timers.current.stop)
    window.clearInterval(timers.current.tick)
    timers.current = {}
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimers()
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

  const finish = async (): Promise<void> => {
    const recorder = recorderRef.current
    recorderRef.current = null
    clearTimers()
    if (!recorder) return
    const wav = recorder.stop()
    if (!wav) {
      setState('idle')
      return
    }
    setState('transcribing')
    try {
      const text = await window.jaris.transcribeDictation(wav)
      if (text) callbacks.current.onText(text)
      else callbacks.current.onError(t('composer.dictation.nothing'))
    } catch (err) {
      callbacks.current.onError(ipcErrorMessage(err))
    } finally {
      setState('idle')
      callbacks.current.onDone?.()
    }
  }

  const toggle = async (): Promise<void> => {
    if (state === 'recording' && recorderRef.current) return finish()
    if (state !== 'idle' || startingRef.current) return
    startingRef.current = true
    setState('starting')
    let recorder: DictationRecorder
    try {
      recorder = await DictationRecorder.start()
    } catch (err) {
      startingRef.current = false
      if (mountedRef.current) {
        setState('idle')
        callbacks.current.onError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    startingRef.current = false
    // Écran fermé pendant l'ouverture du micro : on le referme aussitôt, rien ne doit rester allumé.
    if (!mountedRef.current) {
      recorder.cancel()
      return
    }
    // Un enregistreur oublié (ne devrait plus arriver) est fermé avant d'en garder un autre.
    recorderRef.current?.cancel()
    clearTimers()
    recorderRef.current = recorder
    setState('recording')
    setSeconds(0)
    const startedAt = Date.now()
    timers.current = {
      tick: window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500),
      stop: window.setTimeout(() => void finish(), DICTATION_MAX_MS)
    }
  }

  return { state, seconds, available, toggle }
}
