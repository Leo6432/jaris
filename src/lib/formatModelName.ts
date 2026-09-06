/**
 * Nom affiché à l'utilisateur pour un identifiant de modèle Ollama, qui reste lui-même inchangé partout
 * ailleurs (ollama pull/run, verified-tool-scores.md...) — seulement pour l'affichage. Les tags "hf.co/<org>/
 * <dépôt>[:<quant>]" (imports directs depuis Hugging Face, voir hardwareScan.ts pour pourquoi) sont bien
 * plus longs et moins lisibles que les tags de la bibliothèque Ollama officielle (ex: "qwen3.5:9b") — ceux-ci
 * restent affichés tels quels, rien à raccourcir.
 */
export function formatModelName(model: string): string {
  if (!model.startsWith('hf.co/')) return model
  const afterOrg = model.split('/').slice(2).join('/')
  const [namePart, quant] = afterOrg.split(':')
  const cleanName = namePart.replace(/-GGUF$/i, '')
  return quant ? `${cleanName} (${quant})` : cleanName
}
