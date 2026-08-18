import { desktopCapturer, screen } from 'electron'
import { config } from '../config'
import { hideScanOverlay, showScanOverlay } from './scanOverlay'
import { getLiveGpuStatus, pickSafeVisionModel } from './hardwareScan'
import { listInstalledModels } from './ollama'

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

/**
 * Capture l'écran et demande au modèle de vision de le décrire ou de répondre à une question dessus.
 * `visionModel` vient du scan de capacité (étape 13, adapté à la VRAM totale de la machine) plutôt que
 * toujours le même modèle fixe pour tout le monde : un modèle de vision trop gros pour la carte forçait
 * Ollama à décharger/recharger un gros modèle à chaque appel (des dizaines de secondes d'attente).
 *
 * L'animation de scan (étape 18) ne s'affiche qu'APRÈS la capture (jamais avant) : sinon l'overlay
 * apparaîtrait lui-même dans l'image envoyée au modèle. Elle couvre donc la partie "analyse" (l'appel au
 * modèle de vision, qui prend plusieurs secondes), pas la capture elle-même (quasi instantanée) — dans le
 * `finally` pour ne jamais rester affichée en cas d'erreur.
 */
export async function lookAtScreen(question: string, visionModel: string): Promise<string> {
  const image = await captureScreenshotBase64()

  // Le modèle choisi une fois pour toutes au scan de capacité (VRAM totale) peut ne plus tenir dans la VRAM
  // *libre* à l'instant présent (conversation déjà chargée, jeu ou navigateur en parallèle...) : même repli
  // temps réel que pour les modèles de conversation (assistant.ts), pour ne jamais forcer Ollama à charger
  // un modèle trop gros pour ce qui reste de VRAM disponible maintenant.
  let model = visionModel
  try {
    const [live, installedModels] = await Promise.all([getLiveGpuStatus(), listInstalledModels()])
    if (live.freeVramGb !== null) model = pickSafeVisionModel(live.freeVramGb, installedModels, visionModel)
  } catch {
    // Pas grave si le check échoue : on garde le modèle normalement configuré.
  }

  showScanOverlay()
  try {
    let response: Response
    try {
      response = await fetch(`${config.ollama.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
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
    if (!content) throw new Error(`Réponse vide du modèle de vision '${model}' (bien installé ? ollama pull ${model})`)
    return content
  } finally {
    hideScanOverlay()
  }
}
