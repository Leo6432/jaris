/**
 * Étape 341 (Léo : « ajoute-le dans futur, en bas de tous les modèles, mets en rayure futur modèle ») : modèles
 * repérés mais pas encore candidats de Jaris. Ils s'affichent en bas de « Tous les modèles », sur fond rayé, et
 * ne sont JAMAIS choisis ni proposés au test : ils ne sont dans aucune liste de hardwareScan.ts.
 *
 * Tailles relevées dans le registre d'Ollama (somme des couches du manifeste), comme pour les vrais candidats —
 * `null` (affiché « — ») tant que le modèle n'y est pas : une taille n'est jamais devinée.
 */
export interface FutureModel {
  /** Tag Ollama officiel ; tant que le modèle n'est pas sur Ollama, le nom annoncé par son auteur. */
  model: string
  vramGb: number | null
  readsImages: boolean
  /** Version compressée du tag Ollama ; `null` tant qu'il n'existe pas. */
  quantization: string | null
}

/**
 * Étape 347 (Léo : « enlève bonsai ») : Bonsai 2 27B retiré.
 * Étape 495 (Léo : « mets-le dans futur modèle ») : Olala mini 7A1B d'OVHcloud, annoncé le 17/11/2026 (communiqué
 * officiel : 7 milliards de paramètres dont 1 actif, Differential-TPA + Mamba-3, Apache 2.0, 32 000 jetons de contexte,
 * texte seulement), présenté le 19/11, poids promis sur Hugging Face. Pas encore sur ollama.com (404 vérifié), aucun
 * score publié : à tester dès qu'Ollama sait le faire tourner. Étape 510 (Léo : « enlève olala mini dans future model
 * il est trop nul ») : retiré.
 * Étape 510 (Léo : « Inkling 2 Mini est dingue », puis « met le en futur dans le classement ») : Inkling 2 Mini de
 * Thinking Machines, sorti le 20/11/2026 (26 Md de paramètres, 5,4 Md actifs, Apache 2.0, lit les images). Registre
 * d'Ollama relu : un seul tag (`26b-a5b` = `latest`, digest 4f5569f2774e), au format MLX (NVFP4), 20 188 097 918 octets,
 * `requires: 0.40.17` (préversion) et « Requires a Mac with 32GB+ memory » : Ollama ne le fait pas tourner sous Windows,
 * donc pas candidat. Des GGUF existent (ggml-org/Inkling-2-Mini-GGUF : llama.cpp, Windows compris ; IQ4_NL 17,6 Go) :
 * à tester dès qu'Ollama sait lire l'architecture `inkling2` sous Windows. Ollama 0.40.17 (stable) : « compatible
 * uniquement avec les processeurs Apple Silicon dans cette version. La compatibilité PC sera disponible dans une
 * prochaine version » (notes de version).
 * Étape 511 (Léo : « ajoute Nanbeige4.3-33B aussi dans future model pour que on installe Nanbeige4.3-33B plus l'autre en
 * même temps même s'il est déjà dispo ») : Nanbeige4.3-33B (Nanbeige, 24/10/2026, Apache 2.0, LlamaForCausalLM dense,
 * texte seulement, outils documentés, 512K de contexte). Pas dans la bibliothèque d'Ollama ; pas de GGUF du créateur
 * (safetensors, FP8, INT4) : GGUF de bartowski, Q4_K_M = 20 788 825 216 octets (API Hugging Face). Architecture llama :
 * Ollama sait la charger. Volontairement en « futur » : à tester et ajouter EN MÊME TEMPS qu'Inkling 2 Mini.
 * Étape 521 (Léo : « oui fais-le ») : Ollama 0.40.18 fait tourner Inkling 2 Mini sur PC (tag GGUF `26b-a5b-iq4_NL`) —
 * Inkling et Nanbeige4.3-33B deviennent de vrais candidats (hardwareScan.ts), à analyser par Léo.
 */
export const FUTURE_MODELS: FutureModel[] = []
