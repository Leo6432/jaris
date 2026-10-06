/**
 * Étape 251 — MAI-UI 8B, le viseur du pilotage d'écran (remplace UI-TARS). Choisi sur le duel de Léo (06/10/2026,
 * ses vraies fenêtres : Explorateur, YouTube, Firefox, Discord ; la vérité donnée par Windows, aucun clic) :
 * 30 boutons touchés sur 40 avec le zoom, contre 22 pour UI-TARS. Au 1er regard ils se valaient (14 et 13) ; mais
 * quand MAI-UI se trompe il vise juste à côté, alors qu'UI-TARS partait souvent à l'autre bout de l'écran — c'est
 * pour ça que le 2e regard (zoom) profite surtout à MAI-UI. Prix à payer : environ 28 s par bouton contre 7.
 *
 * Son mode « pilote complet » est fait pour ANDROID (dépôt Tongyi-MAI/MAI-UI) : sur Windows il sert à VISER. C'est
 * le modèle de vision qui décide quoi faire (computerUse.ts) ; MAI-UI trouve où cliquer.
 * Module pur (ni Electron ni Windows) : l'image et l'appel au modèle sont fournis par l'appelant, et testés à part.
 */

/** Même éditeur que le modèle précédent ; fichier de vision inclus (vérifié : Ollama 0.35.1 le charge). */
export const MAI_UI_MODEL = 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M'

/** Consigne de visée officielle de MAI-UI (dépôt Tongyi-MAI/MAI-UI, evaluation/grounding), recopiée telle quelle. */
export const MAI_UI_GROUNDING_PROMPT = `You are a GUI grounding agent.
Given a screenshot and the user's grounding instruction. Your task is to accurately locate a UI element based on the user's instructions.
First, you should carefully examine the screenshot and analyze the user's instructions,  translate the user's instruction into a effective reasoning process, and then provide the final coordinate.
Return a json object with a reasoning process in <grounding_think></grounding_think> tags, a [x,y] format coordinate within <answer></answer> XML tags:
<grounding_think>...</grounding_think>
<answer>
{"coordinate": [x,y]}
</answer>
`

/** La consigne de visée envoyée à MAI-UI : la même forme que celle du duel, où il a été mesuré. */
export function maiUiInstruction(target: string): string {
  return `Click on ${target.trim()}`
}

/**
 * Point visé par MAI-UI, en fraction de l'image (0 à 1). Ses coordonnées vont de 0 à 999 (SCALE_FACTOR de son
 * code officiel) — vérifié avec Ollama sur une capture 1920x1080 envoyée en 1280x720 : la barre de recherche
 * visée en [267,130] tombe dedans à l'échelle 999, et hors d'elle lue comme des pixels.
 */
export function parseMaiUiPoint(content: string): { fx: number; fy: number } | null {
  const answer = content.match(/<answer>([\s\S]*?)(?:<\/answer>|$)/i)?.[1] ?? content
  const all = [...answer.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*)?\]/g)]
  const m = all.at(-1)
  if (!m) return null
  let [x, y] = [Number(m[1]), Number(m[2])]
  if (m[3] !== undefined && m[4] !== undefined) {
    x = (x + Number(m[3])) / 2
    y = (y + Number(m[4])) / 2
  }
  if (x < 0 || y < 0 || x > 999 || y > 999) return null
  return { fx: x / 999, fy: y / 999 }
}

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** Zone du 2e regard : la moitié de l'écran en largeur et en hauteur, centrée sur le 1er point, sans déborder. */
export function zoomRect(px: number, py: number, width: number, height: number): PixelRect {
  const w = Math.round(width / 2)
  const h = Math.round(height / 2)
  const x = Math.min(Math.max(0, Math.round(px - w / 2)), width - w)
  const y = Math.min(Math.max(0, Math.round(py - h / 2)), height - h)
  return { x, y, w, h }
}

export interface MaiUiImage {
  base64: string
  width: number
  height: number
}

export interface MaiUiDeps {
  /** Taille de la capture à pleine résolution, dans laquelle `view` recadre. */
  width: number
  height: number
  /** La capture, recadrée sur `rect` (toute l'image si `null`), réduite à 1280 px de large au plus. */
  view: (rect: PixelRect | null) => Promise<MaiUiImage>
  /** Réponse brute de MAI-UI (le délai et l'annulation sont gérés par l'appelant). */
  chat: (messages: Array<{ role: 'system' | 'user'; content: string; images?: string[] }>) => Promise<string>
}

export interface MaiUiAim {
  /** Point final, en fraction de l'écran (0 à 1). */
  fx: number
  fy: number
  /** Le 2e regard a donné une réponse lisible (sinon on garde le 1er point). */
  zoomed: boolean
}

async function ask(target: string, image: MaiUiImage, deps: MaiUiDeps): Promise<{ fx: number; fy: number } | null> {
  const raw = await deps.chat([
    { role: 'system', content: MAI_UI_GROUNDING_PROMPT },
    { role: 'user', content: `${maiUiInstruction(target)}\n`, images: [image.base64] }
  ])
  return parseMaiUiPoint(raw)
}

/**
 * Vise `target` (ex. « le bouton Rechercher ») : un 1er regard sur tout l'écran, puis un 2e sur la moitié de
 * l'écran centrée sur ce 1er point — exactement la méthode mesurée au duel. `null` si le 1er regard est illisible
 * (l'appelant garde alors la position estimée par le modèle de vision). Les erreurs d'appel (Ollama injoignable,
 * délai, annulation) remontent telles quelles : c'est à l'appelant de décider.
 */
export async function aimWithMaiUi(target: string, deps: MaiUiDeps): Promise<MaiUiAim | null> {
  const first = await ask(target, await deps.view(null), deps)
  if (!first) return null
  const rect = zoomRect(first.fx * deps.width, first.fy * deps.height, deps.width, deps.height)
  const second = await ask(target, await deps.view(rect), deps)
  if (!second) return { ...first, zoomed: false }
  return {
    fx: (rect.x + second.fx * rect.w) / deps.width,
    fy: (rect.y + second.fy * rect.h) / deps.height,
    zoomed: true
  }
}
