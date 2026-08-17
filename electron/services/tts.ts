import { readFile, rm } from 'fs/promises'
import { config } from '../config'
import { getProfile } from './profileStore'
import { ttsClient } from './ttsClient'

const PREVIEW_TEXT = 'Bonjour, je suis Jaris, votre assistant vocal. Comment puis-je vous aider aujourd\'hui ?'

/**
 * En français, le "s" final de "Jaris" est normalement muet ("Jari"). "Jarisse" se prononce
 * correctement ("Jariss"), sur le modèle de "Suisse" — uniquement pour la synthèse vocale, le texte
 * affiché à l'écran garde la vraie orthographe.
 */
function toSpeechText(text: string): string {
  return text.replace(/\bJaris\b/gi, 'Jarisse')
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

/** Synthétise une phrase d'exemple fixe avec `voice`, pour comparer les voix avant d'en choisir une. */
export async function previewVoice(voice: string): Promise<Buffer> {
  const path = await ttsClient.synthesize(toSpeechText(PREVIEW_TEXT), voice)
  return readAndCleanup(path)
}
