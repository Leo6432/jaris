import { buildUiTarsPrompt, parseUiTarsResponse } from './uiTars'

/**
 * Étape 249 — duel des pilotes d'écran sur le VRAI écran de Léo (« ok on le teste contre l'autre en vraie
 * situation »). Le journal de l'étape 248 a montré UI-TARS 1.5 7B cliquer à côté (barre des tâches, croix de
 * Firefox). Les classements publics (ScreenSpot-Pro) placent MAI-UI 8B bien au-dessus — chiffres des auteurs,
 * jamais vérifiés sur sa machine. Ce duel les départage sur SES fenêtres, sans le moindre clic :
 *   - Windows donne la VRAIE position de chaque bouton (UI Automation) : c'est la vérité, pas un modèle ;
 *   - chaque pilote reçoit la même capture et la même consigne (« Click on the "Rechercher" button ») ;
 *   - un tir est juste si le point visé tombe DANS le rectangle du bouton.
 * Chaque pilote est aussi mesuré avec le « zoom » (2e regard sur une zone recadrée autour du 1er point), la
 * technique qui fait gagner 7 à 10 points aux meilleurs du classement — appliquée aux DEUX, pour être juste.
 * Module pur (ni Electron ni Windows) : la capture et le découpage d'image sont fournis par l'appelant.
 */

/** Même éditeur que le UI-TARS déjà utilisé ; fichier de vision inclus (vérifié : Ollama 0.35.1 le charge). */
export const MAI_UI_MODEL = 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M'
export const MAI_UI_LABEL = 'MAI-UI 8B'

/** Un élément de l'écran, en pixels RÉELS de la capture (même repère que l'image). */
export interface DuelElement {
  name: string
  type: string
  x: number
  y: number
  w: number
  h: number
}

export interface DuelCapture {
  /** Chemin de la capture PNG, à pleine résolution. */
  png: string
  width: number
  height: number
  elements: DuelElement[]
}

export type PilotKind = 'ui-tars' | 'mai-ui'

export interface DuelContender {
  label: string
  model: string
  kind: PilotKind
}

/** Les cibles retenues d'une capture : nommées, visibles, ni minuscules ni immenses, et sans homonyme (ambigu). */
export function pickTargets(capture: DuelCapture, max = 10): DuelElement[] {
  const area = capture.width * capture.height
  const names = new Map<string, number>()
  for (const el of capture.elements) {
    const key = el.name.trim().toLowerCase()
    names.set(key, (names.get(key) ?? 0) + 1)
  }
  const usable = capture.elements.filter((el) => {
    const name = el.name.trim()
    return (
      name.length >= 2 &&
      name.length <= 60 &&
      names.get(name.toLowerCase()) === 1 &&
      el.w >= 8 &&
      el.h >= 8 &&
      el.w * el.h <= area * 0.2 &&
      el.x >= 0 &&
      el.y >= 0 &&
      el.x + el.w <= capture.width &&
      el.y + el.h <= capture.height
    )
  })
  if (usable.length <= max) return usable
  // Répartis sur toute la liste (barre des tâches comprise), dans un ordre fixe : le même écran donne le même duel.
  const step = usable.length / max
  return Array.from({ length: max }, (_, i) => usable[Math.floor(i * step)])
}

const TYPE_WORDS: Record<string, string> = {
  Button: 'button',
  Hyperlink: 'link',
  MenuItem: 'menu item',
  TabItem: 'tab',
  ListItem: 'item',
  CheckBox: 'checkbox',
  RadioButton: 'option',
  ComboBox: 'drop-down list',
  Edit: 'text field'
}

/** La même consigne pour les deux, en anglais (langue de leur entraînement à tous les deux). */
export function instructionFor(el: DuelElement): string {
  return `Click on the "${el.name.trim().replace(/"/g, "'")}" ${TYPE_WORDS[el.type] ?? 'element'}`
}

/** Consigne de visée officielle de MAI-UI (dépôt Tongyi-MAI/MAI-UI, evaluation/grounding). */
export const MAI_UI_GROUNDING_PROMPT = `You are a GUI grounding agent.
Given a screenshot and the user's grounding instruction. Your task is to accurately locate a UI element based on the user's instructions.
First, you should carefully examine the screenshot and analyze the user's instructions,  translate the user's instruction into a effective reasoning process, and then provide the final coordinate.
Return a json object with a reasoning process in <grounding_think></grounding_think> tags, a [x,y] format coordinate within <answer></answer> XML tags:
<grounding_think>...</grounding_think>
<answer>
{"coordinate": [x,y]}
</answer>
`

/**
 * Point visé par MAI-UI, en fraction de l'image (0 à 1). Ses coordonnées vont de 0 à 999 (SCALE_FACTOR de son
 * code officiel) — vérifié ici avec Ollama sur une capture 1920x1080 envoyée en 1280x720 : la barre de recherche
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

/** Point visé par UI-TARS avec la consigne qu'il reçoit dans le vrai pilotage de Jaris, en fraction de l'image. */
export function parseUiTarsPoint(content: string, width: number, height: number): { fx: number; fy: number } | null {
  const step = parseUiTarsResponse(content, width, height)
  if (!step || step.x === undefined || step.y === undefined || !/click/.test(step.action)) return null
  return { fx: step.x / width, fy: step.y / height }
}

/** Zone du 2e regard : la moitié de l'écran en largeur et en hauteur, centrée sur le 1er point, sans déborder. */
export function zoomRect(px: number, py: number, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const w = Math.round(width / 2)
  const h = Math.round(height / 2)
  const x = Math.min(Math.max(0, Math.round(px - w / 2)), width - w)
  const y = Math.min(Math.max(0, Math.round(py - h / 2)), height - h)
  return { x, y, w, h }
}

export function hits(el: DuelElement, px: number, py: number): boolean {
  return px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h
}

export interface DuelImage {
  base64: string
  width: number
  height: number
}

export interface DuelDeps {
  /** L'image de la capture, recadrée sur `rect` (toute l'image si absent), réduite à `maxWidth` de large au plus. */
  image: (png: string, rect: { x: number; y: number; w: number; h: number } | null, maxWidth: number) => Promise<DuelImage>
  /** Réponse brute du modèle (température 0). */
  chat: (model: string, messages: Array<{ role: 'system' | 'user'; content: string; images?: string[] }>) => Promise<string>
  onProgress?: (message: string) => void
  now?: () => number
}

/** Même largeur que la capture du vrai pilotage (MAX_SCREENSHOT_WIDTH, vision.ts). */
export const DUEL_IMAGE_WIDTH = 1280

export interface DuelShot {
  capture: number
  name: string
  type: string
  rect: [number, number, number, number]
  /** Point visé au 1er regard (pixels réels), `null` si la réponse était illisible. */
  first: [number, number] | null
  firstHit: boolean
  zoom: [number, number] | null
  zoomHit: boolean
  seconds: number
  raw: string
}

export interface DuelResult {
  label: string
  model: string
  hits: number
  zoomHits: number
  total: number
  seconds: number
  shots: DuelShot[]
  /** Le modèle n'a pas pu être utilisé du tout (Ollama injoignable, modèle absent…). */
  error?: string
}

async function aim(contender: DuelContender, image: DuelImage, instruction: string, deps: DuelDeps): Promise<{ point: { fx: number; fy: number } | null; raw: string }> {
  const raw =
    contender.kind === 'mai-ui'
      ? await deps.chat(contender.model, [
          { role: 'system', content: MAI_UI_GROUNDING_PROMPT },
          { role: 'user', content: `${instruction}\n`, images: [image.base64] }
        ])
      : await deps.chat(contender.model, [{ role: 'user', content: buildUiTarsPrompt(instruction, []), images: [image.base64] }])
  const point = contender.kind === 'mai-ui' ? parseMaiUiPoint(raw) : parseUiTarsPoint(raw, image.width, image.height)
  return { point, raw }
}

/** Le duel : chaque pilote passe TOUTES les cibles d'affilée (un seul chargement de modèle chacun sur 8 Go). */
export async function runDuel(captures: DuelCapture[], contenders: DuelContender[], deps: DuelDeps): Promise<DuelResult[]> {
  const now = deps.now ?? Date.now
  const targets = captures.flatMap((capture, index) => pickTargets(capture).map((element) => ({ index, capture, element })))
  const results: DuelResult[] = []
  for (const contender of contenders) {
    const result: DuelResult = { label: contender.label, model: contender.model, hits: 0, zoomHits: 0, total: targets.length, seconds: 0, shots: [] }
    results.push(result)
    for (const [n, { index, capture, element }] of targets.entries()) {
      deps.onProgress?.(`${contender.label} : cible ${n + 1}/${targets.length} (« ${element.name} »)…`)
      const started = now()
      const instruction = instructionFor(element)
      const shot: DuelShot = {
        capture: index + 1,
        name: element.name,
        type: element.type,
        rect: [element.x, element.y, element.w, element.h],
        first: null,
        firstHit: false,
        zoom: null,
        zoomHit: false,
        seconds: 0,
        raw: ''
      }
      try {
        const full = await deps.image(capture.png, null, DUEL_IMAGE_WIDTH)
        const first = await aim(contender, full, instruction, deps)
        shot.raw = first.raw.slice(-300)
        if (first.point) {
          const px = first.point.fx * capture.width
          const py = first.point.fy * capture.height
          shot.first = [Math.round(px), Math.round(py)]
          shot.firstHit = hits(element, px, py)
          const rect = zoomRect(px, py, capture.width, capture.height)
          const crop = await deps.image(capture.png, rect, DUEL_IMAGE_WIDTH)
          const second = await aim(contender, crop, instruction, deps)
          if (second.point) {
            const zx = rect.x + second.point.fx * rect.w
            const zy = rect.y + second.point.fy * rect.h
            shot.zoom = [Math.round(zx), Math.round(zy)]
            shot.zoomHit = hits(element, zx, zy)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        shot.raw = `erreur : ${message}`
        // Un modèle injoignable dès la 1re cible ne sera pas joignable à la 2e : inutile d'attendre 20 échecs.
        if (!result.shots.length) {
          result.error = message
          result.shots.push(shot)
          break
        }
      }
      shot.seconds = Math.round((now() - started) / 100) / 10
      if (shot.firstHit) result.hits++
      if (shot.zoomHit) result.zoomHits++
      result.seconds += shot.seconds
      result.shots.push(shot)
    }
  }
  return results
}

const pct = (n: number, total: number): string => (total ? `${Math.round((n / total) * 100)} %` : '—')

/** Rapport lisible (Markdown) : le résumé en tête, puis chaque tir, pour pouvoir tout revérifier. */
export function formatDuelReport(results: DuelResult[], captures: DuelCapture[], date: Date): string {
  const lines = [
    `# Duel des pilotes d'écran — ${date.toLocaleString('fr-FR')}`,
    '',
    `${captures.length} capture(s) de ton vrai écran ; la position de chaque bouton vient de Windows (UI Automation). Aucun clic n'a été fait.`,
    '',
    '| Pilote | 1er regard | Avec zoom | Temps moyen par cible |',
    '|---|---|---|---|'
  ]
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.label} | impossible : ${r.error} | — | — |`)
      continue
    }
    lines.push(`| ${r.label} | ${r.hits}/${r.total} (${pct(r.hits, r.total)}) | ${r.zoomHits}/${r.total} (${pct(r.zoomHits, r.total)}) | ${r.total ? Math.round(r.seconds / r.total) : 0} s |`)
  }
  for (const r of results) {
    lines.push('', `## ${r.label} (${r.model})`, '', '| Capture | Cible | Rectangle (x, y, l, h) | 1er regard | Zoom | Réponse (fin) |', '|---|---|---|---|---|---|')
    for (const s of r.shots) {
      const point = (p: [number, number] | null, ok: boolean): string => (p ? `${ok ? '✅' : '❌'} (${p[0]}, ${p[1]})` : '❌ illisible')
      lines.push(`| ${s.capture} | ${s.name.replace(/\|/g, '/')} (${s.type}) | ${s.rect.join(', ')} | ${point(s.first, s.firstHit)} | ${point(s.zoom, s.zoomHit)} | ${s.raw.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(-120)} |`)
    }
  }
  return lines.join('\n') + '\n'
}
