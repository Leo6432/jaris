import type { Messages } from '../../shared/i18n'
import type { LanguageCode } from '../../shared/i18n/languages'
import bg from '../../shared/i18n/locales/bg.json'
import cs from '../../shared/i18n/locales/cs.json'
import da from '../../shared/i18n/locales/da.json'
import de from '../../shared/i18n/locales/de.json'
import el from '../../shared/i18n/locales/el.json'
import en from '../../shared/i18n/locales/en.json'
import es from '../../shared/i18n/locales/es.json'
import et from '../../shared/i18n/locales/et.json'
import fi from '../../shared/i18n/locales/fi.json'
import hr from '../../shared/i18n/locales/hr.json'
import hu from '../../shared/i18n/locales/hu.json'
import it from '../../shared/i18n/locales/it.json'
import lt from '../../shared/i18n/locales/lt.json'
import lv from '../../shared/i18n/locales/lv.json'
import nl from '../../shared/i18n/locales/nl.json'
import pl from '../../shared/i18n/locales/pl.json'
import pt from '../../shared/i18n/locales/pt.json'
import ro from '../../shared/i18n/locales/ro.json'
import ru from '../../shared/i18n/locales/ru.json'
import sk from '../../shared/i18n/locales/sk.json'
import sl from '../../shared/i18n/locales/sl.json'
import sv from '../../shared/i18n/locales/sv.json'
import uk from '../../shared/i18n/locales/uk.json'

/**
 * Les 23 traductions, embarquées dans le processus principal (quelques Mo au total) : c'est LUI qui choisit la langue
 * puis envoie aux fenêtres le seul catalogue utile, plutôt que de charger les 24 langues dans chaque écran. Le
 * français n'y est pas : c'est le catalogue source (shared/i18n/fr.ts), déjà présent partout.
 */
const LOCALES: Record<Exclude<LanguageCode, 'fr'>, Messages> = { bg, cs, da, de, el, en, es, et, fi, hr, hu, it, lt, lv, nl, pl, pt, ro, ru, sk, sl, sv, uk }

export function localeMessages(code: LanguageCode): Messages {
  return code === 'fr' ? {} : LOCALES[code]
}
