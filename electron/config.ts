import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'

// En dev, electron-vite lance le process depuis la racine du projet ; en
// build, `.env` doit être placé à côté de l'exécutable.
const envPath = join(process.cwd(), '.env')
if (existsSync(envPath)) {
  loadDotenv({ path: envPath })
} else {
  loadDotenv()
}

function readEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

export const config = {
  python: {
    bin: readEnv('PYTHON_BIN', 'python')
  },
  wakeword: {
    modelPath: readEnv('WAKEWORD_MODEL_PATH', './models/wakeword/hey_jarvis_v0.1.onnx'),
    melspecModelPath: readEnv('WAKEWORD_MELSPEC_PATH', './models/wakeword/melspectrogram.onnx'),
    embeddingModelPath: readEnv('WAKEWORD_EMBEDDING_PATH', './models/wakeword/embedding_model.onnx'),
    threshold: Number(readEnv('WAKEWORD_THRESHOLD', '0.5')),
    /** Index du périphérique micro (voir `python -m sounddevice`), vide = défaut système. */
    inputDevice: readEnv('WAKEWORD_INPUT_DEVICE')
  },
  stt: {
    /** Reconnaissance vocale : Cohere Transcribe (2 Md de paramètres, #1 du Open ASR Leaderboard). */
    model: readEnv('STT_MODEL', 'CohereLabs/cohere-transcribe-03-2026'),
    language: readEnv('STT_LANGUAGE', 'fr'),
    device: readEnv('STT_DEVICE', 'cpu')
  },
  tts: {
    /** Synthèse vocale : Supertonic HD (99M paramètres, modèle téléchargé automatiquement au premier lancement). */
    voice: readEnv('TTS_VOICE', 'M3'),
    language: readEnv('TTS_LANGUAGE', 'fr')
  },
  ollama: {
    host: readEnv('OLLAMA_HOST', 'http://127.0.0.1:11434'),
    model: readEnv('OLLAMA_MODEL', 'qwen3.5:9b'),
    /** Fenêtre de contexte : basse volontairement pour tenir en entier dans la VRAM (le max du modèle est overkill pour de la conversation vocale). */
    numCtx: Number(readEnv('OLLAMA_NUM_CTX', '4096')),
    /** Modèle de vision (étape 6), séparé du modèle de conversation. */
    visionModel: readEnv('OLLAMA_VISION_MODEL', 'qwen3-vl:8b')
  },
  searxng: {
    host: readEnv('SEARXNG_HOST', 'http://127.0.0.1:8080')
  },
  smtp: {
    host: readEnv('SMTP_HOST'),
    port: Number(readEnv('SMTP_PORT', '587')),
    /** true pour le port 465 (SSL direct), false pour 587/25 (STARTTLS). */
    secure: readEnv('SMTP_SECURE', 'false') === 'true',
    user: readEnv('SMTP_USER'),
    pass: readEnv('SMTP_PASS'),
    /** Adresse affichée comme expéditeur, souvent identique à SMTP_USER. */
    from: readEnv('SMTP_FROM')
  },
  google: {
    /** Identifiants OAuth "Application de bureau" créés sur Google Cloud Console (voir README). */
    clientId: readEnv('GOOGLE_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_CLIENT_SECRET')
  }
} as const

export interface VoiceSetupStatus {
  wakewordReady: boolean
  missing: string[]
}

/**
 * Vérifie que les fichiers nécessaires au pipeline vocal sont présents. La synthèse vocale
 * (Supertonic HD) n'a rien à vérifier ici : son modèle se télécharge tout seul au premier lancement,
 * comme la transcription (Cohere Transcribe).
 */
export function checkVoiceSetup(): VoiceSetupStatus {
  const missing: string[] = []

  if (!existsSync(config.wakeword.modelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.modelPath} (lance python/download_wakeword_models.py)`)
  if (!existsSync(config.wakeword.melspecModelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.melspecModelPath}`)
  if (!existsSync(config.wakeword.embeddingModelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.embeddingModelPath}`)

  const wakewordReady =
    existsSync(config.wakeword.modelPath) &&
    existsSync(config.wakeword.melspecModelPath) &&
    existsSync(config.wakeword.embeddingModelPath)

  return { wakewordReady, missing }
}
