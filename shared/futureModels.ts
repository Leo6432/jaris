/**
 * Étape 341 (Léo : « ajoute-le dans futur, en bas de tous les modèles, mets en rayure futur modèle ») : modèles
 * repérés mais pas encore candidats de Jaris. Ils s'affichent en bas de « Tous les modèles », sur fond rayé, et
 * ne sont JAMAIS choisis ni proposés au test : ils ne sont dans aucune liste de hardwareScan.ts.
 *
 * Tailles relevées dans le registre d'Ollama (somme des couches du manifeste), comme pour les vrais candidats.
 */
export interface FutureModel {
  /** Tag Ollama officiel. */
  model: string
  vramGb: number
  readsImages: boolean
  quantization: string
}

/**
 * Vide pour l'instant. Étape 347 (Léo : « enlève bonsai ») : Bonsai 2 27B (PrismML, qwen3.8:27b compressé en Q2_0,
 * 8,3 Go) retiré. La ligne rayée reste prête pour le prochain modèle à surveiller.
 */
export const FUTURE_MODELS: FutureModel[] = []
