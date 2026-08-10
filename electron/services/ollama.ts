import { config } from '../config'

const SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local sur l'ordinateur de " +
  "l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale."

interface OllamaChatResponse {
  message?: { content?: string }
}

/** Envoie la phrase transcrite à Ollama et renvoie la réponse du modèle. */
export async function askOllama(prompt: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
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
  const content = data.message?.content?.trim()
  if (!content) throw new Error(`Réponse vide d'Ollama (modèle '${config.ollama.model}' bien installé ?)`)
  return content
}
