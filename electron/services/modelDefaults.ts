/**
 * Étape 469 : réglages par défaut d'un modèle importé de Hugging Face qui n'en apporte aucun. Un GGUF de Hugging Face
 * arrive sans les réglages que le modèle officiel d'Ollama embarque : Ollama appliquerait alors les siens, et le modèle
 * ne serait plus comparable à l'original (pour Qwen3.5, sans presence_penalty, il tourne bien plus en rond).
 *
 * Qwen3.5-0.8B corrigé (Weight-Space Programming) : les réglages EXACTS du `qwen3.5:0.8b` officiel, lus dans le registre
 * d'Ollama le 11/11/2026 (couche params : presence_penalty 1.5, temperature 1, top_k 20, top_p 0.95 — draft_num_predict
 * ne sert qu'au modèle de brouillon officiel, absent ici). Ce sont aussi ceux de l'évaluation de l'article.
 *
 * Appliqués à UN endroit par où passe toute installation par Jaris (pullModelIfMissing), et recopiés dans
 * scripts/benchmark-models.mjs (vérifié par test) : `/api/create` depuis le modèle lui-même, sous le MÊME nom — seuls
 * les réglages changent, les fichiers (modèle et lecteur d'images) restent les mêmes. Vérifié avec un vrai Ollama 0.40.16.
 */
export const MODEL_DEFAULT_PARAMETERS: Record<string, Record<string, number>> = {
  'hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0': {
    presence_penalty: 1.5,
    temperature: 1,
    top_k: 20,
    top_p: 0.95
  }
}

/** Applique les réglages du tableau ci-dessus (rien pour un modèle absent). Rejette avec le vrai message d'Ollama. */
export async function applyModelDefaults(host: string, model: string): Promise<void> {
  const parameters = MODEL_DEFAULT_PARAMETERS[model]
  if (!parameters) return
  const response = await fetch(`${host}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, from: model, parameters, stream: false })
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { error?: string }).error ?? ''
    } catch {
      // corps illisible : le code HTTP seul reste l'information utile
    }
    throw new Error(`${model} : réglages non appliqués (${response.status}${detail ? ` : ${detail}` : ''})`)
  }
}
