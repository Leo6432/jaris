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
    return 'Recherche sur internet…'
  }
  if (/^Outil appelé : read_web_page\b/i.test(trimmed)) return 'Lecture de la page…'
  if (/^Outil appelé : look_at_screen\b/i.test(trimmed)) return "Lecture de l'écran…"
  if (/^Outil appelé : computer_use_task\b/i.test(trimmed)) return "Action en cours sur l'écran…"

  if (
    /^(?:Résultat de l'outil|Outil appelé|Outil [«"]|Modèle choisi|Appel d'outil détecté|Mail demandé mais jamais envoyé|Action annoncée sans appel d'outil|Réponse sociale courte|VRAM libre actuelle|GPU à)/i.test(trimmed)
  ) {
    return null
  }

  return trimmed
}
