import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { config } from '../config'
import { openApp } from './appLauncher'

const execAsync = promisify(exec)

type LogFn = (message: string) => void

/**
 * Process `ollama serve` lancé par Jaris lui-même (voir ensureOllamaRunning) — `null` si Ollama tournait
 * déjà avant que Jaris démarre. Sert uniquement à savoir, au moment de quitter, s'il faut l'arrêter (voir
 * stopOllamaIfStartedByJaris) : jamais s'il tournait déjà avant, l'utilisateur peut s'en servir en dehors
 * de Jaris.
 */
let ollamaProcessStartedByJaris: ChildProcess | null = null

/** Ping HTTP simple : true dès que le service répond (peu importe le code, tant qu'il répond). */
async function isUp(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return true
  } catch {
    return false
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * En dessous de cette version, `ollama serve` peut faire flasher une brève fenêtre de console Windows
 * vide à chaque chargement/changement de modèle (le process "runner" qu'Ollama lance en interne n'était
 * pas caché sur Windows) — corrigé upstream dans la 0.7.0 (ollama/ollama#8668). Rien à faire côté Jaris,
 * qui ne lance que `ollama serve` lui-même (déjà avec windowsHide) : le correctif est entièrement dans le
 * binaire Ollama, seule une mise à jour peut faire disparaître ces flashs.
 */
const MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH = '0.7.0'

function isVersionOlder(version: string, minVersion: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((p) => parseInt(p, 10) || 0)
  const a = parts(version)
  const b = parts(minVersion)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0
  }
  return false
}

async function warnIfOllamaOutdated(log: LogFn): Promise<void> {
  try {
    const response = await fetch(`${config.ollama.host}/api/version`)
    if (!response.ok) return
    const data = (await response.json()) as { version?: string }
    if (data.version && isVersionOlder(data.version, MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH)) {
      log(
        `Ollama ${data.version} détecté : les versions antérieures à ${MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH} ` +
          "peuvent faire apparaître de brèves fenêtres de console Windows vides au chargement d'un modèle " +
          '(bug corrigé côté Ollama, pas côté Jaris) — mets à jour Ollama sur ollama.com/download pour les faire disparaître.'
      )
    }
  } catch {
    // Purement informatif : un échec ici (Ollama trop vieux pour exposer /api/version, etc.) ne doit
    // jamais empêcher Jaris de démarrer.
  }
}

/** Version locale d'Ollama comparée à la dernière publiée sur GitHub — voir checkOllamaFreshness. */
export interface OllamaVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

/**
 * Résultat du dernier check, gardé en mémoire pour que l'onglet Modèles (OptionsMenu.tsx) puisse le lire
 * à tout moment via getOllamaVersionStatus() sans refaire l'appel réseau à chaque ouverture — un seul check
 * par lancement de Jaris suffit, la version installée ne change pas pendant que Jaris tourne. `null` tant
 * que le check n'a pas encore abouti (ou a échoué) : jamais affiché comme "à jour" par défaut, juste absent.
 */
let cachedOllamaVersionStatus: OllamaVersionStatus | null = null

export function getOllamaVersionStatus(): OllamaVersionStatus | null {
  return cachedOllamaVersionStatus
}

/**
 * Dernière version publiée d'Ollama sur GitHub (contrairement à MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH, un
 * plancher fixe qu'il faudrait remonter à la main à chaque fois qu'un modèle exige une version plus
 * récente qu'installée — voir l'échec `pull model manifest: 412` de scripts/benchmark-models.mjs) : ce
 * check compare toujours à la VRAIE dernière version, sans jamais avoir besoin d'être mis à jour ici.
 */
async function fetchLatestOllamaVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' }
    })
    clearTimeout(timer)
    if (!response.ok) return null
    const data = (await response.json()) as { tag_name?: string }
    // Tags GitHub d'Ollama sont préfixés "v" (ex: "v0.12.3"), jamais /api/version côté serveur local.
    return data.tag_name?.replace(/^v/, '') ?? null
  } catch {
    // Pas de réseau, GitHub inaccessible, rate limit (60 requêtes/heure sans authentification, largement
    // suffisant pour un check par lancement) : jamais bloquant, l'utilisateur voit juste l'avertissement.
    return null
  }
}

/**
 * Compare la version locale d'Ollama à la dernière publiée, met le résultat en cache pour l'UI (voir
 * getOllamaVersionStatus) — contrairement à warnIfOllamaOutdated (un seul plancher fixe pour un bug
 * cosmétique précis), sert à avertir l'utilisateur de façon générale dès qu'une mise à jour existe, avant
 * qu'un téléchargement de modèle échoue pour de vrai (ex: qwen3.8:27b, qui demande une version d'Ollama
 * plus récente que ce que beaucoup d'installations auront par défaut).
 */
async function checkOllamaFreshness(): Promise<void> {
  try {
    const response = await fetch(`${config.ollama.host}/api/version`)
    if (!response.ok) return
    const data = (await response.json()) as { version?: string }
    if (!data.version) return
    const latest = await fetchLatestOllamaVersion()
    if (!latest) return
    cachedOllamaVersionStatus = { current: data.version, latest, outdated: isVersionOlder(data.version, latest) }
  } catch {
    // Best-effort, comme warnIfOllamaOutdated : ne doit jamais empêcher Jaris de démarrer.
  }
}

/**
 * Déclenché par le bouton "Mettre à jour" du bandeau (OptionsMenu.tsx). `winget` (App Installer, préinstallé
 * sur Windows 10 1809+/11) reste la seule vraie ligne de commande fiable : contrairement à l'installeur
 * Windows d'Ollama (OllamaSetup.exe, aucun flag silencieux documenté — pas question d'en inventer un), le
 * paquet `Ollama.Ollama` est officiellement maintenu à jour sur github.com/microsoft/winget-pkgs. Une seule
 * invite Windows (élévation UAC) reste inévitable pour installer quoi que ce soit sur la machine — ni winget
 * ni Jaris ne peuvent la contourner, et il ne faut pas essayer.
 */
export function updateOllama(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'winget',
      ['upgrade', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
      { windowsHide: true }
    )
    let output = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    // Comme pour ensureOllamaRunning : spawn() signale un binaire introuvable (winget absent, machine très
    // ancienne ou dépouillée) de façon asynchrone via 'error', jamais en levant une exception directement.
    proc.on('error', (err) => {
      resolve({
        success: false,
        message: `winget introuvable (${err.message}) : installe "App Installer" depuis le Microsoft Store, ou mets à jour à la main sur ollama.com/download.`
      })
    })
    proc.on('close', (code) => {
      if (code === 0) {
        // Re-vérifie pour de vrai plutôt que de supposer que ça a marché (ex: winget peut sortir en code 0
        // même sans rien avoir eu à faire) : le bandeau (OptionsMenu.tsx) relit getOllamaVersionStatus juste
        // après l'appel, ce cache doit donc déjà être à jour à ce moment-là.
        void checkOllamaFreshness().then(() => resolve({ success: true, message: 'Ollama mis à jour.' }))
        return
      }
      // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (0x8A15002B, documenté par Microsoft) : winget dit
      // "aucune mise à jour disponible" alors que checkOllamaFreshness (comparaison à la vraie dernière
      // version GitHub, seule source fiable) a détecté une version plus récente — pas une contradiction
      // côté Jaris, juste que winget ne peut rien faire ici, pour deux raisons possibles : le paquet
      // communautaire winget-pkgs (github.com/microsoft/winget-pkgs, maintenu par des contributeurs
      // externes, pas Ollama lui-même) met parfois plusieurs jours à suivre une nouvelle sortie GitHub, ou
      // l'installation actuelle d'Ollama (pas forcément posée par winget à l'origine) ne correspond pas au
      // "scope"/type d'installeur que winget attend pour appliquer une mise à jour dessus. Le vrai installeur
      // Windows d'Ollama, lui, met à jour en place sans se soucier de comment il a été installé avant.
      if (code === 2316632107 || code === -1978335189) {
        resolve({
          success: false,
          message:
            "winget ne trouve pas de mise à jour applicable, alors qu'une version plus récente existe bien " +
            "sur GitHub : le catalogue winget (maintenu par des contributeurs externes, pas Ollama) met parfois " +
            "plusieurs jours à suivre une nouvelle sortie, ou l'installation actuelle n'est pas dans le format " +
            "que winget sait mettre à jour. Pas un bug de ton côté : télécharge et lance l'installeur directement " +
            'sur ollama.com/download, il mettra à jour en place.'
        })
        return
      }
      resolve({
        success: false,
        message: `winget a échoué (code ${code}) : ${output.trim().slice(-500) || 'aucun détail'} — essaie ollama.com/download.`
      })
    })
  })
}

/**
 * Lance `ollama serve` si l'API ne répond pas déjà (ex: app Ollama pas encore démarrée au boot
 * Windows). Sans effet si Ollama tourne déjà - la commande échoue juste silencieusement (port pris).
 */
export async function ensureOllamaRunning(log: LogFn): Promise<void> {
  const url = `${config.ollama.host}/api/tags`
  if (await isUp(url)) {
    void warnIfOllamaOutdated(log)
    void checkOllamaFreshness()
    return
  }

  log("Ollama n'est pas lancé, démarrage automatique…")
  const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
  // spawn() signale un échec (ex: "ollama" absent du PATH) de façon asynchrone via l'évènement 'error' du
  // process, jamais en levant une exception directement : sans ce listener, Node la traite comme une
  // exception non rattrapée et ça plante tout Jaris (au lieu de juste échouer à démarrer Ollama).
  proc.on('error', (err) => log(`Échec du démarrage automatique d'Ollama : ${err.message}`))
  proc.unref()
  ollamaProcessStartedByJaris = proc

  const up = await waitUntil(() => isUp(url), 20000)
  log(up ? 'Ollama démarré.' : "Échec du démarrage automatique d'Ollama : lance-le manuellement (`ollama serve`).")
  if (up) {
    void warnIfOllamaOutdated(log)
    void checkOllamaFreshness()
  }
}

/**
 * Arrête Ollama uniquement si c'est cette instance de Jaris qui l'a démarré (jamais s'il tournait déjà
 * avant, voir ollamaProcessStartedByJaris) : appelé quand Jaris quitte vraiment (Quitter dans la barre
 * système), pour qu'aucun process ne continue de tourner en arrière-plan une fois Jaris fermé. Sans ça,
 * `ollama serve` reste actif indéfiniment (lancé "detached" pour survivre à Jaris) et peut décharger/
 * recharger un modèle tout seul après quelques minutes d'inactivité, ce qui fait parfois flasher une
 * fenêtre de console Windows même Jaris éteint.
 */
export function stopOllamaIfStartedByJaris(): void {
  const pid = ollamaProcessStartedByJaris?.pid
  ollamaProcessStartedByJaris = null
  if (pid === undefined) return

  try {
    // .kill() seul ne suffit pas toujours pour un process "detached" sous Windows, et ne fermerait de
    // toute façon pas les sous-process qu'Ollama a pu lancer pour un modèle chargé (voir /T) : taskkill
    // est le seul moyen fiable de tout arrêter proprement ici.
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid)
    }
  } catch {
    // Rien de plus à faire : au pire Ollama continue de tourner, comme avant ce correctif.
  }
}

/**
 * Démarre Docker Desktop (si besoin) puis `docker compose up -d` pour SearXNG (recherche web).
 * Non bloquant pour le reste de Jaris : la recherche web est juste indisponible en attendant.
 */
export async function ensureSearxngRunning(log: LogFn): Promise<void> {
  if (await isUp(config.searxng.host)) return

  log("SearXNG n'est pas lancé, démarrage de Docker…")
  try {
    await execAsync('docker info', { windowsHide: true })
  } catch {
    // true si Docker Desktop est introuvable (pas juste "pas encore démarré") : dans ce cas, inutile
    // d'attendre 90s en sondant `docker info` en boucle, le résultat est déjà connu.
    let launchFailed = false
    if (process.platform === 'win32') {
      // Réutilise openApp (étape 5, même mécanisme que "ouvre Discord" à la voix) plutôt qu'un chemin
      // d'installation codé en dur : celui-ci suppose l'emplacement par défaut
      // (C:\Program Files\Docker\Docker\Docker Desktop.exe) et échoue silencieusement si Docker Desktop
      // est installé ailleurs (autre disque, install utilisateur...) — vécu par Léo, qui a dû le lancer
      // à la main alors qu'il était bien installé. openApp cherche dans le menu Démarrer Windows, qui
      // connaît l'appli quel que soit son chemin réel d'installation.
      const result = await openApp('Docker Desktop')
      log(result)
      launchFailed = !result.endsWith('a été lancé.')
    }

    const dockerUp = !launchFailed && (await waitUntil(async () => {
      try {
        await execAsync('docker info', { windowsHide: true })
        return true
      } catch {
        return false
      }
    }, 90000, 3000))
    if (!dockerUp) {
      log('Docker n\'a pas pu démarrer automatiquement : installe Docker Desktop (ou ouvre-le manuellement s\'il est déjà installé ailleurs) pour activer la recherche web.')
      return
    }
  }

  try {
    await execAsync('docker compose up -d', { cwd: process.cwd(), windowsHide: true })
  } catch (err) {
    log(`Échec du démarrage de SearXNG : ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const up = await waitUntil(() => isUp(config.searxng.host), 30000)
  log(up ? 'SearXNG démarré.' : 'SearXNG ne répond pas encore, réessaie la recherche web dans un instant.')
}
