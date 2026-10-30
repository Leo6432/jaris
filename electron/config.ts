import { AsyncLocalStorage } from 'async_hooks'
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

/**
 * Adresse d'Ollama telle que l'écrit sa variable OLLAMA_HOST : parfois sans « http:// », parfois « 0.0.0.0 »
 * (écouter partout), qui n'est pas une adresse qu'on peut joindre. Ramenée à une vraie adresse locale.
 */
export function normalizeOllamaHost(value: string): string {
  let host = value.trim() || '127.0.0.1:11434'
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`
  host = host.replace(/\/\/0\.0\.0\.0(?=[:/]|$)/, '//127.0.0.1').replace(/\/+$/, '')
  return /:\d+$/.test(host.replace(/^https?:\/\//i, '')) ? host : `${host}:11434`
}

/**
 * L'Ollama installé sur Windows (étape 336 : utilisé seulement tant que Jaris n'a pas encore le sien, voir
 * ollamaEngine.ts). JARIS_OLLAMA_HOST, réglage de développement, fige l'adresse quoi qu'il arrive.
 */
export const WINDOWS_OLLAMA_HOST = normalizeOllamaHost(readEnv('OLLAMA_HOST', 'http://127.0.0.1:11434'))
const fixedOllamaHost = readEnv('JARIS_OLLAMA_HOST')
let activeOllamaHost = fixedOllamaHost ? normalizeOllamaHost(fixedOllamaHost) : WINDOWS_OLLAMA_HOST

/** Le serveur que Jaris interroge désormais : le sien dès qu'il est installé (dependencyServices.ts). */
export function setOllamaHost(host: string): void {
  if (!fixedOllamaHost) activeOllamaHost = host
}

/**
 * Étape 377 (Léo : « tout se passe sur mon PC mais les modèles tournent sur leur site », pour les duels seulement) :
 * une adresse d'Ollama propre à un travail en cours, sans toucher au reste de Jaris. Tout ce qui est lancé dans
 * `runWithOllamaHost` (et tout ce qui en découle, `await` compris) parle à cette adresse ; `runWithLocalOllama` revient à
 * l'Ollama de ce PC à l'intérieur (les outils de Jaris pendant un duel : regarder l'écran, dessiner…).
 */
interface OllamaScope {
  host: string
  /**
   * Étape 387 : nombre de fils de calcul (num_thread) à demander pour ce modèle, ou rien. Sur le pod de Léo, chaque
   * modèle croyait avoir les 192 cœurs de la machine de RunPod et lançait autant de fils, qui se battaient pour la
   * part du pod (processeur à 100 %, carte à 25 %), alors qu'ils n'ont presque rien à faire quand tout tient sur la carte.
   */
  threadsFor?: (model: string) => number | undefined
}
const hostScope = new AsyncLocalStorage<OllamaScope | null>()

export function runWithOllamaHost<T>(host: string, fn: () => Promise<T>, threadsFor?: (model: string) => number | undefined): Promise<T> {
  return hostScope.run({ host, threadsFor }, fn)
}

export function runWithLocalOllama<T>(fn: () => Promise<T>): Promise<T> {
  return hostScope.run(null, fn)
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
  tts: {
    /** Synthèse vocale : Supertonic HD (99M paramètres, modèle téléchargé automatiquement au premier lancement). */
    voice: readEnv('TTS_VOICE', 'M3'),
    language: readEnv('TTS_LANGUAGE', 'fr')
  },
  ollama: {
    /** Lu à chaque appel : passe de l'Ollama de Windows à celui de Jaris sans redémarrer (étape 336). */
    get host(): string {
      return hostScope.getStore()?.host ?? activeOllamaHost
    },
    /** Étape 377 : vrai pendant un travail envoyé à un Ollama d'une autre machine (rien de ce PC ne s'y applique). */
    get remote(): boolean {
      return Boolean(hostScope.getStore())
    },
    /** Étape 387 : fils de calcul demandés pour ce modèle pendant un travail sur une autre machine (sinon rien). */
    threadsFor(model: string): number | undefined {
      return hostScope.getStore()?.threadsFor?.(model)
    },
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
  github: {
    /**
     * Étape 277 : identifiant PUBLIC de l'application GitHub (OAuth App) de Jaris, celle qui affiche « Jaris
     * demande l'accès à ton compte » pendant la connexion par code. Ce n'est pas un secret (GitHub le dit :
     * « The client_secret is not needed for the device flow »), il peut donc vivre dans le code. Vide : tout ce
     * qui touche à GitHub reste masqué dans le mode Code. Une seule application pour tous les utilisateurs de
     * Jaris : chacun se connecte ensuite avec SON compte, et le jeton n'est remis qu'à l'ordinateur qui a demandé
     * le code. Application créée par Léo (étape 278), « Enable Device Flow » cochée.
     */
    clientId: readEnv('GITHUB_CLIENT_ID', 'Ov23liHLHAC7tS05Vm9h')
  }
} as const
