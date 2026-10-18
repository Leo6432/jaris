import { app } from 'electron'
import { join } from 'path'
import { registerCatalogs, setLanguage } from '../../shared/i18n'
import { LANGUAGES, isLanguageSetting, matchSystemLanguage, resolveLanguage, type LanguageCode, type LanguageSetting } from '../../shared/i18n/languages'
import type { LanguageState } from '../../shared/ipc'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
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
  // Étape 325 : un fichier abîmé est rangé de côté (fichiers-illisibles) avant de repartir sur la langue de Windows,
  // jamais remplacé en silence au prochain choix. Momentanément illisible : langue de Windows pour cette fois, sans
  // rien réécrire.
  try {
    const read = await readJsonDataFile(
      settingPath(),
      (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { setting?: unknown }) : null),
      join(getDataRoot(), UNREADABLE_DATA_DIR),
      'language'
    )
    return apply(read.status === 'ok' && isLanguageSetting(read.value.setting) ? read.value.setting : 'auto')
  } catch {
    return apply('auto')
  }
}

export async function saveLanguageSetting(next: LanguageSetting): Promise<LanguageState> {
  if (!isLanguageSetting(next)) throw new Error(`Langue inconnue : ${String(next)}`)
  apply(next)
  // D'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancien choix intact.
  await writeFileAtomic(settingPath(), JSON.stringify({ setting: next }, null, 2))
  return languageState()
}
