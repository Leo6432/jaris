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
  whisper: {
    model: readEnv('WHISPER_MODEL', 'small'),
    language: readEnv('WHISPER_LANGUAGE', 'fr'),
    device: readEnv('WHISPER_DEVICE', 'cpu'),
    computeType: readEnv('WHISPER_COMPUTE_TYPE', 'int8')
  },
  piper: {
    binPath: readEnv('PIPER_BIN_PATH', './bin/piper/piper.exe'),
    voicePath: readEnv('PIPER_VOICE_PATH', './models/tts/fr_FR-siwis-medium.onnx')
  },
  ollama: {
    host: readEnv('OLLAMA_HOST', 'http://127.0.0.1:11434'),
    model: readEnv('OLLAMA_MODEL', 'qwen3.5:9b'),
    /** Fenêtre de contexte : basse volontairement pour tenir en entier dans la VRAM (le max du modèle est overkill pour de la conversation vocale). */
    numCtx: Number(readEnv('OLLAMA_NUM_CTX', '4096'))
  }
} as const

export interface VoiceSetupStatus {
  wakewordReady: boolean
  piperReady: boolean
  missing: string[]
}

/** Vérifie que les fichiers nécessaires au pipeline vocal sont présents. */
export function checkVoiceSetup(): VoiceSetupStatus {
  const missing: string[] = []

  if (!existsSync(config.wakeword.modelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.modelPath} (lance python/download_wakeword_models.py)`)
  if (!existsSync(config.wakeword.melspecModelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.melspecModelPath}`)
  if (!existsSync(config.wakeword.embeddingModelPath)) missing.push(`modèle openWakeWord introuvable : ${config.wakeword.embeddingModelPath}`)
  if (!existsSync(config.piper.binPath)) missing.push(`binaire Piper introuvable : ${config.piper.binPath}`)
  if (!existsSync(config.piper.voicePath)) missing.push(`voix Piper introuvable : ${config.piper.voicePath}`)

  const wakewordReady =
    existsSync(config.wakeword.modelPath) &&
    existsSync(config.wakeword.melspecModelPath) &&
    existsSync(config.wakeword.embeddingModelPath)
  const piperReady = existsSync(config.piper.binPath) && existsSync(config.piper.voicePath)

  return { wakewordReady, piperReady, missing }
}
