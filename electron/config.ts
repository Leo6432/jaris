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
    /**
     * Reconnaissance vocale : Cohere Transcribe (2 Md de paramètres, #1 du Open ASR Leaderboard). Vide par
     * défaut À DESSEIN : le modèle utilisé (et la version exacte épinglée qui va avec) est décidé par
     * voice_server.py, seul endroit où les deux sont définis ensemble. Renseigner STT_MODEL ici sert
     * uniquement à imposer un autre modèle que celui par défaut.
     */
    model: readEnv('STT_MODEL'),
    language: readEnv('STT_LANGUAGE', 'fr'),
    /** "auto" = c'est torch qui tranche au chargement (voir voice_server.py), selon ce qui est réellement
     * utilisable sur la machine. "cuda"/"cpu" pour forcer l'un des deux. */
    device: readEnv('STT_DEVICE', 'auto')
  },
  tts: {
    /** Synthèse vocale : Kokoro-82M (modèle téléchargé automatiquement au premier lancement). Pas de
     * réglage de voix (TTS_VOICE, retiré) : Kokoro n'a qu'une seule voix par langue en dehors de
     * l'anglais (voir tts_server.py), contrairement à Supertonic HD qui en proposait 10. */
    language: readEnv('TTS_LANGUAGE', 'fr')
  },
  ollama: {
    host: readEnv('OLLAMA_HOST', 'http://127.0.0.1:11434'),
    model: readEnv('OLLAMA_MODEL', 'qwen3.5:9b'),
    /**
     * Fenêtre de contexte : volontairement bien plus basse que le max du modèle (overkill pour de la
     * conversation vocale) pour tenir en entier dans la VRAM, mais 4096 (valeur d'origine) s'est révélé
     * trop bas une fois mesuré pour de vrai : le système prompt (buildSystemPrompt, assistant.ts) + la
     * liste des outils (TOOLS, tools.ts) consomment à eux seuls environ 4200-4500 tokens AVANT même le
     * premier message de l'utilisateur — sur le plus petit modèle du palier Rapide (qwen3.5:0.8b, utilisé
     * sur les machines à faible VRAM), ça ne laissait quasiment plus de place pour une vraie réponse,
     * produisant un contenu vide ("Réponse vide d'Ollama") constaté en usage réel par Léo sur une machine
     * modeste. Le système prompt/la liste d'outils ont grossi au fil des versions sans jamais revoir ce
     * chiffre : 8192 laisse une vraie marge, pour un coût VRAM supplémentaire négligeable (le cache K/V
     * d'un contexte plus long pèse peu comparé au poids du modèle lui-même, surtout pour les petits
     * modèles justement les plus concernés par ce bug).
     */
    numCtx: Number(readEnv('OLLAMA_NUM_CTX', '8192')),
    /** Modèle de vision (étape 6), séparé du modèle de conversation. */
    visionModel: readEnv('OLLAMA_VISION_MODEL', 'qwen3-vl:8b')
  },
  searxng: {
    // 8091, pas le 8080 par défaut de SearXNG : voir le commentaire dans docker-compose.yml (port bien trop
    // souvent déjà pris par un autre logiciel sur la machine de l'utilisateur, cause réelle et confirmée
    // d'un 403 persistant chez Léo qui n'avait rien à voir avec la config de SearXNG elle-même).
    host: readEnv('SEARXNG_HOST', 'http://127.0.0.1:8091')
  }
} as const
