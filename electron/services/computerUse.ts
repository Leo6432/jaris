import { config } from '../config'
import { getLiveGpuStatus, pickSafeVisionModel } from './hardwareScan'
import { listInstalledModels } from './ollama'
import { hideScanOverlay, showScanOverlay } from './scanOverlay'
import type { NativeImage } from 'electron'
import { clickMouse, pressKey, typeText } from './inputControl'
import { aimWithMaiUi, type MaiUiDeps } from './maiUi'
import { getProfile } from './profileStore'
import { PILOT_MODEL } from '../../shared/pilotModel'
import { capturePilotScreen, type PilotCapture } from './markedCapture'
import { withJarisSetAside } from './pilotWindows'
import { markCenter, type ScreenMark } from './screenMarks'
import { describeElements, findElementByName, type ClickableElement } from './uiAutomation'
import { MAX_SCREENSHOT_WIDTH } from './vision'

/**
 * Convertit une coordonnée renvoyée par le modèle de vision (repérée sur l'image réduite à
 * MAX_SCREENSHOT_WIDTH, voir vision.ts) en coordonnée réelle à l'écran, en appliquant le facteur `scale` de
 * la capture correspondante — sans cette conversion, un clic pourtant bien repéré par le modèle sur l'image
 * atterrissait ailleurs sur le vrai écran dès que celui-ci dépasse MAX_SCREENSHOT_WIDTH de large (repéré par
 * une relecture externe du code, jamais testé en usage réel avant, la plupart des essais de Léo n'étant
 * jamais allés jusqu'à un vrai clic).
 */
function toScreenCoord(value: number | undefined, scale: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * scale) : null
}

/**
 * Vérification de la campagne de tests de Léo (05/10/2026) : la consigne demandait des pixels, mais les modèles de
 * vision (Qwen3-VL, Qwen3.5, Gemma 4 26B/31B, GLM-4.6V…) répondaient quand même sur une échelle de 0 à 1000 — leur
 * convention d'entraînement. Lus comme des pixels, leurs clics tombaient à côté : qwen3.8:27b visait juste 9 fois
 * sur 10 lu en 0–1000, 3 fois sur 10 lu en pixels. La consigne demande donc maintenant cette échelle, ramenée ici
 * aux pixels de l'image envoyée. Une valeur au-delà de 1000 ne peut être qu'un pixel : un modèle qui répond
 * quand même en pixels reste compris.
 */
export function fromThousandths(x: number | undefined, y: number | undefined, width: number, height: number): { x?: number; y?: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return { x, y }
  if (x > 1000 || y > 1000) return { x, y }
  return { x: (x / 1000) * width, y: (y / 1000) * height }
}

/**
 * Agent "computer use" (étape 34, remplace l'ancien pilotage Chrome dédié par CDP/Playwright et l'envoi de
 * mail par API Gmail) : Jaris n'a plus de fenêtre séparée ni de compte à connecter — il regarde une vraie
 * capture d'écran, décide de la prochaine action de souris/clavier comme le ferait une personne, l'exécute,
 * reprend une capture, et recommence jusqu'à ce que l'objectif soit atteint (ou clairement bloqué). Plus lent
 * et moins fiable qu'un appel d'API directe (dépend de la capacité du modèle de vision local à repérer un
 * bouton en pixels, jamais garantie sur un petit modèle), mais fonctionne sur n'importe quel site/appli sans
 * configuration préalable — choix assumé (voir conversation avec Léo, 2026-09-07).
 */

const MAX_STEPS = 20
const MAX_CONSECUTIVE_WAITS = 3
/**
 * Étape 255 — Léo : « Échec de l'outil : Impossible de joindre le modèle de vision : The operation was aborted due
 * to timeout ». Son modèle de vision est qwen3.8:27b (17 Go) sur une carte de 8 Go : le charger, en partie en
 * mémoire vive, puis lire la capture dépassait la limite FIXE de 45 s par étape — alors que le modèle travaillait.
 * Même leçon que l'étape 98 pour les téléchargements : une durée qui dépend de la machine se surveille par
 * l'INACTIVITÉ, jamais par une durée totale. Les réponses arrivent en continu (stream) : on attend le premier
 * morceau jusqu'à FIRST_CHUNK_TIMEOUT_MS (chargement du modèle + lecture de l'image, une seule fois par appel),
 * puis on n'abandonne que si plus rien n'arrive pendant IDLE_TIMEOUT_MS. Le compteur de l'écran vocal (étape 252)
 * montre pendant ce temps que Jaris attend, il n'est pas figé.
 */
const FIRST_CHUNK_TIMEOUT_MS = 180_000
const IDLE_TIMEOUT_MS = 45_000
/** Même contexte qu'au duel, où le viseur a été mesuré : une image et une consigne courte n'en demandent pas plus. */
const PILOT_NUM_CTX = 8192

interface ComputerUseStep {
  /** `look` : réponse du planificateur sans image (étape 256) — « la liste ne suffit pas, regarde l'écran ». */
  action: 'click_element' | 'click' | 'double_click' | 'right_click' | 'type' | 'key' | 'wait' | 'done' | 'fail' | 'look'
  x?: number
  y?: number
  /** Nom de l'élément visé pour `click_element` (voir uiAutomation.ts, étape 32). */
  name?: string
  /** Étape 256 : numéro de l'élément visé pour `click_element`, tel qu'il est dessiné sur la capture. */
  id?: number
  /** Étape 251 : l'élément visé par un clic par position, décrit pour le viseur (MAI-UI). */
  target?: string
  text?: string
  key?: string
  result?: string
}

export const SYSTEM_PROMPT =
  'Tu es un agent qui contrôle un ordinateur Windows à la souris et au clavier, exactement comme le ferait ' +
  "un humain, à partir de captures d'écran successives. On te donne un objectif et l'historique des actions " +
  'déjà faites. Réponds UNIQUEMENT par un objet JSON décrivant la PROCHAINE action à faire, sans aucun texte ' +
  'autour, sans balises de code : ' +
  '{"action":"click_element","name":"<nom EXACT d\'un élément de la liste fournie>"} — À PRÉFÉRER dès que ' +
  "la cible figure dans la liste des éléments cliquables détectés par Windows : leur position est donnée par " +
  "le système, donc exacte, alors qu'un clic par position n'est qu'une estimation faite sur l'image. " +
  '{"action":"click","x":<0 à 1000>,"y":<0 à 1000>} ou "double_click"/"right_click" pareil — à utiliser seulement ' +
  "quand la cible n'est PAS dans cette liste (jeu, interface dessinée sur mesure, liste vide). " +
  '{"action":"type","text":"<texte à taper au clavier>"} (tape à l\'endroit du dernier clic, clique d\'abord ' +
  'sur le bon champ si besoin), ' +
  '{"action":"key","key":"<entrée|tab|échap|espace|retour arrière|suppr|haut|bas|gauche|droite|début|fin>"}, ' +
  '{"action":"wait"} (la page est en train de charger, rien à cliquer pour l\'instant), ' +
  '{"action":"done","result":"<résumé bref de ce qui a été accompli>"} UNIQUEMENT quand CHAQUE partie de ' +
  "l'objectif est visiblement accomplie sur la dernière capture — jamais dès qu'une PREMIÈRE partie est " +
  'faite. Exemple concret : pour "ouvre YouTube et cherche un tuto guitare", ouvrir YouTube ne suffit pas : ' +
  "il faut aussi avoir cliqué sur la barre de recherche, tapé la requête, ET lancé la recherche (touche " +
  "entrée ou clic sur la loupe) avant de répondre \"done\" — répondre \"done\" après la seule ouverture " +
  'alors que le reste de l\'objectif n\'est pas fait est une erreur grave, ça laisse la tâche à moitié ' +
  "terminée sans que l'utilisateur ne le sache. Avant de répondre \"done\", relis l'objectif complet et " +
  "vérifie mentalement chaque verbe d'action qu'il contient un par un. " +
  '{"action":"fail","result":"<pourquoi c\'est bloqué>"} si un élément reste introuvable après plusieurs ' +
  "essais ou qu'une page d'erreur/de connexion bloque la suite — jamais boucler indéfiniment sur le même " +
  'échec. x/y sont des positions sur une échelle de 0 à 1000 : x=0 bord gauche et x=1000 bord droit de ' +
  "l'image, y=0 bord haut et y=1000 bord bas. Une seule action par réponse."

/**
 * Étape 251 : ajouté à SYSTEM_PROMPT seulement quand le viseur (MAI-UI) est installé — SYSTEM_PROMPT lui-même reste
 * identique, sa copie sert au test des modèles de vision (scripts/benchmark-vision.mjs). La description est
 * demandée en anglais, comme la consigne du duel où le viseur a été mesuré (« Click on the "Rechercher" button »),
 * le texte affiché à l'écran restant tel quel entre guillemets.
 */
export const PILOT_TARGET_RULE =
  'Pour click, double_click et right_click, ajoute aussi "target":"<l\'élément visé décrit en anglais en quelques ' +
  'mots, avec son texte exact entre guillemets s\'il en a un, par exemple : the \\"Rechercher\\" button>" : un modèle ' +
  'spécialisé dans la visée s\'en sert pour cliquer précisément, ta position x/y ne sert que de secours.'

/**
 * Étape 256 (Set-of-Marks) : ajouté à SYSTEM_PROMPT quand des éléments sont numérotés sur la capture — SYSTEM_PROMPT
 * lui-même reste identique, sa copie sert au test des modèles de vision (scripts/benchmark-vision.mjs).
 */
export const MARKS_RULE =
  'Les éléments de la liste sont encadrés et numérotés sur la capture : pour cliquer l\'un d\'eux, réponds ' +
  '{"action":"click_element","id":<son numéro>} — c\'est le clic le plus sûr, sa position vient de Windows.'

/**
 * Étape 256 — planifier sans image. Quand Windows donne une liste fournie des boutons de la fenêtre (navigateur,
 * Discord, Explorateur…), le modèle de conversation rapide (palier Médium) choisit l'action d'après cette liste,
 * sans capture : quelques secondes au lieu d'une minute pour un gros modèle de vision, qui reste le recours dès que
 * la liste ne suffit pas (`look`). Même méthode que le mode « ax » d'Hermes Agent (tools/computer_use).
 */
export const TEXT_PLANNER_PROMPT =
  'Tu pilotes un ordinateur Windows à la souris et au clavier pour atteindre un objectif, SANS voir l\'écran : à ' +
  "chaque tour on te donne l'objectif, les actions déjà faites, le titre de la fenêtre au premier plan et la liste " +
  'numérotée de ses éléments cliquables, telle que Windows la donne (numéro, type, nom). Réponds UNIQUEMENT par un ' +
  'objet JSON décrivant la PROCHAINE action : ' +
  '{"action":"click_element","id":<numéro d\'un élément de la liste>}, ' +
  '{"action":"type","text":"<texte à taper au clavier>"} (tape là où se trouve le curseur : clique d\'abord sur le ' +
  'bon champ), ' +
  '{"action":"key","key":"<entrée|tab|échap|espace|retour arrière|suppr|haut|bas|gauche|droite|début|fin>"}, ' +
  '{"action":"wait"} (la page est en train de charger), ' +
  '{"action":"done","result":"<résumé bref de ce qui a été accompli>"} UNIQUEMENT quand CHAQUE partie de ' +
  "l'objectif est faite — pour \"ouvre YouTube et cherche un tuto guitare\", il faut avoir cliqué sur la barre de " +
  'recherche, tapé la requête ET lancé la recherche ; relis chaque verbe de l\'objectif avant de répondre "done". ' +
  '{"action":"fail","result":"<pourquoi c\'est bloqué>"}, ' +
  '{"action":"look"} dès que la liste ne suffit pas pour décider : l\'élément voulu n\'y figure pas, ou il faut VOIR ' +
  "l'écran (une image, une vidéo, une couleur, une position, vérifier un résultat). Ne devine jamais un numéro : " +
  'dans le doute, réponds look. Une seule action par réponse.'

/** Forme imposée à la réponse (sortie structurée d'Ollama) : un petit modèle ne peut pas écrire autre chose. */
export const TEXT_STEP_FORMAT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click_element', 'type', 'key', 'wait', 'done', 'fail', 'look'] },
    id: { type: 'integer' },
    text: { type: 'string' },
    key: { type: 'string' },
    result: { type: 'string' }
  },
  required: ['action']
}

/** Sous ce nombre de boutons, la liste décrit trop peu la fenêtre pour décider sans la voir. */
export const MIN_MARKS_FOR_TEXT = 5
/** Deux « regarde l'écran » dans une tâche : la liste ne suffit pas ici, on ne la propose plus jusqu'à la fin. */
const MAX_TEXT_LOOKS = 2
/**
 * Étape 259 : sans voir l'écran, le planificateur ne voit pas qu'un clic n'a pas l'effet voulu, et peut reprendre
 * indéfiniment le même bouton (reproduit sur la Calculatrice : « Sept » huit fois de suite). Au 3e clic identique
 * d'affilée, la vision reprend la main : elle, voit le résultat affiché.
 */
export const MAX_SAME_TEXT_CLICKS = 3

interface OllamaChatResponse {
  message?: { content?: string }
}

/**
 * Un appel à Ollama en continu : renvoie le texte complet, ou lève une erreur en français qui dit ce qui s'est
 * passé (rien reçu du tout, ou réponse interrompue). Une annulation demandée (`signal`) remonte telle quelle.
 */
export async function streamOllamaChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  let silence: 'first' | 'idle' | null = null
  const arm = (kind: 'first' | 'idle', ms: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      silence = kind
      controller.abort()
    }, ms)
  let timer = arm('first', FIRST_CHUNK_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ ...body, stream: true })
    })
    if (!response.ok) throw new Error(`Ollama a répondu ${response.status} : ${(await response.text()).slice(0, 300)}`)
    if (!response.body) throw new Error('Ollama a répondu sans contenu.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const take = (line: string): void => {
      if (!line.trim()) return
      const chunk = JSON.parse(line) as OllamaChatResponse & { error?: string }
      if (chunk.error) throw new Error(chunk.error)
      content += chunk.message?.content ?? ''
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Tout morceau compte comme un signe de vie, même la réflexion cachée d'un modèle qui pense avant d'écrire.
      clearTimeout(timer)
      timer = arm('idle', IDLE_TIMEOUT_MS)
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(take)
    }
    take(buffer + decoder.decode())
    return content.trim()
  } catch (err) {
    if (silence === 'first') throw new Error(`il n'a rien répondu en ${Math.round(FIRST_CHUNK_TIMEOUT_MS / 60000)} min (chargement ou lecture de l'image trop long sur cette machine)`)
    if (silence === 'idle') throw new Error(`il s'est arrêté de répondre pendant ${IDLE_TIMEOUT_MS / 1000} s`)
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function resolveVisionModel(preferred: string): Promise<string> {
  try {
    const [live, installedModels] = await Promise.all([getLiveGpuStatus(), listInstalledModels()])
    if (live.freeVramGb !== null) return pickSafeVisionModel(live.freeVramGb, installedModels, preferred)
  } catch {
    // Pas grave si le check échoue : on garde le modèle normalement configuré pour cette tâche.
  }
  return preferred
}

/** Extrait le premier objet JSON de la réponse : un petit modèle local entoure parfois sa réponse de texte
    ou de balises ```json malgré la consigne, plutôt que de renvoyer que le JSON demandé. */
export function extractStep(raw: string): ComputerUseStep | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<ComputerUseStep>
    if (!['click_element', 'click', 'double_click', 'right_click', 'type', 'key', 'wait', 'done', 'fail'].includes(parsed.action ?? '')) return null
    if (parsed.action === 'click_element') {
      // Étape 256 : par son numéro sur la capture (Set-of-Marks), ou par son nom comme avant.
      const id = typeof parsed.id === 'string' && /^\d+$/.test(parsed.id) ? Number(parsed.id) : parsed.id
      if (typeof id === 'number' && Number.isInteger(id) && id > 0) parsed.id = id
      else if (!(typeof parsed.name === 'string' && parsed.name.trim())) return null
      else delete parsed.id
    }
    if (['click', 'double_click', 'right_click'].includes(parsed.action ?? '') &&
      !(typeof parsed.x === 'number' && Number.isFinite(parsed.x) && parsed.x >= 0 &&
        typeof parsed.y === 'number' && Number.isFinite(parsed.y) && parsed.y >= 0)) return null
    if (parsed.action === 'type' && !(typeof parsed.text === 'string' && parsed.text.trim())) return null
    if (parsed.action === 'key' && !(typeof parsed.key === 'string' && parsed.key.trim())) return null
    if (parsed.result !== undefined && typeof parsed.result !== 'string') return null
    if (parsed.target !== undefined && typeof parsed.target !== 'string') return null
    return parsed as ComputerUseStep
  } catch {
    return null
  }
}

/**
 * Le message d'une étape de pilotage par le modèle de vision. Exporté (étape 233) : le test de visée des modèles
 * (scripts/benchmark-vision.mjs) en garde une copie, vérifiée identique à celle-ci.
 */
export function buildStepPrompt(goal: string, history: string[], elements: ClickableElement[]): string {
  const historyText = history.length ? `Actions déjà faites :\n${history.join('\n')}` : 'Aucune action encore faite.'
  // Liste vide = fenêtre sans arbre d'accessibilité exploitable (jeu, rendu sur mesure) : on le DIT au modèle
  // plutôt que de ne rien mettre, sinon il peut croire que la liste a juste été oubliée et attendre au lieu
  // de repasser au clic en pixels.
  const marked = elements.some((element) => element.id !== undefined)
  const elementsText = !elements.length
    ? "Windows n'expose aucun élément cliquable pour cette fenêtre : utilise les clics par position (x/y de 0 à 1000)."
    : marked
      ? `Éléments cliquables détectés par Windows, encadrés et numérotés sur la capture (positions exactes, à préférer) :\n${describeElements(elements)}`
      : `Éléments cliquables détectés par Windows (positions exactes, à préférer) :\n${describeElements(elements)}`
  return `Objectif : ${goal}\n\n${historyText}\n\n${elementsText}\n\nCapture d'écran actuelle jointe. Quelle est la prochaine action ?`
}

/** Le message d'une étape planifiée sans image (étape 256) : la liste numérotée tient lieu de capture. */
export function buildTextStepPrompt(goal: string, history: string[], window: string | undefined, marks: ClickableElement[]): string {
  const historyText = history.length ? `Actions déjà faites :\n${history.join('\n')}` : 'Aucune action encore faite.'
  const windowText = window ? `Fenêtre au premier plan : « ${window} »` : 'Fenêtre au premier plan : sans titre connu'
  return `Objectif : ${goal}\n\n${historyText}\n\n${windowText}\n\nÉléments cliquables (numéro. [type] nom) :\n${describeElements(marks)}\n\nQuelle est la prochaine action ?`
}

/**
 * La réponse du planificateur sans image, ou `null` si elle n'est pas exécutable — dont un numéro qui n'est pas
 * dans la liste : c'est le modèle de vision qui prend alors l'étape, jamais un clic au hasard.
 */
export function extractTextStep(raw: string, marks: Array<{ id: number }>): ComputerUseStep | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<ComputerUseStep>
    switch (parsed.action) {
      case 'click_element':
        return typeof parsed.id === 'number' && marks.some((m) => m.id === parsed.id) ? { action: 'click_element', id: parsed.id } : null
      case 'type':
        return typeof parsed.text === 'string' && parsed.text.trim() ? { action: 'type', text: parsed.text } : null
      case 'key':
        return typeof parsed.key === 'string' && parsed.key.trim() ? { action: 'key', key: parsed.key } : null
      case 'wait':
      case 'look':
        return { action: parsed.action }
      case 'done':
      case 'fail':
        return { action: parsed.action, result: typeof parsed.result === 'string' ? parsed.result : undefined }
      default:
        return null
    }
  } catch {
    return null
  }
}

async function nextStep(
  goal: string,
  history: string[],
  capture: PilotCapture,
  visionModel: string,
  signal?: AbortSignal,
  withPilot = false
): Promise<ComputerUseStep> {
  const model = await resolveVisionModel(visionModel)

  // Étape 255 : plus de limite fixe — voir streamOllamaChat (inactivité, pas durée totale). Le signal d'annulation
  // (nouvelle phrase à la voix) reste transmis : une tâche lancée peut toujours être interrompue.
  let content: string
  try {
    content = await streamOllamaChat(
      {
        model,
        messages: [
          { role: 'system', content: [SYSTEM_PROMPT, capture.marks.length ? MARKS_RULE : '', withPilot ? PILOT_TARGET_RULE : ''].filter(Boolean).join('\n\n') },
          { role: 'user', content: buildStepPrompt(goal, history, capture.marks), images: [capture.imageBase64] }
        ],
        think: false,
        options: { num_ctx: config.ollama.numCtx }
      },
      signal
    )
  } catch (err) {
    return { action: 'fail', result: `Le modèle de vision ${model} n'a pas pu regarder l'écran : ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!content) return { action: 'fail', result: 'Réponse vide du modèle de vision.' }

  const step = extractStep(content)
  if (!step) return { action: 'fail', result: `Le modèle de vision ${model} a proposé une action inexécutable : ${content.slice(0, 300)}` }
  // Positions sur 0–1000 ramenées aux pixels de l'image ; toScreenCoord les porte ensuite à l'écran réel.
  return { ...step, ...fromThousandths(step.x, step.y, capture.width, capture.height) }
}

/**
 * Une étape planifiée sans image (étape 256). `error` : le modèle n'a pas pu répondre (on ne le resollicite plus
 * pour cette tâche) ; `step: null` : réponse inexécutable, l'étape revient au modèle de vision.
 */
async function nextTextStep(
  goal: string,
  history: string[],
  capture: PilotCapture,
  model: string,
  signal?: AbortSignal
): Promise<{ step: ComputerUseStep | null; error?: string }> {
  let content: string
  try {
    content = await streamOllamaChat(
      {
        model,
        messages: [
          { role: 'system', content: TEXT_PLANNER_PROMPT },
          { role: 'user', content: buildTextStepPrompt(goal, history, capture.window, capture.marks) }
        ],
        think: false,
        format: TEXT_STEP_FORMAT,
        options: { num_ctx: config.ollama.numCtx, temperature: 0 }
      },
      signal
    )
  } catch (err) {
    return { step: null, error: err instanceof Error ? err.message : String(err) }
  }
  return { step: extractTextStep(content, capture.marks) }
}

/**
 * Étape 256 : le modèle qui planifie sans image — le palier Médium du profil, souvent déjà chargé pour la conversation
 * qui a lancé la tâche. `null` (pas de profil, modèle supprimé) : chaque étape passe par le modèle de vision.
 */
async function resolveTextPlannerModel(): Promise<string | null> {
  try {
    const medium = (await getProfile())?.models?.medium
    if (!medium) return null
    const installed = await listInstalledModels()
    return installed.includes(medium) || installed.includes(`${medium}:latest`) ? medium : null
  } catch {
    return null
  }
}

/**
 * Étape 231 : le viseur (MAI-UI depuis l'étape 251, shared/pilotModel.ts) s'il est installé sur cette machine,
 * sinon `null` — le modèle de vision vise alors lui-même, comme avant. Vérifié auprès d'Ollama à chaque tâche : un
 * profil qui le cite alors qu'il a été supprimé à la main ne doit pas faire échouer le pilotage. Un profil qui cite
 * encore l'ANCIEN modèle (UI-TARS, avant l'étape 251) n'a pas de viseur tant que la configuration n'a pas été
 * retestée : UI-TARS ne comprend pas la consigne de visée de MAI-UI.
 */
async function resolvePilotModel(): Promise<string | null> {
  try {
    const pilot = (await getProfile())?.pilotModel
    if (pilot !== PILOT_MODEL) return null
    const installed = await listInstalledModels()
    return installed.includes(pilot) || installed.includes(`${pilot}:latest`) ? pilot : null
  } catch {
    return null
  }
}

/** Un appel au viseur (MAI-UI), température 0 : la même capture doit donner le même clic, pas un tirage au sort. */
async function callPilot(
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string; images?: string[] }>,
  signal?: AbortSignal
): Promise<string> {
  const content = await streamOllamaChat({ model, messages, options: { num_ctx: PILOT_NUM_CTX, temperature: 0 } }, signal)
  if (!content) throw new Error('réponse vide du viseur')
  return content
}

/**
 * Libère la carte graphique après la visée : le modèle de vision choisit sa taille selon la mémoire vidéo LIBRE
 * (resolveVisionModel) — avec le viseur encore chargé (6 Go), il se rabattrait sur un plus petit modèle à
 * l'étape suivante. Sans conséquence si ça échoue : Ollama finit par le décharger tout seul.
 */
async function unloadPilot(model: string): Promise<void> {
  try {
    await fetch(`${config.ollama.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10000)
    })
  } catch {
    // Rien à faire : voir plus haut.
  }
}

/** La capture à pleine résolution, vue par le viseur : entière ou recadrée, réduite à la largeur habituelle. */
function pilotView(full: NativeImage): Pick<MaiUiDeps, 'width' | 'height' | 'view'> {
  const { width, height } = full.getSize()
  return {
    width,
    height,
    view: async (rect) => {
      let image = rect ? full.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }) : full
      if (image.getSize().width > MAX_SCREENSHOT_WIDTH) image = image.resize({ width: MAX_SCREENSHOT_WIDTH, quality: 'best' })
      const size = image.getSize()
      return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height }
    }
  }
}

/**
 * Exécute un objectif de bout en bout (envoyer un mail, chercher quelque chose sur un site, remplir un
 * formulaire...) en pilotant réellement la souris et le clavier, capture d'écran par capture d'écran.
 * `MAX_STEPS` évite une boucle infinie si le modèle de vision reste bloqué sans jamais renvoyer "done"/"fail".
 * Étape 256 : la fenêtre de Jaris s'écarte le temps de la tâche (pilotWindows.ts), sinon c'est elle qu'on piloterait.
 */
export async function computerUseTask(
  goal: string,
  visionModel: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!goal.trim()) return "Dis-moi ce qu'il faut faire à l'écran."
  return withJarisSetAside(() => runComputerUseTask(goal, visionModel, onProgress, signal))
}

async function runComputerUseTask(
  goal: string,
  visionModel: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const history: string[] = []
  let consecutiveWaits = 0
  const [pilotModel, plannerModel] = await Promise.all([resolvePilotModel(), resolveTextPlannerModel()])
  let textPlanning = plannerModel !== null
  let textLooks = 0
  let fallbackNoted = false
  let lastTextClick: number | undefined
  let sameTextClicks = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    // Vérifié à chaque itération (nouvelle phrase à la voix qui annule la réflexion en cours, voir
    // voicePipeline.ts) : sans ça, une fois lancée, cette boucle de clics ne pouvait plus jamais être
    // interrompue avant MAX_STEPS ou la fin naturelle de l'objectif, contrairement au reste de la
    // conversation.
    if (signal?.aborted) return "Tâche interrompue avant d'être terminée."

    // Chaque itération (capture + appel au modèle de vision) peut prendre plusieurs minutes (voir streamOllamaChat) sur
    // une machine chargée ou sans GPU — sans un signe de vie régulier, ça ressemble à un plantage silencieux
    // plutôt qu'à une réflexion lente (constaté en usage réel : Léo pensait Jaris bloqué après plusieurs
    // minutes sans aucune action visible). Le fil de discussion (ChatPanel.tsx, via window.jaris.onLog)
    // affiche cette ligne en direct pendant que ça tourne.
    onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : je regarde l'écran…`)

    // Étape 256 : la capture porte les boutons de la fenêtre visée, numérotés (Set-of-Marks). Sans réponse de
    // Windows, la capture d'avant, sans numéros : le pilotage par position reste possible.
    let capture: PilotCapture
    try {
      capture = await capturePilotScreen((reason) => {
        if (!fallbackNoted) onProgress?.(`Boutons numérotés indisponibles (${reason}) : je pilote d'après l'image seule.`)
        fallbackNoted = true
      })
    } catch (err) {
      throw new Error(`Impossible de capturer l'écran : ${err instanceof Error ? err.message : String(err)}`)
    }

    showScanOverlay()
    let step: ComputerUseStep | null = null
    let fromText = false
    try {
      // Étape 256 : d'abord le modèle rapide, d'après la seule liste des boutons ; le modèle de vision si elle ne
      // suffit pas. Rien de fait encore et déjà « fini » ? Sans image, ce serait une supposition : la vision vérifie.
      if (textPlanning && plannerModel && capture.marks.length >= MIN_MARKS_FOR_TEXT) {
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : je lis les boutons de la fenêtre…`)
        const planned = await nextTextStep(goal, history, capture, plannerModel, signal)
        if (planned.error) {
          if (signal?.aborted) return "Tâche interrompue avant d'être terminée."
          textPlanning = false
          onProgress?.(`Lecture des boutons par ${plannerModel} impossible (${planned.error}) : je continue avec l'image.`)
        } else if (!planned.step || planned.step.action === 'look') {
          if (++textLooks >= MAX_TEXT_LOOKS) textPlanning = false
        } else if (!(planned.step.action === 'done' && history.length === 0)) {
          step = planned.step
          fromText = true
        }
        if (!step) onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : je regarde l'écran de plus près…`)
      }
      if (signal?.aborted) return "Tâche interrompue avant d'être terminée."
      if (!step) step = await nextStep(goal, history, capture, visionModel, signal, pilotModel !== null)
    } finally {
      hideScanOverlay()
    }

    // Une annulation pendant l'inférence ne doit jamais être suivie d'un clic tardif.
    if (signal?.aborted) return "Tâche interrompue avant d'être terminée."
    if (step.action === 'done') return step.result || 'Fait.'
    // Lever l'erreur active le court-circuit d'assistant.ts : le modèle de conversation ne doit pas
    // masquer ce diagnostic ni relancer dix fois une tâche qui vient d'échouer.
    if (step.action === 'fail') throw new Error(step.result || 'Le pilotage de l’écran a échoué sans préciser pourquoi.')
    consecutiveWaits = step.action === 'wait' ? consecutiveWaits + 1 : 0
    if (consecutiveWaits >= MAX_CONSECUTIVE_WAITS) {
      throw new Error("Le modèle de vision demande seulement d'attendre depuis trois captures consécutives. Je m'arrête sans avoir terminé l'objectif.")
    }

    switch (step.action) {
      case 'click_element': {
        // Étape 256 : par son numéro sur la capture ; par son nom pour un modèle qui reprend l'ancienne forme.
        const label = step.id !== undefined ? `n°${step.id}` : `"${step.name ?? ''}"`
        const target: ScreenMark | null =
          step.id !== undefined ? capture.marks.find((mark) => mark.id === step.id) ?? null : findElementByName(capture.marks, step.name ?? '')
        if (!target) {
          // PAS une erreur fatale, contrairement aux autres actions : c'est le cas de repli prévu par
          // l'étape 32 (élément absent de l'arbre d'accessibilité, ou interface qui a bougé depuis la
          // capture). On le note dans l'historique pour que le modèle le VOIE et repasse au clic en pixels
          // au tour suivant, plutôt que d'abandonner toute la tâche pour un nom mal repris.
          history.push(`${i + 1}. Élément ${label} introuvable dans la liste Windows — reste le clic par position (x/y de 0 à 1000)`)
          onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : élément ${label} introuvable, je repasse en clic direct.`)
          break
        }
        const { x, y } = markCenter(target)
        const result = await clickMouse(x, y, 'left', capture.physical)
        if (!result.startsWith('Clic left effectué')) throw new Error(result)
        history.push(`${i + 1}. Clic sur "${target.name}" (${target.type}, position donnée par Windows)`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : clic sur "${target.name}".`)
        sameTextClicks = fromText && step.id !== undefined && step.id === lastTextClick ? sameTextClicks + 1 : 1
        lastTextClick = fromText ? step.id : undefined
        if (fromText && sameTextClicks >= MAX_SAME_TEXT_CLICKS) {
          textPlanning = false
          onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : même bouton ${MAX_SAME_TEXT_CLICKS} fois de suite, je regarde l'écran pour vérifier.`)
        }
        break
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const button = step.action === 'double_click' ? 'double' : step.action === 'right_click' ? 'right' : 'left'
        let px = step.x
        let py = step.y
        let aimed = ''
        const target = step.target?.trim()
        // Étape 251 : le modèle de vision a décidé QUOI cliquer ; le viseur (MAI-UI) trouve OÙ, avec son zoom.
        if (pilotModel && target) {
          onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : je vise précisément ${target}…`)
          showScanOverlay()
          try {
            const aim = await aimWithMaiUi(target, { ...pilotView(capture.full), chat: (messages) => callPilot(pilotModel, messages, signal) })
            if (aim) {
              px = aim.fx * capture.width
              py = aim.fy * capture.height
              aimed = ' (visé par MAI-UI)'
            } else {
              aimed = ' (viseur sans réponse lisible : position estimée)'
            }
          } catch (err) {
            if (signal?.aborted) return "Tâche interrompue avant d'être terminée."
            // Le viseur est une précision en plus, pas une condition : sans lui, la position estimée reste le secours.
            aimed = ` (viseur indisponible : ${err instanceof Error ? err.message : String(err)} ; position estimée)`
          } finally {
            hideScanOverlay()
            void unloadPilot(pilotModel)
          }
          if (signal?.aborted) return "Tâche interrompue avant d'être terminée."
        }
        const x = toScreenCoord(px, capture.scale)
        const y = toScreenCoord(py, capture.scale)
        const result = await clickMouse(x, y, button, capture.physical)
        if (!result.startsWith(`Clic ${button} effectué`)) throw new Error(result)
        const what = target ? ` sur ${target}` : ''
        history.push(`${i + 1}. Clic ${button}${what} à (${x}, ${y})${aimed}`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : clic ${button}${what} à (${x}, ${y})${aimed}.`)
        break
      }
      case 'type': {
        const result = await typeText(step.text ?? '')
        if (result !== 'Texte tapé.') throw new Error(result)
        history.push(`${i + 1}. Texte tapé : "${step.text ?? ''}"`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : texte tapé.`)
        break
      }
      case 'key': {
        const result = await pressKey(step.key ?? '')
        if (result !== `Touche "${step.key}" pressée.`) throw new Error(result)
        history.push(`${i + 1}. Touche "${step.key ?? ''}" pressée`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : touche "${step.key ?? ''}" pressée.`)
        break
      }
      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, 1200))
        history.push(`${i + 1}. Attente (chargement)`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : attente du chargement de la page…`)
        break
    }
  }

  throw new Error(`Je me suis arrêté après ${MAX_STEPS} étapes sans terminer l'objectif : ${goal}.`)
}
