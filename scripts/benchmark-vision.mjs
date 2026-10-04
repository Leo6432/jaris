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
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vision-tests')

/** Augmenté à chaque changement des images ou des jugements : un score d'une autre version est refait. */
export const VISION_TEST_VERSION = 2

/** Chaque image posée 2 fois : de nouvelles images valent mieux que la même répétée. */
export const VISION_REPEATS = 2

/** Minuscules, sans accents : « Réponds » et « reponds » se comparent pareil. */
export function normAnswer(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export const VISION_TEST_CASES = [
  {
    file: 'bloc-notes-courses.png',
    prompt: "Combien d'œufs faut-il acheter d'après la liste affichée à l'écran ? Réponds uniquement avec le nombre.",
    check: (a) => /\b(6|six)\b/.test(a) && !/\b(2|4|deux|quatre)\b/.test(a)
  },
  {
    file: 'erreur-disque.png',
    prompt: "Quel fichier n'a pas pu être enregistré d'après le message d'erreur ? Réponds uniquement avec le nom du fichier.",
    check: (a) => /rapport annuel/.test(a)
  },
  {
    file: 'meteo-villes.png',
    prompt: "Quelle température fait-il à Rennes d'après cette page ? Réponds uniquement avec la température.",
    check: (a) => /\b14\b|quatorze/.test(a) && !/\b(12|16|18)\b|douze|seize|dix-huit/.test(a)
  },
  {
    file: 'premier-plan.png',
    prompt: 'Quelle application est au premier plan, devant les autres fenêtres ? Réponds uniquement avec son nom.',
    check: (a) => /spotify/.test(a) && !/discord/.test(a)
  },
  {
    file: 'tableau-prix.png',
    prompt: 'Quel est le prix du clavier dans ce tableau ? Réponds uniquement avec le prix.',
    check: (a) => /\b49[,.]9/.test(a) && !/\b(19|39|59)[,.]9|\b189\b/.test(a)
  },
  {
    file: 'mails-non-lus.png',
    prompt:
      'Combien de mails non lus (en gras, avec une barre bleue à gauche) y a-t-il dans la boîte de réception ? Réponds uniquement avec le nombre.',
    check: (a) => /\b(4|quatre)\b/.test(a) && !/\b(3|7|trois|sept)\b/.test(a)
  },
  {
    file: 'boutons-enregistrer.png',
    prompt: 'Quel est le texte du bouton tout à droite de la boîte de dialogue ? Réponds uniquement avec ce texte.',
    check: (a) => /annuler/.test(a) && !/enregistrer/.test(a)
  },
  {
    file: 'horloge.png',
    prompt: "Quelle heure affiche l'horloge en bas à droite de l'écran ? Réponds uniquement avec l'heure.",
    check: (a) => /\b14\s*(?:h|:|heures?)\s*37\b|quatorze heures? trente-sept/.test(a)
  },
  {
    file: 'youtube-resultats.png',
    prompt: 'Quel est le titre de la première vidéo de la liste ? Recopie-le exactement.',
    check: (a) => /apprendre la guitare en 10 minutes/.test(a)
  },
  {
    file: 'notification-message.png',
    prompt: "Qui vient d'envoyer un message, d'après la notification ? Réponds uniquement avec son nom.",
    check: (a) => /julie/.test(a)
  }
]

export const VISION_TOTAL = VISION_TEST_CASES.length * VISION_REPEATS

/** Juge une réponse de vision (texte brut du modèle). */
export function isCorrectVisionAnswer(testCase, answer) {
  return Boolean(testCase.check(normAnswer(answer)))
}

/** L'image d'un cas, en base64 comme l'attend Ollama. */
export function loadVisionImage(testCase) {
  return readFileSync(join(IMAGES_DIR, testCase.file)).toString('base64')
}
