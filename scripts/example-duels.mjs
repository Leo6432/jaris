/**
 * Étape 358 : Faible, Moyen, Élevé et Code prennent leur force dans les duels (tous à 0 point au départ). Les tests de
 * la MÉCANIQUE du choix (gabarit des petits, plancher de vitesse, repli…) gardent des exemples réalistes en branchant des
 * « duels » d'exemple, où chaque modèle a déjà une force différente.
 *
 * Étape 498 (Léo : « supprime tous les trucs d'Artificial Analysis ») : ces forces étaient calculées à partir des notes
 * d'Artificial Analysis, retirées de Jaris. Elles sont FIGÉES ici, telles quelles, comme de simples votes d'exemple —
 * aucune donnée de Jaris n'en dépend. Un modèle absent a la force 1, comme un modèle jamais voté.
 */

/** Force d'exemple en Conversation. */
export const EXAMPLE_CONVERSATION_DUELS = new Map([
  ["qwen3.5:0.8b", 1387.75],
  ["qwen3.5:2b", 1373.1],
  ["qwen3.5:4b", 2724.8],
  ["qwen3.5:9b", 2604],
  ["qwen3.5:27b", 6412.000000000001],
  ["qwen3.5:35b", 5008.35],
  ["qwen3.6:27b", 8560],
  ["qwen3.6:35b", 7079.8],
  ["qwen3.6:35b-a3b", 7079.8],
  ["qwen3.8:27b", 15165],
  ["muse-glimmer:30b", 5871.249999999999],
  ["gpt-oss:20b", 1665],
  ["gemma4:12b", 3358.2999999999997],
  ["gemma4:26b", 4108.200000000001],
  ["gemma4:31b", 3829.3500000000004],
  ["gemma4:e4b", 3573.35],
  ["ministral-3:14b", 1007.9999999999999],
  ["ministral-3:3b", 864],
  ["granite4.1:3b", 678.5],
  ["granite4.2:3b", 3881.15],
  ["ministral-3:8b", 852.5],
  ["granite4.2:8b", 4595.4],
  ["granite4.1:8b", 1184.7],
  ["mistral-small3.2:24b", 1729],
  ["granite4.2:30b", 5530.85],
  ["qwen3:1.7b", 585],
  ["glm-4.7-flash:q4_K_M", 2786.3],
  ["nemotron-3.5-lightning:30b", 5308.349999999999],
  ["qwen3-vl:8b", 1955.7],
  ["qwen3-vl:4b", 1105.9999999999998],
  ["qwen3-coder:30b", 2366.4],
  ["north-mini-code-1.0", 2544.3],
  ["devstral-small-2:24b", 1586.25],
  ["hf.co/bartowski/ai9stars_G9v3-3B-GGUF", 5162.4],
  ["hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M", 4473.299999999999],
  ["hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M", 5518.75],
  ["hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M", 2415],
  ["hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", 3742.2],
  ["hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M", 408.00000000000006],
  ["hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M", 5569.200000000001],
  ["hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M", 8590.2],
  ["phi4-mini", 1225.3500000000001]
])

/** Force d'exemple en Code. */
export const EXAMPLE_CODE_DUELS = new Map([
  ["qwen3.5:0.8b", 1123.5955056179776],
  ["qwen3.5:2b", 3000],
  ["qwen3.5:4b", 25800],
  ["qwen3.5:9b", 29200],
  ["qwen3.6:27b", 60700],
  ["qwen3.6:35b", 44900],
  ["qwen3.6:35b-a3b", 44900],
  ["qwen3.8:27b", 79800],
  ["muse-glimmer:30b", 51700],
  ["gpt-oss:20b", 13900],
  ["gemma4:12b", 27300],
  ["gemma4:26b", 39000],
  ["gemma4:31b", 43400],
  ["gemma4:e4b", 1900],
  ["ministral-3:14b", 9700],
  ["ministral-3:3b", 1123.5955056179776],
  ["granite4.1:3b", 1123.5955056179776],
  ["granite4.2:3b", 13900],
  ["ministral-3:8b", 4100],
  ["granite4.2:8b", 18400],
  ["granite4.1:8b", 3400],
  ["mistral-small3.2:24b", 5600],
  ["granite4.2:30b", 26600],
  ["nemotron-3.5-lightning:30b", 24300],
  ["north-mini-code-1.0", 35600],
  ["devstral-small-2:24b", 29600],
  ["hf.co/bartowski/ai9stars_G9v3-3B-GGUF", 6000],
  ["hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M", 27700],
  ["hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M", 8600],
  ["hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M", 1123.5955056179776],
  ["hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", 4500],
  ["hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M", 1123.5955056179776],
  ["hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M", 28100],
  ["hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M", 44200],
  ["hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M", 62600],
  ["phi4-mini", 1123.5955056179776]
])

/**
 * Vitesses d'exemple (tokens/s), comme si chaque modèle avait déjà été mesuré sur le PC : les tests du plancher de
 * vitesse de Faible et Moyen en ont besoin. Figées elles aussi (étape 498 : plus aucune vitesse publiée dans Jaris).
 */
export const EXAMPLE_SPEEDS = new Map([
  ["qwen3.5:4b", 16.4],
  ["qwen3.5:9b", 58.8],
  ["qwen3.5:27b", 78],
  ["qwen3.5:35b", 146.1],
  ["qwen3.6:27b", 57],
  ["qwen3.6:35b", 136.4],
  ["qwen3.6:35b-a3b", 136.4],
  ["qwen3.8:27b", 45.2],
  ["muse-glimmer:30b", 124.1],
  ["gpt-oss:20b", 156.1],
  ["gemma4:12b", 119.8],
  ["gemma4:26b", 79],
  ["gemma4:31b", 35.9],
  ["gemma4:e4b", 38.5],
  ["ministral-3:14b", 83.1],
  ["ministral-3:3b", 206.8],
  ["granite4.2:3b", 109.6],
  ["ministral-3:8b", 113.8],
  ["granite4.2:8b", 97.3],
  ["granite4.2:30b", 98.9],
  ["mistral-small3.2:24b", 41.9],
  ["glm-4.7-flash:q4_K_M", 88.2],
  ["nemotron-3.5-lightning:30b", 287.3],
  ["qwen3-coder:30b", 222.1],
  ["north-mini-code-1.0", 59],
  ["hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M", 56.7],
  ["phi4-mini", 45.7],
  ["lfm3:1.7b", 148]
])

/** Branche ces duels et ces vitesses d'exemple sur un module hardwareScan.ts chargé par un test. */
export function useExampleDuels(m, speeds = EXAMPLE_SPEEDS) {
  m.setLocalSpeedResolver((model) => (speeds.has(model) ? { speed: speeds.get(model), kind: 'measured' } : { speed: null, kind: null }))
  const toStanding = (map) => new Map([...map].map(([model, strength]) => [model, { strength, duels: 1 }]))
  const conversation = toStanding(EXAMPLE_CONVERSATION_DUELS)
  const code = toStanding(EXAMPLE_CODE_DUELS)
  m.setDuelStrengthSource((category) => (category === 'code' ? code : conversation))
  return m
}
