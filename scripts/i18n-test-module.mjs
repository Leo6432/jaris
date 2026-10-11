import { i18nModules } from './load-ts-module.mjs'

/** Le vrai traducteur (voir load-ts-module.mjs), pour les faux ponts de modules écrits à la main dans les tests. */
export const I18N_MODULES = i18nModules()
export const i18nModule = I18N_MODULES['../../shared/i18n']
export const languagesModule = I18N_MODULES['../../shared/i18n/languages']

/** Enveloppe un `require` de faux pont : les imports du traducteur d'abord, le reste comme avant. */
export function withI18n(require) {
  return (name) => (name in I18N_MODULES ? I18N_MODULES[name] : require(name))
}
