import { desktopCapturer, screen } from 'electron'
import { config } from '../config'

interface OllamaVisionResponse {
  message?: { content?: string }
}

async function captureScreenshotBase64(): Promise<string> {
  const { size, scaleFactor } = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(size.width * scaleFactor), height: Math.round(size.height * scaleFactor) }
  })

  const source = sources[0]
  if (!source) throw new Error("Impossible de capturer l'écran (aucune source disponible).")
  return source.thumbnail.toPNG().toString('base64')
}

/** Capture l'écran et demande au modèle de vision de le décrire ou de répondre à une question dessus. */
export async function lookAtScreen(question: string): Promise<string> {
  const image = await captureScreenshotBase64()

  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.visionModel,
        messages: [
          {
            role: 'user',
            content: question || "Décris ce qui est affiché à l'écran.",
            images: [image]
          }
        ],
        stream: false,
        think: false,
        options: { num_ctx: config.ollama.numCtx }
      })
    })
  } catch {
    throw new Error(`Impossible de joindre Ollama sur ${config.ollama.host} (est-il lancé ?)`)
  }

  if (!response.ok) {
    throw new Error(`Ollama (vision) a répondu ${response.status} : ${await response.text()}`)
  }

  const data = (await response.json()) as OllamaVisionResponse
  const content = data.message?.content?.trim()
  if (!content) throw new Error(`Réponse vide du modèle de vision '${config.ollama.visionModel}' (bien installé ? ollama pull ${config.ollama.visionModel})`)
  return content
}
