import { readFile, rm } from 'fs/promises'
import { ttsClient } from './ttsClient'

const PREVIEW_TEXT = 'Bonjour, je suis Jaris, votre assistant vocal. Comment puis-je vous aider aujourd\'hui ?'

/**
 * En français, le "s" final de "Jaris" est normalement muet ("Jari"). "Jarisse" se prononce
 * correctement ("Jariss"), sur le modèle de "Suisse" — uniquement pour la synthèse vocale, le texte
 * affiché à l'écran garde la vraie orthographe.
 */
function toSpeechText(text: string): string {
  return sanitizeForSpeech(text.replace(/\bJaris\b/gi, 'Jarisse'))
}

/**
 * Le prompt système interdit déjà les émojis dans les réponses vocales, mais un petit modèle local ne suit
 * pas toujours cette consigne à la lettre (observé : une liste numérotée en émojis "keycap" comme 1️⃣2️⃣3️⃣) —
 * et Supertonic HD n'avait tout simplement pas ces caractères dans son vocabulaire : la synthèse entière
 * échouait ("Found N unsupported character(s)"), rendant Jaris silencieusement muet sur toute la réponse
 * (voir le catch dans voicePipeline.speak, qui n'a aucun texte de repli à dire dans ce cas). Filet de
 * sécurité indépendant du prompt (et du moteur de synthèse, jamais vérifié à nouveau sur Kokoro) : retire
 * les émojis et caractères qui vont avec (sélecteurs de variante, "keycap" combiné, joker zero-width,
 * indicateurs de drapeau) avant d'envoyer à la synthèse, plutôt que de compter uniquement sur le modèle
 * pour ne jamais en produire.
 */
const TTS_UNSUPPORTED_CHARS = new RegExp(
  '[\\p{Extended_Pictographic}\\p{Variation_Selector}\\p{Regional_Indicator}\\u200D\\u20E3]',
  'gu'
)

function sanitizeForSpeech(text: string): string {
  return text.replace(TTS_UNSUPPORTED_CHARS, '').replace(/[ \t]{2,}/g, ' ').trim()
}

async function readAndCleanup(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } finally {
    await rm(path, { force: true })
  }
}

/** Synthétise `text` en audio via Kokoro-82M. */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const path = await ttsClient.synthesize(toSpeechText(text))
  return readAndCleanup(path)
}

/** Synthétise une phrase d'exemple fixe, pour écouter la voix (Options → Voix). */
export async function previewVoice(): Promise<Buffer> {
  const path = await ttsClient.synthesize(toSpeechText(PREVIEW_TEXT))
  return readAndCleanup(path)
}
