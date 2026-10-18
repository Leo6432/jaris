import { readFile, rm } from 'fs/promises'
import { config } from '../config'
import { currentLanguage, t } from '../../shared/i18n'
import { getProfile } from './profileStore'
import { ttsClient } from './ttsClient'

/**
 * En français, le "s" final de "Jaris" est normalement muet ("Jari"). "Jarisse" se prononce
 * correctement ("Jariss"), sur le modèle de "Suisse" — uniquement pour la synthèse vocale, le texte
 * affiché à l'écran garde la vraie orthographe. En FRANÇAIS seulement : la phrase est lue avec la prononciation
 * de la langue de Jaris (ttsClient envoie `lang`), et ailleurs le « s » final se prononce déjà — « Jarisse » y
 * ajouterait une syllabe (« Ja-ris-se » en allemand ou en italien).
 */
function toSpeechText(text: string): string {
  return sanitizeForSpeech(currentLanguage() === 'fr' ? text.replace(/\bJaris\b/gi, 'Jarisse') : text)
}

/**
 * Le prompt système interdit déjà les émojis dans les réponses vocales, mais un petit modèle local ne suit
 * pas toujours cette consigne à la lettre (observé : une liste numérotée en émojis "keycap" comme 1️⃣2️⃣3️⃣) —
 * et Supertonic HD n'a tout simplement pas ces caractères dans son vocabulaire : la synthèse entière
 * échouait ("Found N unsupported character(s)"), rendant Jaris silencieusement muet sur toute la réponse
 * (voir le catch dans voicePipeline.speak, qui n'a aucun texte de repli à dire dans ce cas). Filet de
 * sécurité indépendant du prompt : retire les émojis et caractères qui vont avec (sélecteurs de variante,
 * "keycap" combiné, joker zero-width, indicateurs de drapeau) avant d'envoyer à la synthèse, plutôt que de
 * compter uniquement sur le modèle pour ne jamais en produire.
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

/** Synthétise `text` en audio via Supertonic HD, avec la voix choisie dans le menu Options (ou celle de `.env` par défaut). */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const profile = await getProfile()
  const voice = profile?.ttsVoice || config.tts.voice
  const path = await ttsClient.synthesize(toSpeechText(text), voice)
  return readAndCleanup(path)
}

/**
 * Synthétise une phrase d'exemple avec `voice`, pour comparer les voix avant d'en choisir une. La phrase vient du
 * catalogue, dans la langue de Jaris : elle était écrite en dur en français jusqu'à la version 0.34.31, si bien
 * qu'un Allemand entendait une phrase française lue avec la prononciation allemande (la langue envoyée à la voix).
 */
export async function previewVoice(voice: string): Promise<Buffer> {
  const path = await ttsClient.synthesize(toSpeechText(t('options.voice.previewSentence')), voice)
  return readAndCleanup(path)
}
