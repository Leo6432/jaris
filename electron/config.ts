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
  porcupine: {
    accessKey: readEnv('PICOVOICE_ACCESS_KEY'),
    keywordPath: readEnv('PORCUPINE_KEYWORD_PATH', './models/wakeword/Jaris_windows.ppn'),
    sensitivity: Number(readEnv('PORCUPINE_SENSITIVITY', '0.6'))
  },
  whisper: {
    pythonBin: readEnv('PYTHON_BIN', 'python'),
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
    model: readEnv('OLLAMA_MODEL', 'qwen3.5:9b')
  }
} as const

export interface VoiceSetupStatus {
  porcupineReady: boolean
  whisperReady: boolean
  piperReady: boolean
  missing: string[]
}

/** Vérifie que les clés/fichiers nécessaires au pipeline vocal sont présents. */
export function checkVoiceSetup(): VoiceSetupStatus {
  const missing: string[] = []

  if (!config.porcupine.accessKey) missing.push('PICOVOICE_ACCESS_KEY (clé gratuite sur console.picovoice.io)')
  if (!existsSync(config.porcupine.keywordPath)) missing.push(`mot-clé Porcupine introuvable : ${config.porcupine.keywordPath}`)
  if (!existsSync(config.piper.binPath)) missing.push(`binaire Piper introuvable : ${config.piper.binPath}`)
  if (!existsSync(config.piper.voicePath)) missing.push(`voix Piper introuvable : ${config.piper.voicePath}`)

  const porcupineReady = !!config.porcupine.accessKey && existsSync(config.porcupine.keywordPath)
  const piperReady = existsSync(config.piper.binPath) && existsSync(config.piper.voicePath)

  return {
    porcupineReady,
    whisperReady: true, // vérifié au démarrage du sidecar Python (ready/error event)
    piperReady,
    missing
  }
}
