/**
 * Test de vision, version 2 (étape 232, Léo : améliorer Vision « dans le même lancement »). La version 1 (des
 * aplats de couleur, des carrés, du texte en pixels géants) était trop facile : 10 modèles sur 11 y faisaient
 * 18/18, elle ne départageait plus rien. Ici, de vraies captures d'écran Windows en 1280x720 — la taille exacte de
 * ce que Jaris envoie avec look_at_screen — rendues par un navigateur (scripts/make-vision-tests.mjs) : petit
 * texte, fenêtres qui se chevauchent, une information précise à retrouver parmi d'autres qui lui ressemblent.
 *
 * Chaque jugement accepte les façons normales de répondre (chiffres ou lettres, avec ou sans phrase autour) et
 * refuse les réponses qui citent AUSSI une valeur voisine : « 14 °C » pour Rennes, mais pas « 12 ou 14 ».
 * Vérifié par scripts/test-benchmark-vision.mjs (bonnes et mauvaises réponses pour chaque image).
 *
 * Version 3 (relecture du protocole par ChatGPT, 04/10/2026) : (1) une valeur NIÉE ne compte plus (« ce n'est pas
 * 14 ») ; (2) des cas de VISÉE — le modèle de vision pilote aussi l'écran (computer_use_task) chez qui n'a pas le
 * modèle de pilotage : on lui donne une vraie étape de pilotage (mêmes consignes, même message que Jaris) et on
 * vérifie que son clic tombe DANS l'élément visé, ou qu'il dit « fini » seulement quand c'est vraiment fini.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vision-tests')

/** Augmenté à chaque changement des images ou des jugements : un score d'une autre version est refait. */
export const VISION_TEST_VERSION = 4

/** Chaque image posée 2 fois : de nouvelles images valent mieux que la même répétée. */
export const VISION_REPEATS = 2

/** Minuscules, sans accents : « Réponds » et « reponds » se comparent pareil. */
export function normAnswer(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Une question de lecture : `value` = la bonne réponse, `others` = les valeurs voisines visibles sur l'image (les
 * citer aussi, c'est ne pas savoir). Une bonne valeur précédée d'une négation (« pas 14 ») ne compte pas.
 */
export const VISION_TEST_CASES = [
  {
    file: 'bloc-notes-courses.png',
    prompt: "Combien d'œufs faut-il acheter d'après la liste affichée à l'écran ? Réponds uniquement avec le nombre.",
    value: /\b(6|six)\b/,
    others: /\b(2|4|deux|quatre)\b/
  },
  {
    file: 'erreur-disque.png',
    prompt: "Quel fichier n'a pas pu être enregistré d'après le message d'erreur ? Réponds uniquement avec le nom du fichier.",
    value: /rapport annuel/
  },
  {
    file: 'meteo-villes.png',
    prompt: "Quelle température fait-il à Rennes d'après cette page ? Réponds uniquement avec la température.",
    value: /\b14\b|quatorze/,
    others: /\b(12|16|18)\b|douze|seize|dix-huit/
  },
  {
    file: 'premier-plan.png',
    prompt: 'Quelle application est au premier plan, devant les autres fenêtres ? Réponds uniquement avec son nom.',
    value: /spotify/,
    others: /discord/
  },
  {
    file: 'tableau-prix.png',
    prompt: 'Quel est le prix du clavier dans ce tableau ? Réponds uniquement avec le prix.',
    // Vérification de la campagne (05/10/2026) : « Quarante-neuf euros quatre-vingt-dix centimes » (gemma4:e4b) est
    // juste — les consignes de vision de Jaris demandent une réponse « comme à l'oral », et les lettres étaient
    // déjà acceptées pour les autres questions. Seuls les chiffres l'étaient ici.
    value: /\b49[,.]9|quarante[- ]neuf (euros? (et )?)?(virgule )?(quatre[- ]vingt[- ]dix|neuf)\b/,
    others: /\b(19|39|59)[,.]9|\b189\b/
  },
  {
    file: 'mails-non-lus.png',
    prompt:
      'Combien de mails non lus (en gras, avec une barre bleue à gauche) y a-t-il dans la boîte de réception ? Réponds uniquement avec le nombre.',
    value: /\b(4|quatre)\b/,
    others: /\b(3|7|trois|sept)\b/
  },
  {
    file: 'boutons-enregistrer.png',
    prompt: 'Quel est le texte du bouton tout à droite de la boîte de dialogue ? Réponds uniquement avec ce texte.',
    value: /annuler/,
    others: /enregistrer/
  },
  {
    file: 'horloge.png',
    prompt: "Quelle heure affiche l'horloge en bas à droite de l'écran ? Réponds uniquement avec l'heure.",
    // « 14 37 » (qwen3.5:4b, test de vision v4) est la bonne heure, juste sans « h » : comptée juste.
    value: /\b14\s*(?:h|:|heures?)?\s*37\b|quatorze heures? trente-sept/
  },
  {
    file: 'youtube-resultats.png',
    prompt: 'Quel est le titre de la première vidéo de la liste ? Recopie-le exactement.',
    value: /apprendre la guitare en 10 minutes/
  },
  {
    file: 'notification-message.png',
    prompt: "Qui vient d'envoyer un message, d'après la notification ? Réponds uniquement avec son nom.",
    value: /julie/
  }
]

/** « pas 14 », « ce n'est pas Spotify », « non, 14 » : la valeur est citée pour être écartée. */
const NEGATED = /\b(pas|non|ni|sauf|jamais|plutot que)\s+(?:(?:le|la|les|de|du|d|l|un|une|a|c est)\s+)?$/

/** Juge une réponse de lecture (texte brut du modèle, jamais sa réflexion). */
export function isCorrectVisionAnswer(testCase, answer) {
  const a = normAnswer(answer)
  const value = new RegExp(testCase.value.source, 'g')
  let match
  let found = false
  while ((match = value.exec(a))) {
    if (NEGATED.test(a.slice(Math.max(0, match.index - 30), match.index).replace(/[’']/g, ' '))) return false
    found = true
  }
  return found && !(testCase.others && testCase.others.test(a))
}

/** L'image d'un cas, en base64 comme l'attend Ollama. */
export function loadVisionImage(testCase) {
  return readFileSync(join(IMAGES_DIR, testCase.file)).toString('base64')
}

// ---------------------------------------------------------------------------------------------------------------
// Visée : une étape de computer_use_task (computerUse.ts) — copies vérifiées par scripts/test-benchmark-vision.mjs

export const PILOT_SYSTEM_PROMPT =
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

/** describeElements (uiAutomation.ts). */
function describeElements(elements) {
  if (!elements.length) return ''
  return elements.map((element) => `- [${element.type}] ${element.name.slice(0, 80)}`).join('\n')
}

/** buildStepPrompt (computerUse.ts) : le message d'une étape, ici la toute première (aucune action faite). */
export function buildPilotPrompt(goal, history, elements) {
  const historyText = history.length ? `Actions déjà faites :\n${history.join('\n')}` : 'Aucune action encore faite.'
  const elementsText = elements.length
    ? `Éléments cliquables détectés par Windows (positions exactes, à préférer) :\n${describeElements(elements)}`
    : "Windows n'expose aucun élément cliquable pour cette fenêtre : utilise les clics par position (x/y de 0 à 1000)."
  return `Objectif : ${goal}\n\n${historyText}\n\n${elementsText}\n\nCapture d'écran actuelle jointe. Quelle est la prochaine action ?`
}

/** extractStep (computerUse.ts) : l'action lue dans la réponse, ou `null` si Jaris ne pourrait pas l'exécuter. */
export function extractPilotStep(raw) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (!['click_element', 'click', 'double_click', 'right_click', 'type', 'key', 'wait', 'done', 'fail'].includes(parsed.action ?? '')) return null
    if (parsed.action === 'click_element' && !(typeof parsed.name === 'string' && parsed.name.trim())) return null
    if (['click', 'double_click', 'right_click'].includes(parsed.action ?? '') &&
      !(typeof parsed.x === 'number' && Number.isFinite(parsed.x) && parsed.x >= 0 &&
        typeof parsed.y === 'number' && Number.isFinite(parsed.y) && parsed.y >= 0)) return null
    if (parsed.action === 'type' && !(typeof parsed.text === 'string' && parsed.text.trim())) return null
    if (parsed.action === 'key' && !(typeof parsed.key === 'string' && parsed.key.trim())) return null
    if (parsed.result !== undefined && typeof parsed.result !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

const normName = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** findElementByName (uiAutomation.ts). */
export function findPilotElement(elements, target) {
  const wanted = normName(target)
  if (!wanted) return null
  const named = elements.map((element) => ({ element, name: normName(element.name) }))
  return (
    named.find((c) => c.name === wanted)?.element ??
    named.find((c) => c.name.startsWith(wanted))?.element ??
    named.find((c) => c.name.includes(wanted))?.element ??
    null
  )
}

/** Les boutons de la boîte « Enregistrer ? » tels que Windows les liste (cas de visée par nom). */
const SAVE_DIALOG_ELEMENTS = [
  { name: 'Enregistrer', type: 'Button', target: 'enregistrer' },
  { name: 'Ne pas enregistrer', type: 'Button', target: 'ne-pas-enregistrer' },
  { name: 'Annuler', type: 'Button', target: 'annuler' },
  { name: 'Fermer', type: 'Button', target: null }
]

/**
 * Les cas de visée : `target` = l'élément à atteindre (sa boîte est dans vision-tests/cibles.json, mesurée sur la
 * capture), `expect: 'done'` = l'objectif est déjà atteint à l'écran. `elements` : la liste que Windows donnerait
 * (sinon vide : clic en pixels, comme dans un jeu ou une page dessinée sur mesure).
 */
export const VISION_PILOT_CASES = [
  { id: 'fermer-sans-enregistrer', file: 'boutons-enregistrer.png', goal: 'Ferme le Bloc-notes sans enregistrer les modifications.', target: 'ne-pas-enregistrer' },
  { id: 'annuler-par-nom', file: 'boutons-enregistrer.png', goal: 'Annule la fermeture du Bloc-notes.', target: 'annuler', elements: SAVE_DIALOG_ELEMENTS },
  { id: 'ouvrir-mail', file: 'mails-non-lus.png', goal: 'Ouvre le mail de Marc Dubois.', target: 'mail-marc' },
  { id: 'lancer-video', file: 'youtube-resultats.png', goal: 'Lance la vidéo « Les 5 accords faciles pour débuter ».', target: 'video-accords' },
  { id: 'ouvrir-notification', file: 'notification-message.png', goal: 'Ouvre le message de Julie.', target: 'notification' },
  { id: 'recherche-deja-faite', file: 'youtube-resultats.png', goal: 'Cherche « tuto guitare » sur YouTube.', expect: 'done' },
  // Le piège documenté dans CLAUDE.md : YouTube ouvert ne veut pas dire recherche faite.
  { id: 'recherche-a-faire', file: 'youtube-accueil.png', goal: 'Cherche « tuto guitare » sur YouTube.', target: 'barre-recherche' }
]

/** Chaque cas (lecture ou visée) posé 2 fois. */
export const VISION_TOTAL = (VISION_TEST_CASES.length + VISION_PILOT_CASES.length) * VISION_REPEATS

/** Les boîtes des éléments visés, mesurées en fabriquant les captures (make-vision-tests.mjs). */
export function loadPilotTargets() {
  return JSON.parse(readFileSync(join(IMAGES_DIR, 'cibles.json'), 'utf8'))
}

/** Taille des captures de visée (vision-tests/*.png) : celle de l'image que Jaris envoie au modèle. */
const PILOT_IMAGE_WIDTH = 1280
const PILOT_IMAGE_HEIGHT = 720

/**
 * Marge autour d'une boîte : AUCUNE depuis la relecture du 05/10/2026. Les boîtes sont mesurées sur le rendu
 * même de la capture (cibles.json) et leur bord fait déjà partie de l'élément ; une marge de 4 px comptait justes
 * 5 clics tombés 1 à 3 px AU-DESSUS de la barre de recherche YouTube, qui sur un vrai écran ne la touchent pas.
 */
const AIM_MARGIN = 0

/**
 * Juge une étape de pilotage. `targets` : cibles.json. Renvoie `null` si l'action est la bonne, sinon la raison.
 * Positions sur 0–1000 (consigne de Jaris depuis la campagne du 05/10/2026), ramenées aux pixels de l'image (1280 × 720).
 */
export function judgePilotStep(testCase, raw, targets) {
  const step = extractPilotStep(String(raw ?? ''))
  if (!step) return `action que Jaris ne peut pas exécuter : « ${String(raw ?? '').replace(/\s+/g, ' ').slice(0, 160) || 'réponse vide'} »`
  if (testCase.expect === 'done') return step.action === 'done' ? null : `« done » attendu (c'est déjà fait à l'écran), obtenu « ${step.action} »`
  if (step.action === 'done') return 'dit que c’est fini alors que rien n’est fait'
  const box = targets[testCase.file]?.[testCase.target]
  if (!box) throw new Error(`cible « ${testCase.target} » absente de cibles.json pour ${testCase.file}`)
  if (step.action === 'click_element') {
    const element = findPilotElement(testCase.elements ?? [], step.name)
    if (!element) return `élément « ${step.name} » absent de la liste de Windows`
    return element.target === testCase.target ? null : `clic sur « ${element.name} » au lieu de la cible`
  }
  if (step.action === 'click' || step.action === 'double_click') {
    // fromThousandths (computerUse.ts) : positions 0–1000 ramenées aux pixels de l'image (1280 × 720).
    if (!(step.x > 1000 || step.y > 1000)) Object.assign(step, { x: Math.round((step.x / 1000) * PILOT_IMAGE_WIDTH), y: Math.round((step.y / 1000) * PILOT_IMAGE_HEIGHT) })
    const inside =
      step.x >= box.x - AIM_MARGIN && step.x <= box.x + box.width + AIM_MARGIN && step.y >= box.y - AIM_MARGIN && step.y <= box.y + box.height + AIM_MARGIN
    return inside ? null : `clic à (${step.x}, ${step.y}), hors de la cible (${box.x}–${box.x + box.width}, ${box.y}–${box.y + box.height})`
  }
  return `« ${step.action} » au lieu d'un clic sur la cible`
}
