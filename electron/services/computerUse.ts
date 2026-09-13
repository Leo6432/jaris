import { config } from '../config'
import { getLiveGpuStatus, pickSafeVisionModel } from './hardwareScan'
import { listInstalledModels } from './ollama'
import { hideScanOverlay, showScanOverlay } from './scanOverlay'
import { clickMouse, pressKey, typeText } from './inputControl'
import { describeElements, findElementByName, listClickableElements, type ClickableElement } from './uiAutomation'
import { captureScreenshotBase64 } from './vision'

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
 * Agent "computer use" (étape 34, remplace l'ancien pilotage Chrome dédié par CDP/Playwright et l'envoi de
 * mail par API Gmail) : Jaris n'a plus de fenêtre séparée ni de compte à connecter — il regarde une vraie
 * capture d'écran, décide de la prochaine action de souris/clavier comme le ferait une personne, l'exécute,
 * reprend une capture, et recommence jusqu'à ce que l'objectif soit atteint (ou clairement bloqué). Plus lent
 * et moins fiable qu'un appel d'API directe (dépend de la capacité du modèle de vision local à repérer un
 * bouton en pixels, jamais garantie sur un petit modèle), mais fonctionne sur n'importe quel site/appli sans
 * configuration préalable — choix assumé (voir conversation avec Léo, 2026-09-07).
 */

const MAX_STEPS = 20
const STEP_TIMEOUT_MS = 45000
const MAX_CONSECUTIVE_WAITS = 3

interface ComputerUseStep {
  action: 'click_element' | 'click' | 'double_click' | 'right_click' | 'type' | 'key' | 'wait' | 'done' | 'fail'
  x?: number
  y?: number
  /** Nom de l'élément visé pour `click_element` (voir uiAutomation.ts, étape 32). */
  name?: string
  text?: string
  key?: string
  result?: string
}

const SYSTEM_PROMPT =
  'Tu es un agent qui contrôle un ordinateur Windows à la souris et au clavier, exactement comme le ferait ' +
  "un humain, à partir de captures d'écran successives. On te donne un objectif et l'historique des actions " +
  'déjà faites. Réponds UNIQUEMENT par un objet JSON décrivant la PROCHAINE action à faire, sans aucun texte ' +
  'autour, sans balises de code : ' +
  '{"action":"click_element","name":"<nom EXACT d\'un élément de la liste fournie>"} — À PRÉFÉRER dès que ' +
  "la cible figure dans la liste des éléments cliquables détectés par Windows : leur position est donnée par " +
  "le système, donc exacte, alors qu'un clic en pixels n'est qu'une estimation faite sur l'image. " +
  '{"action":"click","x":<pixel>,"y":<pixel>} ou "double_click"/"right_click" pareil — à utiliser seulement ' +
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
  'échec. x/y sont des pixels, origine en haut à gauche de l\'image fournie. Une seule action par réponse.'

interface OllamaChatResponse {
  message?: { content?: string }
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
function extractStep(raw: string): ComputerUseStep | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<ComputerUseStep>
    if (!['click_element', 'click', 'double_click', 'right_click', 'type', 'key', 'wait', 'done', 'fail'].includes(parsed.action ?? '')) return null
    if (parsed.action === 'click_element' && !(typeof parsed.name === 'string' && parsed.name.trim())) return null
    if (['click', 'double_click', 'right_click'].includes(parsed.action ?? '') &&
      !(typeof parsed.x === 'number' && Number.isFinite(parsed.x) && parsed.x >= 0 &&
        typeof parsed.y === 'number' && Number.isFinite(parsed.y) && parsed.y >= 0)) return null
    if (parsed.action === 'type' && !(typeof parsed.text === 'string' && parsed.text.trim())) return null
    if (parsed.action === 'key' && !(typeof parsed.key === 'string' && parsed.key.trim())) return null
    if (parsed.result !== undefined && typeof parsed.result !== 'string') return null
    return parsed as ComputerUseStep
  } catch {
    return null
  }
}

async function nextStep(
  goal: string,
  history: string[],
  imageBase64: string,
  elements: ClickableElement[],
  visionModel: string,
  signal?: AbortSignal
): Promise<ComputerUseStep> {
  const model = await resolveVisionModel(visionModel)
  const historyText = history.length ? `Actions déjà faites :\n${history.join('\n')}` : 'Aucune action encore faite.'
  // Liste vide = fenêtre sans arbre d'accessibilité exploitable (jeu, rendu sur mesure) : on le DIT au modèle
  // plutôt que de ne rien mettre, sinon il peut croire que la liste a juste été oubliée et attendre au lieu
  // de repasser au clic en pixels.
  const elementsText = elements.length
    ? `Éléments cliquables détectés par Windows (positions exactes, à préférer) :\n${describeElements(elements)}`
    : "Windows n'expose aucun élément cliquable pour cette fenêtre : utilise les clics en pixels."

  // Combine le timeout par étape avec le signal d'annulation externe (voir computerUseTask) : sans ça, une
  // annulation demandée pendant que cette requête est en vol (nouvelle phrase à la voix qui coupe la
  // réflexion en cours, voir voicePipeline.ts) n'atteignait jamais la boucle de clics — seul l'appel Ollama
  // de la conversation "normale" pouvait être annulé jusqu'ici, jamais computer_use_task une fois lancé.
  const timeoutSignal = AbortSignal.timeout(STEP_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Objectif : ${goal}\n\n${historyText}\n\n${elementsText}\n\nCapture d'écran actuelle jointe. Quelle est la prochaine action ?`, images: [imageBase64] }
        ],
        stream: false,
        think: false,
        options: { num_ctx: config.ollama.numCtx }
      })
    })
  } catch (err) {
    return { action: 'fail', result: `Impossible de joindre le modèle de vision : ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!response.ok) {
    return { action: 'fail', result: `Le modèle de vision ${model} a répondu ${response.status} : ${(await response.text()).slice(0, 300)}` }
  }

  const data = (await response.json()) as OllamaChatResponse
  const content = data.message?.content?.trim()
  if (!content) return { action: 'fail', result: 'Réponse vide du modèle de vision.' }

  const step = extractStep(content)
  if (!step) return { action: 'fail', result: `Le modèle de vision ${model} a proposé une action inexécutable : ${content.slice(0, 300)}` }
  return step
}

/**
 * Exécute un objectif de bout en bout (envoyer un mail, chercher quelque chose sur un site, remplir un
 * formulaire...) en pilotant réellement la souris et le clavier, capture d'écran par capture d'écran.
 * `MAX_STEPS` évite une boucle infinie si le modèle de vision reste bloqué sans jamais renvoyer "done"/"fail".
 */
export async function computerUseTask(
  goal: string,
  visionModel: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!goal.trim()) return "Dis-moi ce qu'il faut faire à l'écran."

  const history: string[] = []
  let consecutiveWaits = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    // Vérifié à chaque itération (nouvelle phrase à la voix qui annule la réflexion en cours, voir
    // voicePipeline.ts) : sans ça, une fois lancée, cette boucle de clics ne pouvait plus jamais être
    // interrompue avant MAX_STEPS ou la fin naturelle de l'objectif, contrairement au reste de la
    // conversation.
    if (signal?.aborted) return "Tâche interrompue avant d'être terminée."

    // Chaque itération (capture + appel au modèle de vision) peut prendre jusqu'à 45s (STEP_TIMEOUT_MS) sur
    // une machine chargée ou sans GPU — sans un signe de vie régulier, ça ressemble à un plantage silencieux
    // plutôt qu'à une réflexion lente (constaté en usage réel : Léo pensait Jaris bloqué après plusieurs
    // minutes sans aucune action visible). Le fil de discussion (ChatPanel.tsx, via window.jaris.onLog)
    // affiche cette ligne en direct pendant que ça tourne.
    onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : je regarde l'écran…`)

    let image: string
    let scale: number
    try {
      ;({ imageBase64: image, scale } = await captureScreenshotBase64())
    } catch (err) {
      throw new Error(`Impossible de capturer l'écran : ${err instanceof Error ? err.message : String(err)}`)
    }

    // Étape 32 : ce que Windows lui-même sait des éléments cliquables de la fenêtre active, pour que le
    // modèle vise un NOM (position exacte) plutôt que des pixels devinés sur l'image. Ne lève jamais et
    // renvoie une liste vide si l'arbre d'accessibilité n'est pas exploitable — le pilotage en pixels
    // d'origine reste alors le repli, exactement comme avant.
    const elements = await listClickableElements()

    showScanOverlay()
    let step: ComputerUseStep
    try {
      step = await nextStep(goal, history, image, elements, visionModel, signal)
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
        const wanted = step.name ?? ''
        const target = findElementByName(elements, wanted)
        if (!target) {
          // PAS une erreur fatale, contrairement aux autres actions : c'est le cas de repli prévu par
          // l'étape 32 (élément absent de l'arbre d'accessibilité, ou interface qui a bougé depuis la
          // capture). On le note dans l'historique pour que le modèle le VOIE et repasse au clic en pixels
          // au tour suivant, plutôt que d'abandonner toute la tâche pour un nom mal repris.
          history.push(`${i + 1}. Élément "${wanted}" introuvable dans la liste Windows — reste le clic en pixels`)
          onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : élément "${wanted}" introuvable, je repasse en clic direct.`)
          break
        }
        const result = await clickMouse(target.x, target.y, 'left')
        if (!result.startsWith('Clic left effectué')) throw new Error(result)
        history.push(`${i + 1}. Clic sur "${target.name}" (${target.type}, position donnée par Windows)`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : clic sur "${target.name}".`)
        break
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const button = step.action === 'double_click' ? 'double' : step.action === 'right_click' ? 'right' : 'left'
        const x = toScreenCoord(step.x, scale)
        const y = toScreenCoord(step.y, scale)
        const result = await clickMouse(x, y, button)
        if (!result.startsWith(`Clic ${button} effectué`)) throw new Error(result)
        history.push(`${i + 1}. Clic ${button} à (${x}, ${y})`)
        onProgress?.(`Étape ${i + 1}/${MAX_STEPS} : clic ${button} à (${x}, ${y}).`)
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
