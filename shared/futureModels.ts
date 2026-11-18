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
 * score publié : à tester dès qu'Ollama sait le faire tourner.
 */
export const FUTURE_MODELS: FutureModel[] = [{ model: 'Olala mini 7A1B', vramGb: null, readsImages: false, quantization: null }]
