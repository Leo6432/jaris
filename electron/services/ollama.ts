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

export type ThinkLevel = 'low' | 'medium' | 'high'

/** Un tour d'échange avec Ollama : envoie l'historique (+ outils dispo) et renvoie le message du modèle. */
export async function chatWithOllama(
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  model: string = config.ollama.model,
  think: ThinkLevel = 'medium'
): Promise<OllamaMessage> {
  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        // Le raisonnement caché de qwen3.5 aide nettement à décider d'appeler un outil plutôt que de
        // "raconter" une action sans l'exécuter ; le niveau (low/medium/high) vient du palier de
        // complexité choisi pour la question (voir assistant.ts), pas d'une valeur fixe.
        think,
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
  if (!data.message) throw new Error(`Réponse vide d'Ollama (modèle '${model}' bien installé ?)`)
  return data.message
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>
}

export async function listInstalledModels(): Promise<string[]> {
  const response = await fetch(`${config.ollama.host}/api/tags`)
  if (!response.ok) throw new Error(`Ollama a répondu ${response.status} en listant les modèles installés`)
  const data = (await response.json()) as OllamaTagsResponse
  return (data.models ?? []).map((m) => m.name)
}

/** Télécharge `model` via Ollama s'il n'est pas déjà installé. */
export async function pullModelIfMissing(model: string, onStatus?: (message: string) => void): Promise<void> {
  const installed = await listInstalledModels()
  if (installed.includes(model)) return

  onStatus?.(`Téléchargement du modèle ${model}…`)
  const response = await fetch(`${config.ollama.host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: false })
  })
  if (!response.ok) {
    throw new Error(`Échec du téléchargement de ${model} (Ollama a répondu ${response.status})`)
  }
}
