/**
 * Étape 133, Léo : "met pas ai9stars_G9v3-3B mais G9v3-3B". Le nom de dépôt choisi par bartowski pour sa
 * requantification GGUF embarque le nom de l'organisation d'origine dans le nom du dépôt lui-même
 * ("ai9stars_G9v3-3B-GGUF", pas "G9v3-3B-GGUF" tout court) — l'algorithme générique ci-dessous (qui retire
 * juste le suffixe "-GGUF") ne peut pas deviner que "ai9stars_" est un préfixe d'organisation à retirer
 * plutôt qu'une partie du vrai nom : un modèle appelé légitimement "Org_Something" existe tout aussi bien.
 * Table d'exceptions EXPLICITE (un identifiant exact -> son nom d'affichage), pas une règle générique
 * ("retirer tout ce qui précède un underscore") qui pourrait mal couper un futur import dont le nom
 * contient légitimement un underscore.
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF': 'G9v3-3B'
}

/**
 * Nom affiché à l'utilisateur pour un identifiant de modèle Ollama, qui reste lui-même inchangé partout
 * ailleurs (ollama pull/run, verified-tool-scores.md...) — seulement pour l'affichage. Les tags "hf.co/<org>/
 * <dépôt>[:<quant>]" (imports directs depuis Hugging Face, voir hardwareScan.ts pour pourquoi) sont bien
 * plus longs et moins lisibles que les tags de la bibliothèque Ollama officielle (ex: "qwen3.5:9b") — ceux-ci
 * restent affichés tels quels, rien à raccourcir.
 */
export function formatModelName(rawModel: string): string {
  // Ollama liste un modèle installé sans tag sous `:latest` (étape 141, sélecteur de modèle) : même modèle,
  // même nom affiché — sinon G9v3-3B redevenait « ai9stars_G9v3-3B (latest) » dans la liste.
  const model = rawModel.endsWith(':latest') ? rawModel.slice(0, -':latest'.length) : rawModel
  if (model in DISPLAY_NAME_OVERRIDES) return DISPLAY_NAME_OVERRIDES[model]
  if (!model.startsWith('hf.co/')) return model
  const afterOrg = model.split('/').slice(2).join('/')
  const [namePart, quant] = afterOrg.split(':')
  const cleanName = namePart.replace(/-GGUF$/i, '')
  return quant ? `${cleanName} (${quant})` : cleanName
}
