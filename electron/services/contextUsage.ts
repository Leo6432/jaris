import { EventEmitter } from 'events'
import type { ContextUsage, ContextUsageScope } from '../../shared/ipc'
import type { ChatMetrics } from './ollama'

/**
 * Étape 299 (Léo : « Ollama donne-t-il la fenêtre de contexte, pour qu'on mette comme ChatGPT ou Claude, par exemple
 * 461k/1m ? ») : la place occupée dans la mémoire du modèle, d'après Ollama lui-même — jamais estimée.
 *
 * Vérifié dans le code d'Ollama 0.40.3 : `prompt_eval_count` compte TOUTE la conversation envoyée, partie déjà en
 * cache comprise (llm/llama_server.go, `promptEvalCount` = cache_n + prompt_n), et `eval_count` la réponse écrite
 * (réflexion comprise). Leur somme est ce que la fenêtre contenait à la fin de la réponse. Le maximum est la fenêtre
 * DEMANDÉE pour cet appel (`num_ctx`), ramenée au maximum propre du modèle quand le réglage le dépasse (ollama.ts,
 * fitToModelContext) : c'est elle qui coupe le début de la conversation.
 */
const emitter = new EventEmitter()

/** La place occupée, ou `null` quand Ollama n'a rien mesuré (réponse interrompue, ancienne version). Pure. */
export function contextUsageOf(scope: ContextUsageScope, metrics: ChatMetrics | undefined, max: number): ContextUsage | null {
  if (!metrics || typeof metrics.promptTokens !== 'number') return null
  // La fenêtre réellement demandée à Ollama (plafonnée au maximum du modèle) prime sur celle qu'on lui a proposée.
  const window = metrics.contextWindow ?? max
  if (!(window > 0)) return null
  const used = metrics.promptTokens + (metrics.outputTokens ?? 0)
  return { scope, used, max: window }
}

export function reportContextUsage(scope: ContextUsageScope, metrics: ChatMetrics | undefined, max: number): void {
  const usage = contextUsageOf(scope, metrics, max)
  if (usage) emitter.emit('usage', usage)
}

export function onContextUsage(listener: (usage: ContextUsage) => void): () => void {
  emitter.on('usage', listener)
  return () => emitter.off('usage', listener)
}
