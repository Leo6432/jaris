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

/**
 * Image jointe dans le Chat (étape 91). Contrairement au prompt ci-dessus, la réponse est LUE À L'ÉCRAN et
 * pas à voix haute : la mise en forme légère y est autorisée, exactement comme le canal 'chat' de
 * buildSystemPrompt (assistant.ts) l'autorise déjà pour les réponses écrites.
 */
export const IMAGE_CHAT_SYSTEM_PROMPT =
  "Tu es Jaris. L'utilisateur t'envoie une image et te pose une question dessus. Réponds en français, " +
  "précisément et sans inventer : si un détail est illisible ou absent de l'image, dis-le franchement " +
  "plutôt que de le deviner. Tu peux utiliser une mise en forme légère (listes, **gras**) si ça aide à la " +
  'lecture.'

/**
 * Image jointe en mode Code (étape 91) : le modèle de code n'est PAS un modèle de vision, et les deux ne
 * tiennent de toute façon pas ensemble en VRAM sur une carte 8 Go (voir assistant.ts). L'image est donc
 * traduite en TEXTE par le modèle de vision, puis ce texte seul part au modèle de code — d'où un prompt qui
 * demande une description exploitable pour reconstruire l'interface, pas un commentaire libre.
 */
export const IMAGE_FOR_CODE_SYSTEM_PROMPT =
  "Tu décris une image (maquette, capture d'écran ou croquis d'interface) pour qu'un autre modèle puisse la " +
  "reconstruire en HTML/CSS sans jamais la voir. Réponds en français. Décris dans l'ordre : la structure " +
  "générale et la disposition des blocs, chaque texte visible recopié mot pour mot, les couleurs dominantes, " +
  'les boutons/champs/images et leur position relative. Ne propose aucun code, ne donne aucun conseil : ' +
  "uniquement ce qui est réellement visible. Si une zone est illisible, dis-le au lieu de l'inventer."

// Une capture plein écran/HiDPI (ex: 4K) ralentit énormément l'encodage et
// l'analyse par le modèle de vision pour peu de gain : une résolution plus
// modeste suffit largement à lire du texte ou décrire une fenêtre.
const MAX_SCREENSHOT_WIDTH = 1280

export interface ScreenCapture {
  imageBase64: string
  /**
   * Facteur pour convertir une coordonnée pixel de `imageBase64` (réduite à MAX_SCREENSHOT_WIDTH, voir
   * plus haut) en coordonnée réelle à l'écran : `realX = capturedX * scale` — computerUse.ts (étape 34) doit
   * impérativement appliquer ce facteur avant de cliquer, sinon un clic repéré correctement par le modèle de
   * vision sur l'image atterrit ailleurs sur le vrai écran dès que celui-ci dépasse MAX_SCREENSHOT_WIDTH de
   * large (quasiment tous les écrans modernes). `1` quand l'écran est déjà plus étroit que ce seuil.
   */
  scale: number
}

/** Capture plein écran en base64 (PNG) — réutilisée par computerUse.ts (étape 34) pour chaque itération de
    sa boucle de contrôle. */
export async function captureScreenshotBase64(): Promise<ScreenCapture> {
  const { size } = screen.getPrimaryDisplay()
  const width = Math.min(size.width, MAX_SCREENSHOT_WIDTH)
  const height = Math.round((size.height / size.width) * width)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })

  const source = sources[0]
  if (!source) throw new Error("Impossible de capturer l'écran (aucune source disponible).")
  return { imageBase64: source.thumbnail.toPNG().toString('base64'), scale: size.width / width }
}

/**
 * Envoie une image (PNG en base64, peu importe sa provenance — capture d'écran plein écran ou capture
 * d'un onglet de navigateur via Playwright, voir browserControl.ts) au modèle de vision, avec la même
 * logique de repli VRAM temps réel que le reste de Jaris (assistant.ts) : le modèle choisi une fois pour
 * toutes au scan de capacité (VRAM totale) peut ne plus tenir dans la VRAM *libre* à l'instant présent
 * (conversation déjà chargée, jeu en parallèle...).
 */
export async function describeImage(
  imageBase64: string,
  question: string,
  visionModel: string,
  // Défaut = le prompt "lu à voix haute" d'origine : look_at_screen garde donc EXACTEMENT le comportement
  // qu'il avait avant l'étape 91, seuls les nouveaux appelants (chat/code) passent un prompt différent.
  systemPrompt: string = VISION_SYSTEM_PROMPT
): Promise<string> {
  let model = visionModel
  try {
    const [live, installedModels] = await Promise.all([getLiveGpuStatus(), listInstalledModels()])
    if (live.freeVramGb !== null) model = pickSafeVisionModel(live.freeVramGb, installedModels, visionModel)
  } catch {
    // Pas grave si le check échoue : on garde le modèle normalement configuré.
  }

  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question, images: [imageBase64] }
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
}

/**
 * Capture l'écran et demande au modèle de vision de le décrire ou de répondre à une question dessus.
 *
 * L'animation de scan (étape 18) ne s'affiche qu'APRÈS la capture (jamais avant) : sinon l'overlay
 * apparaîtrait lui-même dans l'image envoyée au modèle. Elle couvre donc la partie "analyse" (l'appel au
 * modèle de vision, qui prend plusieurs secondes), pas la capture elle-même (quasi instantanée) — dans le
 * `finally` pour ne jamais rester affichée en cas d'erreur.
 */
export async function lookAtScreen(question: string, visionModel: string): Promise<string> {
  const { imageBase64 } = await captureScreenshotBase64()
  showScanOverlay()
  try {
    return await describeImage(imageBase64, question || "Décris ce qui est affiché à l'écran.", visionModel)
  } finally {
    hideScanOverlay()
  }
}
