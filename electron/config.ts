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
  voice: {
    /** Index/nom du périphérique micro (voir `python -m sounddevice`) utilisé par le sidecar vocal, vide =
     * défaut système. Profile.audioInputDeviceIndex (Options → Voix) reste prioritaire s'il est défini,
     * voir voiceClient.ts. */
    inputDevice: readEnv('MIC_INPUT_DEVICE')
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
