import { readFile, rm } from 'fs/promises'
import { ttsClient } from './ttsClient'

/**
 * En français, le "s" final de "Jaris" est normalement muet ("Jari"). "Jarisse" se prononce
 * correctement ("Jariss"), sur le modèle de "Suisse" — uniquement pour la synthèse vocale, le texte
 * affiché à l'écran garde la vraie orthographe.
 */
function toSpeechText(text: string): string {
  return text.replace(/\bJaris\b/gi, 'Jarisse')
}

/** Synthétise `text` en audio via Supertonic HD (sidecar Python persistant) et renvoie un WAV. */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const path = await ttsClient.synthesize(toSpeechText(text))
  try {
    return await readFile(path)
  } finally {
    await rm(path, { force: true })
  }
}
