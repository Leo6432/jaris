import { useSyncExternalStore } from 'react'
import { currentLanguage, setLanguage, subscribeLanguage } from '../../shared/i18n'
import type { LanguageCode } from '../../shared/i18n/languages'
import type { LanguageState } from '../../shared/ipc'

export { currentLocale, t, tn } from '../../shared/i18n'

function apply(state: LanguageState): void {
  setLanguage(state.code, state.messages)
  document.documentElement.lang = state.code
}

/**
 * À appeler UNE fois, avant le premier rendu : la langue est lue de façon synchrone auprès du processus principal,
 * donc la toute première image est déjà traduite. Ensuite, un changement dans les réglages (de n'importe quelle
 * fenêtre) arrive par `onLanguageChanged` et retraduit tout. Sans pont (tests), l'écran reste en français.
 */
export function initRendererLanguage(): void {
  const bridge = typeof window !== 'undefined' ? window.jaris : undefined
  const state = bridge?.getLanguageState?.()
  if (state) apply(state)
  bridge?.onLanguageChanged?.(apply)
}

/** La langue courante ; un composant qui l'appelle se redessine quand elle change. */
export function useLanguage(): LanguageCode {
  return useSyncExternalStore(subscribeLanguage, currentLanguage)
}
