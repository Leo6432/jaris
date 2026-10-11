/**
 * Les langues de Jaris (Léo : « jaris doit détecter la langue de Windows et traduire jaris, et sinon tu peux changer
 * dans les paramètres »). Exactement les 24 langues où la VOIX marche de bout en bout : la transcription du micro
 * (Parakeet TDT 0.6B v3, 25 langues européennes) ET la synthèse vocale (Supertonic 1.3.1, 31 langues) — le maltais,
 * seul à manquer côté synthèse, est donc absent. Proposer une langue où Jaris ne pourrait ni entendre ni parler
 * aurait été une promesse fausse dès le premier mot dit à voix haute.
 *
 * `name` est écrit dans la langue elle-même (un Grec cherche « Ελληνικά », pas « Greek ») ; `english` sert à dire au
 * modèle dans quelle langue répondre ; `locale` sert aux dates et aux nombres (Intl) ; `tts` est le code Supertonic.
 */
export const LANGUAGES = [
  { code: 'bg', name: 'Български', english: 'Bulgarian', locale: 'bg-BG' },
  { code: 'cs', name: 'Čeština', english: 'Czech', locale: 'cs-CZ' },
  { code: 'da', name: 'Dansk', english: 'Danish', locale: 'da-DK' },
  { code: 'de', name: 'Deutsch', english: 'German', locale: 'de-DE' },
  { code: 'el', name: 'Ελληνικά', english: 'Greek', locale: 'el-GR' },
  { code: 'en', name: 'English', english: 'English', locale: 'en-US' },
  { code: 'es', name: 'Español', english: 'Spanish', locale: 'es-ES' },
  { code: 'et', name: 'Eesti', english: 'Estonian', locale: 'et-EE' },
  { code: 'fi', name: 'Suomi', english: 'Finnish', locale: 'fi-FI' },
  { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR' },
  { code: 'hr', name: 'Hrvatski', english: 'Croatian', locale: 'hr-HR' },
  { code: 'hu', name: 'Magyar', english: 'Hungarian', locale: 'hu-HU' },
  { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it-IT' },
  { code: 'lt', name: 'Lietuvių', english: 'Lithuanian', locale: 'lt-LT' },
  { code: 'lv', name: 'Latviešu', english: 'Latvian', locale: 'lv-LV' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', locale: 'nl-NL' },
  { code: 'pl', name: 'Polski', english: 'Polish', locale: 'pl-PL' },
  // Portugais du Brésil : la grande majorité des lusophones, et une traduction neutre se lit sans peine au Portugal.
  { code: 'pt', name: 'Português', english: 'Portuguese', locale: 'pt-BR' },
  { code: 'ro', name: 'Română', english: 'Romanian', locale: 'ro-RO' },
  { code: 'ru', name: 'Русский', english: 'Russian', locale: 'ru-RU' },
  { code: 'sk', name: 'Slovenčina', english: 'Slovak', locale: 'sk-SK' },
  { code: 'sl', name: 'Slovenščina', english: 'Slovenian', locale: 'sl-SI' },
  { code: 'sv', name: 'Svenska', english: 'Swedish', locale: 'sv-SE' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian', locale: 'uk-UA' }
] as const

export type LanguageInfo = (typeof LANGUAGES)[number]
export type LanguageCode = LanguageInfo['code']
/** Ce que l'utilisateur a choisi : `auto` suit la langue de Windows, sinon une langue imposée. */
export type LanguageSetting = 'auto' | LanguageCode

/**
 * Langue utilisée quand Windows est dans une langue que Jaris ne parle pas (norvégien, turc, japonais…) : l'anglais,
 * la plus largement comprise. Jamais le français par défaut : un Norvégien lit l'anglais bien plus souvent que lui.
 */
export const FALLBACK_LANGUAGE: LanguageCode = 'en'

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'auto' || isLanguageCode(value)
}

export function languageInfo(code: LanguageCode): LanguageInfo {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES.find((language) => language.code === FALLBACK_LANGUAGE)!
}

/**
 * La première langue de Windows (dans l'ordre de préférence de l'utilisateur) que Jaris parle. On regarde la langue
 * principale de chaque étiquette (« fr-CA » → fr, « pt-BR » → pt) : une variante régionale reste la même langue.
 * Les langues suivantes de la liste comptent aussi — un Suisse romand réglé « rm-CH, fr-CH » obtient le français,
 * pas l'anglais de repli.
 */
export function matchSystemLanguage(tags: readonly string[]): LanguageCode {
  for (const tag of tags) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
    if (isLanguageCode(primary)) return primary
  }
  return FALLBACK_LANGUAGE
}

/** La langue effectivement utilisée : celle choisie dans les réglages, sinon celle de Windows. */
export function resolveLanguage(setting: LanguageSetting | undefined, systemTags: readonly string[]): LanguageCode {
  if (setting && setting !== 'auto' && isLanguageCode(setting)) return setting
  return matchSystemLanguage(systemTags)
}
