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

export const FUTURE_MODELS: FutureModel[] = [
  // PrismML, 17/09/2026, Apache 2.0 : qwen3.8:27b compressé à ~1,75 bit par paramètre (valeurs −1, 0, +1).
  // 8,26 Go (modèle 7,63 + lecture d'images 0,63). Aucune fiche Artificial Analysis.
  { model: 'bonsai-2:27b', vramGb: 8.3, readsImages: true, quantization: 'Q2_0' }
]
