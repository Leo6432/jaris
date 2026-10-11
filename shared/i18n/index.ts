import { fr } from './fr'
import { languageInfo, type LanguageCode } from './languages'

/**
 * Le traducteur de Jaris, partagé par le processus principal ET les écrans : chacun a sa propre copie de ce module,
 * réglée sur la même langue (le principal la choisit, puis l'envoie aux fenêtres). Le catalogue français (`fr.ts`)
 * est la SOURCE : chaque clé y est définie, et les 23 autres langues (`locales/*.json`) en sont la traduction, clé par
 * clé — un test vérifie qu'aucune ne manque, qu'aucune n'est en trop et que les mêmes {variables} y figurent.
 *
 * Par défaut (avant tout réglage, et dans les tests), c'est le français : le comportement historique de Jaris.
 */
export type MessageKey = keyof typeof fr
/** Les clés à pluriel : `xxx_one`/`xxx_other` en français, plus `_few`/`_many`/`_two`/`_zero` selon la langue. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}_other` ? Base : never }[MessageKey]
export type Messages = Partial<Record<string, string>>
export type Vars = Record<string, string | number>

interface State {
  code: LanguageCode
  locale: string
  messages: Messages
  plural: Intl.PluralRules
}

let state: State = { code: 'fr', locale: 'fr-FR', messages: fr, plural: new Intl.PluralRules('fr-FR') }
const listeners = new Set<() => void>()
/** Toutes les langues connues de ce processus (le principal les enregistre toutes ; un écran n'a que la sienne). */
let catalogs: Messages[] = [fr]

/** Le processus principal enregistre ici les 23 traductions, pour reconnaître un texte écrit dans n'importe laquelle. */
export function registerCatalogs(list: Messages[]): void {
  catalogs = [fr, ...list]
}

/**
 * Le même texte dans toutes les langues connues : sert à RECONNAÎTRE une phrase de Jaris déjà enregistrée (dans
 * l'historique) quelle que soit la langue dans laquelle elle a été écrite — l'utilisateur peut changer de langue
 * entre deux conversations.
 */
export function allTranslations(key: MessageKey): string[] {
  return [...new Set(catalogs.map((messages) => messages[key]).filter((text): text is string => typeof text === 'string'))]
}

/** Change la langue de ce processus. `messages` absent = le français source (seule langue embarquée partout). */
export function setLanguage(code: LanguageCode, messages?: Messages): void {
  const locale = languageInfo(code).locale
  state = { code, locale, messages: code === 'fr' ? fr : messages ?? fr, plural: new Intl.PluralRules(locale) }
  for (const listener of listeners) listener()
}

export function currentLanguage(): LanguageCode {
  return state.code
}

/** Le nom anglais de la langue courante (« German ») : c'est lui qu'on donne aux modèles pour la langue de réponse. */
export function replyLanguageName(): string {
  return languageInfo(state.code).english
}

/**
 * La consigne de langue à AJOUTER à des consignes écrites en français pour un modèle : vide en français (consignes
 * inchangées), sinon une phrase qui impose la langue de l'utilisateur.
 */
export function replyLanguageRule(): string {
  const name = replyLanguageName()
  return name === 'French' ? '' : ` Réponds TOUJOURS en ${name} (la langue de l'utilisateur), même si ces consignes sont écrites en français.`
}

/** L'étiquette BCP 47 (« de-DE ») pour les dates et les nombres. */
export function currentLocale(): string {
  return state.locale
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Remplace chaque {nom} par sa valeur ; un {nom} sans valeur reste tel quel (repérable, jamais « undefined »). */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

function lookup(key: string): string {
  // Une clé absente d'une langue retombe sur le français plutôt que d'afficher la clé brute : le test de complétude
  // empêche ce cas d'être livré, ce repli évite seulement qu'un oubli devienne un écran illisible.
  return state.messages[key] ?? (fr as Messages)[key] ?? key
}

export function t(key: MessageKey, vars?: Vars): string {
  return interpolate(lookup(key), vars)
}

/**
 * Texte au pluriel : la catégorie (one, few, many, other…) est celle de la langue courante pour ce nombre, d'après
 * Intl.PluralRules — le polonais, le russe ou le tchèque n'ont pas les mêmes règles que le français (« 2 pliki »,
 * « 5 plików »). {count} est fourni d'office, écrit à la façon de la langue (« 1 234 », « 1,234 »).
 */
export function tn(key: PluralKey, count: number, vars?: Vars): string {
  const category = state.plural.select(count)
  const template = state.messages[`${key}_${category}`] ?? state.messages[`${key}_other`] ?? lookup(`${key}_other`)
  return interpolate(template, { count: new Intl.NumberFormat(state.locale).format(count), ...vars })
}
