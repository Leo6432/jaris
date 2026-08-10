import { desktopCapturer, screen } from 'electron'
import { config } from '../config'

interface OllamaVisionResponse {
  message?: { content?: string }
}

const VISION_SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal qui décrit ce qui est affiché à l'écran de l'utilisateur. Réponds en " +
  'français, de façon concise et naturelle comme à l\'oral, sans émojis, astérisques, listes à puces ni ' +
  'mise en forme : ta réponse est lue directement à voix haute.'

// Une capture plein écran/HiDPI (ex: 4K) ralentit énormément l'encodage et
// l'analyse par le modèle de vision pour peu de gain : une résolution plus
// modeste suffit largement à lire du texte ou décrire une fenêtre.
const MAX_SCREENSHOT_WIDTH = 1280

async function captureScreenshotBase64(): Promise<string> {
  const { size } = screen.getPrimaryDisplay()
  const width = Math.min(size.width, MAX_SCREENSHOT_WIDTH)
  const height = Math.round((size.height / size.width) * width)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
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
          { role: 'system', content: VISION_SYSTEM_PROMPT },
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
