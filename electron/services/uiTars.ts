/**
 * Adaptateur UI-TARS pour le pilotage d'écran (étape 231, shared/pilotModel.ts). UI-TARS n'obéit pas au JSON
 * demandé au modèle de vision (computerUse.ts) : il a été entraîné sur SON format, « Thought: … / Action: … »
 * avec des actions écrites comme des appels de fonction. Lui demander autre chose gâcherait justement ce qui le
 * rend bon à viser. Ce module construit sa consigne et traduit sa réponse en une action de la boucle de Jaris.
 * Aucun import : testé tel quel (scripts/test-ui-tars.mjs).
 */

export interface UiTarsStep {
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'key' | 'hotkey' | 'scroll' | 'wait' | 'done' | 'fail'
  /** Pixels de l'image ENVOYÉE (pas de l'écran : computerUse.ts applique ensuite l'échelle de la capture). */
  x?: number
  y?: number
  text?: string
  /** Texte terminé par un retour à la ligne : UI-TARS veut alors valider la saisie (touche Entrée). */
  submit?: boolean
  /** Touche seule, sous un nom que pressKey (inputControl.ts) connaît. */
  key?: string
  /** Combinaison (« ctrl l ») : noms de touches en minuscules, dans l'ordre d'appui. */
  keys?: string[]
  direction?: 'up' | 'down' | 'left' | 'right'
  result?: string
  /** L'action telle qu'écrite par UI-TARS, recopiée dans l'historique qui lui est renvoyé au tour suivant. */
  raw?: string
}

/**
 * Consigne officielle d'UI-TARS 1.5 (COMPUTER_USE, dépôt bytedance/UI-TARS), réduite aux actions que Jaris sait
 * exécuter — un `drag` ou un `select` proposés seraient refusés à coup sûr. « Thought » en français : le
 * raisonnement apparaît dans le journal du Chat. Testé ici tel quel avant d'être retenu (étape 231).
 */
export function buildUiTarsPrompt(goal: string, history: string[]): string {
  const done = history.length ? `\n\n## Actions déjà faites\n${history.join('\n')}` : ''
  return `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format
\`\`\`
Thought: ...
Action: ...
\`\`\`

## Action Space

click(start_box='<|box_start|>(x1,y1)<|box_end|>')
left_double(start_box='<|box_start|>(x1,y1)<|box_end|>')
right_single(start_box='<|box_start|>(x1,y1)<|box_end|>')
hotkey(key='')
type(content='') #If you want to submit your input, use "\\n" at the end of \`content\`.
scroll(start_box='<|box_start|>(x1,y1)<|box_end|>', direction='down or up or right or left')
wait() #Sleep for 5s and take a screenshot to check for any changes.
finished(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format.

## Note
- Use French in \`Thought\` part.
- Write a small plan and finally summarize your next action (with its target element) in one sentence in \`Thought\` part.
- Only call finished() when EVERY part of the instruction is done.

## User Instruction
${goal}${done}`
}

/**
 * Taille à laquelle le modèle « voit » l'image : celle de Qwen2.5-VL (smart_resize), arrondie à des multiples
 * de 28 et bornée en nombre de pixels. UI-TARS donne ses positions dans CE repère — vérifié ici sur une image de
 * 1280x1024 : le bouton OK centré en (1100, 908) a été visé en (1117, 920), soit la taille arrondie
 * (1288x1036) et pas une version réduite à 1 million de pixels (1120x896, qui aurait donné ~(962, 794)).
 */
const FACTOR = 28
const MIN_PIXELS = 100 * FACTOR * FACTOR
const MAX_PIXELS = 16384 * FACTOR * FACTOR

export function smartResize(width: number, height: number): { width: number; height: number } {
  let h = Math.max(FACTOR, Math.round(height / FACTOR) * FACTOR)
  let w = Math.max(FACTOR, Math.round(width / FACTOR) * FACTOR)
  if (h * w > MAX_PIXELS) {
    const beta = Math.sqrt((height * width) / MAX_PIXELS)
    h = Math.floor(height / beta / FACTOR) * FACTOR
    w = Math.floor(width / beta / FACTOR) * FACTOR
  } else if (h * w < MIN_PIXELS) {
    const beta = Math.sqrt(MIN_PIXELS / (height * width))
    h = Math.ceil((height * beta) / FACTOR) * FACTOR
    w = Math.ceil((width * beta) / FACTOR) * FACTOR
  }
  return { width: w, height: h }
}

/** Noms de touches d'UI-TARS (pyautogui) -> noms connus de pressKey (inputControl.ts). */
const SINGLE_KEYS: Record<string, string> = {
  enter: 'enter', return: 'enter', tab: 'tab', esc: 'escape', escape: 'escape', space: 'space',
  backspace: 'backspace', delete: 'delete', del: 'delete', home: 'home', end: 'end',
  up: 'haut', down: 'bas', left: 'gauche', right: 'droite',
  arrowup: 'haut', arrowdown: 'bas', arrowleft: 'gauche', arrowright: 'droite'
}

/** Défait les échappements Python d'une chaîne entre apostrophes (\', \", \n, \\). */
function unescapePython(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
}

/** Lit un argument nommé `name='…'` (apostrophes ou guillemets, échappements compris). */
function readArg(args: string, name: string): string | null {
  const match = args.match(new RegExp(`${name}\\s*=\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`))
  return match ? unescapePython(match[2]) : null
}

/** Centre d'une zone « (x,y) » ou « (x1,y1,x2,y2) », balises <|box_start|> comprises ou non. */
function readPoint(box: string | null): [number, number] | null {
  if (!box) return null
  const numbers = box.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  if (!numbers || (numbers.length !== 2 && numbers.length !== 4)) return null
  const [x1, y1, x2 = x1, y2 = y1] = numbers
  return [(x1 + x2) / 2, (y1 + y2) / 2]
}

/**
 * Traduit la réponse d'UI-TARS en action. `width`/`height` : taille de l'image envoyée, pour ramener la position
 * du repère du modèle (smartResize) aux pixels de cette image. `null` = réponse inexploitable (pas d'« Action: »,
 * action inconnue, position absente ou hors de l'image).
 */
export function parseUiTarsResponse(content: string, width: number, height: number): UiTarsStep | null {
  const actionLine = content.match(/Action:\s*([\s\S]*)$/)?.[1]?.trim()
  if (!actionLine) return null
  const call = actionLine.match(/^(\w+)\(([\s\S]*)\)\s*$/)
  if (!call) return null
  const [, name, args] = call
  const raw = actionLine.split('\n')[0]

  const point = (): { x: number; y: number } | null => {
    const p = readPoint(readArg(args, 'start_box'))
    if (!p) return null
    const seen = smartResize(width, height)
    const x = Math.round((p[0] * width) / seen.width)
    const y = Math.round((p[1] * height) / seen.height)
    return x >= 0 && y >= 0 && x <= width && y <= height ? { x, y } : null
  }

  switch (name) {
    case 'click':
    case 'left_single':
    case 'left_double':
    case 'right_single': {
      const p = point()
      if (!p) return null
      const action = name === 'left_double' ? 'double_click' : name === 'right_single' ? 'right_click' : 'click'
      return { action, ...p, raw }
    }
    case 'type': {
      const content = readArg(args, 'content')
      if (content === null) return null
      const submit = /\n$/.test(content)
      const text = content.replace(/\n+$/, '')
      // « type(content='\n') » seul = juste valider : c'est la touche Entrée, rien à taper.
      if (!text.trim()) return submit ? { action: 'key', key: 'enter', raw } : null
      return { action: 'type', text, submit, raw }
    }
    case 'hotkey': {
      const keys = (readArg(args, 'key') ?? '').toLowerCase().split(/[\s+]+/).filter(Boolean)
      if (!keys.length) return null
      if (keys.length === 1) {
        const key = SINGLE_KEYS[keys[0]]
        return key ? { action: 'key', key, raw } : { action: 'hotkey', keys, raw }
      }
      return { action: 'hotkey', keys, raw }
    }
    case 'scroll': {
      const direction = readArg(args, 'direction')?.toLowerCase()
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') return null
      // Sans position, on fait défiler là où se trouve déjà la souris.
      const p = readArg(args, 'start_box') === null ? {} : point()
      if (!p) return null
      return { action: 'scroll', direction, ...p, raw }
    }
    case 'wait':
      return { action: 'wait', raw }
    case 'finished':
      return { action: 'done', result: readArg(args, 'content') ?? '', raw }
    case 'call_user':
      return { action: 'fail', result: "J'ai besoin de toi pour continuer : regarde l'écran.", raw }
    default:
      return null
  }
}
