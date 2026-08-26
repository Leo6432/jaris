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

async function requestChat(body: Record<string, unknown>, model: string, signal?: AbortSignal): Promise<OllamaMessage> {
  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new Error(`Impossible de joindre Ollama sur ${config.ollama.host} (est-il lancé ?)`)
  }

  if (!response.ok) {
    throw new Error(`Ollama a répondu ${response.status} : ${await response.text()}`)
  }

  const data = (await response.json()) as OllamaChatResponse
  if (!data.message) throw new Error(`Réponse vide d'Ollama (modèle '${model}' bien installé ?)`)
  return data.message
}

/**
 * Un tour d'échange avec Ollama : envoie l'historique (+ outils dispo) et renvoie le message du modèle.
 *
 * Certains modèles (constaté au benchmark local : granite4, entre autres) n'ont pas de mode réflexion et
 * rejettent carrément l'appel avec une erreur si `think` est présent, contrairement à qwen3.5/gemma4 qui le
 * supportent tous les deux. Plutôt que de maintenir à la main une liste des modèles compatibles (fragile,
 * à mettre à jour à chaque nouveau modèle ajouté aux paliers), on retente une fois sans `think` si le
 * premier essai échoue : ça couvre aussi bien les modèles qui le supportent que ceux qui ne le supportent
 * pas, sans avoir à savoir lequel est lequel à l'avance.
 */
export async function chatWithOllama(
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  model: string = config.ollama.model,
  think: ThinkLevel = 'medium',
  signal?: AbortSignal,
  // Surcharge ponctuelle de la fenêtre de contexte : la conversation normale tient largement dans la
  // valeur par défaut (OLLAMA_NUM_CTX), mais la génération de code (étape 30) produit un fichier complet
  // puis le relit en entier pour le corriger, ce qui dépasse nettement 4096 tokens.
  numCtx: number = config.ollama.numCtx
): Promise<OllamaMessage> {
  const baseBody = { model, messages, tools, stream: false, options: { num_ctx: numCtx } }
  try {
    // Le raisonnement caché aide nettement à décider d'appeler un outil plutôt que de "raconter" une
    // action sans l'exécuter ; le niveau (low/medium/high) vient du palier de complexité choisi pour la
    // question (voir assistant.ts), pas d'une valeur fixe.
    return await requestChat({ ...baseBody, think }, model, signal)
  } catch (firstErr) {
    // Une requête annulée (l'utilisateur a ajouté une précision pendant la réflexion, voir voicePipeline.ts)
    // ne doit jamais déclencher le second essai sans `think` : ce serait un appel Ollama inutile pour une
    // réponse qui va de toute façon être remplacée par la relance avec la phrase fusionnée.
    if (firstErr instanceof Error && firstErr.name === 'AbortError') throw firstErr
    try {
      return await requestChat(baseBody, model, signal)
    } catch {
      throw firstErr // le premier message d'erreur est généralement le plus informatif
    }
  }
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

interface OllamaPullProgress {
  status?: string
  total?: number
  completed?: number
  error?: string
}

/**
 * Télécharge `model` via Ollama s'il n'est pas déjà installé, avec une vraie progression (%) affichée au
 * fil de l'eau. `stream: true` (et non `false` comme avant) : un modèle de plusieurs Go pouvant prendre
 * plusieurs minutes, une requête non-streamée reste bloquée en silence jusqu'à la toute fin du
 * téléchargement, sans aucun retour visuel entre-temps — donnant l'impression que rien ne se passe alors
 * que ça télécharge bien en arrière-plan. Ollama renvoie une ligne JSON par mise à jour (format NDJSON),
 * une par "couche" du modèle (le pourcentage repart donc à 0 à chaque nouvelle couche, comme dans `ollama
 * pull` en ligne de commande).
 */
export async function pullModelIfMissing(model: string, onStatus?: (message: string) => void): Promise<void> {
  const installed = await listInstalledModels()
  if (installed.includes(model)) return

  onStatus?.(`Téléchargement du modèle ${model}…`)
  const response = await fetch(`${config.ollama.host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true })
  })
  if (!response.ok || !response.body) {
    throw new Error(`Échec du téléchargement de ${model} (Ollama a répondu ${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastPercent = -1

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue

      let progress: OllamaPullProgress
      try {
        progress = JSON.parse(line)
      } catch {
        continue
      }

      if (progress.error) throw new Error(`Échec du téléchargement de ${model} : ${progress.error}`)

      if (progress.total && progress.completed !== undefined) {
        const percent = Math.floor((progress.completed / progress.total) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          onStatus?.(`Téléchargement du modèle ${model}… ${percent}%`)
        }
      } else if (progress.status) {
        onStatus?.(`${model} : ${progress.status}`)
      }
    }
  }
}

/**
 * Désinstalle `model` via l'API HTTP d'Ollama (DELETE /api/delete), plutôt qu'en lançant `ollama rm` en
 * sous-process : reste cohérent avec le reste de ce fichier (tout en HTTP) et évite tout risque de fenêtre
 * de console qui flashe sous Windows pour un simple appel de nettoyage.
 */
export async function deleteModel(model: string): Promise<void> {
  const response = await fetch(`${config.ollama.host}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model })
  })
  if (!response.ok) {
    throw new Error(`Échec de la suppression de ${model} (Ollama a répondu ${response.status})`)
  }
}
