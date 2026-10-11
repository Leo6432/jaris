import { t } from '../../shared/i18n'
import { activityFromLog } from '../../shared/voiceActivity'
/**
 * Les journaux du moteur servent au diagnostic, mais le Chat et son widget ne doivent jamais afficher des
 * détails internes comme `Outil appelé : search_web(...)` ou le contenu brut de `Résultat de l'outil`.
 * On conserve seulement une indication utile et humaine pendant l'attente. `null` signifie : ignorer cette
 * ligne et garder l'indication précédente jusqu'à la réponse finale.
 */
export function formatChatProgress(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed) return null

  if (/^(?:Question de connaissance sans recherche web|Outil appelé : search_web\b)/i.test(trimmed)) {
    return t('progress.searching')
  }
  if (/^Outil appelé : read_web_page\b/i.test(trimmed)) return t('progress.readingPage')
  if (/^Outil appelé : look_at_screen\b/i.test(trimmed)) return t('progress.readingScreen')
  if (/^Outil appelé : computer_use_task\b/i.test(trimmed) || /^Action à l'écran demandée/u.test(trimmed)) return t('progress.acting')
  // Étape 293 : une étape du pilotage (« Étape 2/20 : clic sur … ») est une ligne du journal, en français : elle
  // s'affiche par sa phrase traduite, ou pas du tout.
  if (/^Étape \d+\/\d+ :/u.test(trimmed)) return activityFromLog(trimmed)

  if (
    /^(?:Résultat de l'outil|Outil appelé|Outil refusé|Outil [«"]|Modèle choisi|Appel d'outil détecté|Mail demandé mais jamais envoyé|Action annoncée sans appel d'outil|Réponse sociale courte|VRAM libre actuelle|GPU à|Phrase captée|Réflexion relancée|Voix —|Erreur de synthèse|Erreur Ollama)/i.test(trimmed)
  ) {
    return null
  }

  return trimmed
}
