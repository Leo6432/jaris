import { config } from '../config'

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OllamaChatResponse {
  message?: OllamaMessage
}

/** Un tour d'échange avec Ollama : envoie l'historique (+ outils dispo) et renvoie le message du modèle. */
export async function chatWithOllama(messages: OllamaMessage[], tools?: OllamaTool[]): Promise<OllamaMessage> {
  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        messages,
        tools,
        stream: false,
        think: false, // pas besoin du raisonnement caché de qwen3.5 pour une réponse vocale directe
        options: { num_ctx: config.ollama.numCtx }
      })
    })
  } catch {
    throw new Error(`Impossible de joindre Ollama sur ${config.ollama.host} (est-il lancé ?)`)
  }

  if (!response.ok) {
    throw new Error(`Ollama a répondu ${response.status} : ${await response.text()}`)
  }

  const data = (await response.json()) as OllamaChatResponse
  if (!data.message) throw new Error(`Réponse vide d'Ollama (modèle '${config.ollama.model}' bien installé ?)`)
  return data.message
}
