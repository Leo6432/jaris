import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { registerCatalogs, setLanguage } from '../../shared/i18n'
import { LANGUAGES, isLanguageSetting, matchSystemLanguage, resolveLanguage, type LanguageCode, type LanguageSetting } from '../../shared/i18n/languages'
import type { LanguageState } from '../../shared/ipc'
import { getDataRoot } from './dataLocation'
import { localeMessages } from './locales'

/**
 * Langue de Jaris côté processus principal. Le choix est rangé dans son PROPRE petit fichier (language.json), pas dans
 * profile.json : le profil est réécrit en entier par l'écran à chaque réglage, avec la copie qu'il avait lue —
 * une langue changée entre-temps aurait été écrasée par l'ancienne valeur. Et la langue doit exister avant même le
 * profil (le tout premier écran, celui qui demande le prénom, est déjà traduit).
 */
const settingPath = (): string => join(getDataRoot(), 'language.json')

let setting: LanguageSetting = 'auto'

// Toutes les langues, pour reconnaître une phrase de Jaris déjà écrite dans une autre (allTranslations).
registerCatalogs(LANGUAGES.filter((language) => language.code !== 'fr').map((language) => localeMessages(language.code)))

/** Les langues de Windows, dans l'ordre de préférence de l'utilisateur (« fr-FR », « en-US »…). */
export function systemLanguageTags(): string[] {
  try {
    const preferred = app.getPreferredSystemLanguages()
    if (preferred.length > 0) return preferred
  } catch {
    // Rien : on retombe sur la langue de l'interface d'Electron, puis sur l'anglais.
  }
  try {
    return [app.getLocale()]
  } catch {
    return []
  }
}

function apply(next: LanguageSetting): LanguageCode {
  setting = next
  const code = resolveLanguage(next, systemLanguageTags())
  setLanguage(code, localeMessages(code))
  return code
}

export function languageState(): LanguageState {
  const code = resolveLanguage(setting, systemLanguageTags())
  return { setting, code, systemCode: matchSystemLanguage(systemLanguageTags()), messages: localeMessages(code) as Record<string, string> }
}

/** Au démarrage, AVANT la première fenêtre et le menu de la barre système : tout naît dans la bonne langue. */
export async function loadLanguageSetting(): Promise<LanguageCode> {
  try {
    const saved = JSON.parse(await readFile(settingPath(), 'utf-8')) as { setting?: unknown }
    return apply(isLanguageSetting(saved.setting) ? saved.setting : 'auto')
  } catch {
    return apply('auto')
  }
}

export async function saveLanguageSetting(next: LanguageSetting): Promise<LanguageState> {
  if (!isLanguageSetting(next)) throw new Error(`Langue inconnue : ${String(next)}`)
  apply(next)
  await mkdir(dirname(settingPath()), { recursive: true })
  await writeFile(settingPath(), JSON.stringify({ setting: next }, null, 2), 'utf-8')
  return languageState()
}
