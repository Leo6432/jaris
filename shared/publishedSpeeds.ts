/**
 * Étape 517 (Léo : « je vais te donner les résultats et personne ne va faire de test : quand il installe, il voit tous
 * les scores, de duel, de vitesse, de tout ; l'utilisateur ne fait rien ») : les vitesses mesurées par Léo avec le test
 * de vitesse (mêmes questions pour tous, shared/localSpeed.ts), publiées dans Jaris pour TOUT LE MONDE. Recopiées du
 * fichier qu'il m'a envoyé (jaris-vitesses-2026-11-23.json, arrondies au dixième) — seule source de ces chiffres.
 *
 * Ce sont des tokens écrits par seconde sur SA machine (`PUBLISHED_SPEED_REFERENCE`) : un modèle plus gros que sa carte
 * graphique y débordait sur la RAM, donc sa vitesse ne dit rien d'un PC à grosse carte. hardwareScan.ts ne s'en sert
 * pour choisir que si le modèle tenait dans cette carte ; l'écran les montre toutes, avec la machine de mesure.
 * Une vitesse mesurée sur CE PC (test de vitesse) passe toujours avant.
 */
export const PUBLISHED_SPEED_REFERENCE = {
  gpu: 'NVIDIA GeForce RTX 3070',
  vramGb: 8,
  ramGb: 63,
  ollama: '0.40.16',
  jaris: '0.76.1',
  testVersion: 1,
  measuredAt: '2026-11-23'
} as const

export const PUBLISHED_SPEEDS: Record<string, number> = {
  'hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M': 227.8,
  'lfm3:1.7b': 150.0,
  'qwen3.5:0.8b': 118.5,
  'qwen3:1.7b': 155.2,
  'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M': 128.3,
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M': 124.6,
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF': 102.2,
  'qwen3-vl:2b': 156.3,
  'granite4.1:3b': 88.0,
  'granite4.2:3b': 91.0,
  'hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M': 86.8,
  'phi4-mini': 84.3,
  'qwen3.5:2b': 89.9,
  'ministral-3:3b': 88.2,
  'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M': 69.4,
  'qwen3.5:4b': 65.1,
  'qwen3-vl:4b': 72.2,
  'hf.co/XHToken/Spark-X2.6-4B-GGUF:Q4_K_M': 64.0,
  'qwen2.5-coder:7b': 51.1,
  'hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M': 146.2,
  'granite4.2:8b': 25.1,
  'granite4.1:8b': 13.8,
  'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M': 29.0,
  'ministral-3:8b': 23.2,
  'qwen3.5:27b': 3.3,
  'qwen3.8:27b': 4.7,
  'muse-glimmer:30b': 4.0,
  'qwen3-vl:8b': 18.6,
  'gemma4:e4b': 89.5,
  'qwen3.5:9b': 33.0,
  'ornith-1.5:9b': 35.5,
  'nemotron-3.5-bolt:e4b': 59.2,
  'gemma4:12b': 23.4,
  'qwen2.5-coder:14b': 10.2,
  'ministral-3:14b': 10.3,
  'gpt-oss:20b': 33.0,
  'mistral-small3.2:24b': 4.3,
  'devstral-small-2:24b': 4.5,
  'granite4.2:30b': 3.6,
  'qwen3.6:27b': 5.0,
  'qwen3-coder:30b': 32.2,
}
