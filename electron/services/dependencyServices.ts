import { exec, execSync, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { config } from '../config'
import { openApp } from './appLauncher'
import { resourcesRoot } from '../paths'

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
 * pas caché sur Windows) — corrigé upstream dans la 0.7.0 (ollama/ollama#8668). Jaris ne lance lui-même que
 * `ollama serve` (déjà avec windowsHide), donc rien à changer côté spawn ici : le vrai correctif vit dans le
 * binaire Ollama — voir warnIfOllamaOutdated ci-dessous, qui tente un redémarrage silencieux dans ce cas.
 */
const MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH = '0.7.0'

/** Un seul essai de redémarrage silencieux par lancement de Jaris — voir warnIfOllamaOutdated. */
let attemptedSilentOllamaRestart = false

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
      if (attemptedSilentOllamaRestart) return
      attemptedSilentOllamaRestart = true
      log(
        `Ollama ${data.version} détecté : les versions antérieures à ${MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH} ` +
          "peuvent faire apparaître de brèves fenêtres de console Windows vides au chargement d'un modèle " +
          '(bug corrigé côté Ollama, pas côté Jaris) — tentative de mise à jour silencieuse…'
      )
      // Uniquement le redémarrage silencieux (applique une mise à jour déjà téléchargée en arrière-plan par
      // Ollama, sans la moindre fenêtre) : jamais le vrai installeur ici (downloadAndLaunchOfficialInstaller,
      // utilisé par le bouton "Mettre à jour" d'Options), qui lui ouvre une fenêtre — remplacer le problème
      // (des fenêtres apparaissent) par un autre irait à l'encontre du but recherché.
      const restarted = await restartOllamaApp()
      if (restarted) {
        await waitUntil(() => isUp(`${config.ollama.host}/api/tags`), 20000)
        void checkOllamaFreshness()
        try {
          // Comparé directement au seuil du bug (pas à `outdated`, qui compare à la toute dernière version
          // GitHub) : le redémarrage peut très bien suffire à passer 0.7.0 sans pour autant retomber sur la
          // toute dernière version publiée — le bug de fenêtres est alors déjà réglé, `outdated` dirait
          // pourtant encore "oui".
          const recheck = await fetch(`${config.ollama.host}/api/version`)
          const recheckData = recheck.ok ? ((await recheck.json()) as { version?: string }) : null
          const stillOld = !recheckData?.version || isVersionOlder(recheckData.version, MIN_OLLAMA_VERSION_NO_CONSOLE_FLASH)
          log(
            stillOld
              ? "Redémarrage silencieux tenté, mais Ollama reste sur l'ancienne version — mets-le à jour manuellement dans Options → Micro & Modèles pour faire disparaître ces fenêtres."
              : `Ollama mis à jour silencieusement (${recheckData?.version}).`
          )
        } catch {
          log('Mets à jour Ollama manuellement dans Options → Micro & Modèles pour faire disparaître ces fenêtres.')
        }
      } else {
        log('Mets à jour Ollama manuellement dans Options → Micro & Modèles pour faire disparaître ces fenêtres.')
      }
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
 * Chemin de "ollama app.exe" (l'appli barre système Windows — auto-démarrée au login, PAS `ollama.exe` le
 * CLI utilisé partout ailleurs dans ce fichier). Contrairement à winget (voir updateOllama plus bas),
 * aucune dépendance à un catalogue externe : Ollama télécharge déjà ses mises à jour tout seul en
 * arrière-plan (réglage "Auto-download updates", activé par défaut) et les applique au redémarrage du
 * process — exactement ce que fait "Restart to update" dans le menu de SA PROPRE icône barre système.
 */
function ollamaAppExePath(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'Ollama', 'ollama app.exe')
}

/**
 * Tue puis relance "ollama app.exe" pour appliquer une mise à jour déjà téléchargée en arrière-plan par
 * Ollama lui-même — `null` si l'exécutable n'est pas à l'emplacement attendu (installation différente,
 * jamais bloquant : updateOllama retombe alors directement sur winget). Le délai entre le kill et la
 * relance laisse le temps au process de vraiment libérer le port du serveur avant qu'une nouvelle instance
 * n'essaie de l'ouvrir.
 */
async function restartOllamaApp(): Promise<boolean> {
  const exePath = ollamaAppExePath()
  if (!existsSync(exePath)) return false
  await execAsync('taskkill /IM "ollama app.exe" /F').catch(() => {
    // Rien à faire si le process n'était pas lancé (déjà arrêté, ou l'utilisateur avait quitté Ollama) :
    // on relance quand même juste en dessous.
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  // 'error' DOIT avoir un listener même si on ignore le résultat (detached + unref) : un spawn() qui
  // échoue de façon asynchrone (chemin invalide, permission refusée...) sur un process sans aucun
  // listener 'error' fait planter tout le process principal d'Electron (unhandled 'error' event), pas
  // juste échouer proprement cet appel.
  spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => {
      // Rien à faire ici : updateOllama() attend ensuite que le serveur réponde (waitUntil) puis
      // retombe sur la suite si ce n'est jamais le cas, ce qui couvre déjà cet échec.
    })
    .unref()
  return true
}

const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'

/**
 * Télécharge le VRAI installeur officiel Ollama (source fiable : ollama.com, jamais un fichier qu'Ollama
 * aurait lui-même mis en cache dans un dossier temporaire — voir le commentaire de updateOllama plus bas)
 * et le lance. Constaté en usage réel (Léo) : simplement redémarrer "ollama app.exe" (restartOllamaApp
 * ci-dessus) ne suffit pas toujours à appliquer une mise à jour déjà annoncée par Ollama — le vrai "Restart
 * to update" de sa propre icône barre système relance en fait tout l'installeur, pas juste le même binaire.
 * Aucun flag silencieux documenté pour OllamaSetup.exe : la fenêtre de l'installeur s'ouvre normalement,
 * l'utilisateur clique "Suivant"/"Installer" lui-même — plus rapide que d'aller le chercher soi-même dans
 * un navigateur, mais pas 100% automatique jusqu'au bout comme restartOllamaApp quand elle marche.
 */
async function downloadAndLaunchOfficialInstaller(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_INSTALLER_URL, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) return false
    const buffer = Buffer.from(await response.arrayBuffer())
    const installerPath = join(tmpdir(), 'JarisOllamaSetup.exe')
    await writeFile(installerPath, buffer)
    // windowsHide: false ici, volontairement, contrairement au reste du fichier : l'utilisateur DOIT voir
    // et pouvoir interagir avec cette fenêtre pour terminer l'installation.
    spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      .on('error', () => {
        // Rien à faire : updateOllama() traite déjà `false` (renvoyé plus bas si writeFile/fetch échoue)
        // comme un échec de cette méthode et retombe sur winget — un échec asynchrone du spawn lui-même,
        // lui, n'a plus d'impact sur le message déjà renvoyé, juste un filet anti-crash comme ailleurs.
      })
      .unref()
    return true
  } catch {
    return false
  }
}

/** Emplacements d'installation d'Ollama sur Windows : par utilisateur (le défaut) puis pour toute la machine. */
function ollamaExePaths(): string[] {
  return [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
    join(process.env.ProgramFiles ?? '', 'Ollama', 'ollama.exe')
  ]
}

/** true si Ollama est installé sur cette machine (qu'il tourne déjà ou non). */
export async function isOllamaInstalled(): Promise<boolean> {
  if (await isUp(`${config.ollama.host}/api/tags`)) return true
  return ollamaExePaths().some((p) => existsSync(p))
}

/**
 * Installe Ollama sans que l'utilisateur ait quoi que ce soit à cliquer (étape 16) : télécharge
 * l'installeur officiel et le lance en mode silencieux. OllamaSetup.exe est construit avec Inno Setup, dont
 * `/VERYSILENT` est l'option standard "aucune fenêtre, aucune question" ; `/SUPPRESSMSGBOXES` couvre les
 * boîtes de dialogue qui bloqueraient quand même l'installation en attendant un clic, et `/NORESTART`
 * évite qu'il redémarre le PC de l'utilisateur en plein premier lancement de Jaris.
 *
 * En cas d'échec, l'appelant peut toujours retomber sur downloadAndLaunchOfficialInstaller (fenêtre
 * visible, quelques clics) : mieux vaut demander deux clics que ne pas installer Ollama du tout.
 */
export async function installOllamaSilently(onProgress: (message: string) => void): Promise<boolean> {
  onProgress("Téléchargement d'Ollama…")
  let installerPath: string
  try {
    const response = await fetch(OLLAMA_INSTALLER_URL, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) return false
    installerPath = join(tmpdir(), 'JarisOllamaSetup.exe')
    await writeFile(installerPath, Buffer.from(await response.arrayBuffer()))
  } catch {
    return false
  }

  onProgress("Installation d'Ollama en cours…")
  const installed = await new Promise<boolean>((resolve) => {
    const proc = spawn(installerPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
  if (!installed) return false

  // L'installeur rend la main avant qu'Ollama ait fini de démarrer son serveur : sans cette attente, la
  // suite (téléchargement des modèles) partirait sur un service qui ne répond pas encore.
  onProgress("Démarrage d'Ollama…")
  await waitUntil(() => isUp(`${config.ollama.host}/api/tags`), 60000)
  return true
}

/**
 * Déclenché par le bouton "Mettre à jour" du bandeau (OptionsMenu.tsx). Trois méthodes, dans cet ordre :
 * 1. Redémarrer "ollama app.exe" (restartOllamaApp ci-dessus) : rapide, silencieux, aucune invite Windows —
 *    marche quand Ollama a déjà tout ce qu'il faut prêt en arrière-plan, mais pas toujours (voir plus haut).
 * 2. Télécharger et lancer le VRAI installeur officiel (downloadAndLaunchOfficialInstaller ci-dessus) si le
 *    redémarrage seul n'a pas suffi : garanti de fonctionner (c'est l'installeur officiel), demande juste
 *    quelques clics à l'utilisateur dans la fenêtre qui s'ouvre.
 * 3. `winget` (App Installer, préinstallé sur Windows 10 1809+/11) en tout dernier repli, seulement si même
 *    le téléchargement de l'installeur a échoué (pas de réseau vers ollama.com, par exemple) : le paquet
 *    `Ollama.Ollama` est officiellement maintenu sur github.com/microsoft/winget-pkgs. Une invite Windows
 *    (élévation UAC) reste possible ici — ni winget ni Jaris ne peuvent la contourner, et il ne faut pas
 *    essayer.
 */
export async function updateOllama(): Promise<{ success: boolean; message: string }> {
  try {
    return await updateOllamaInner()
  } catch (err) {
    // Filet de sécurité final : une exception qui remonte jusqu'ici sans ce try/catch traverserait
    // ipcMain.handle telle quelle jusqu'au renderer, où handleUpdateOllama (OptionsMenu.tsx) n'a pas de
    // .catch() — le bouton redeviendrait "Mettre à jour" sans jamais afficher la moindre explication.
    return { success: false, message: `Erreur inattendue pendant la mise à jour : ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function updateOllamaInner(): Promise<{ success: boolean; message: string }> {
  const restarted = await restartOllamaApp()
  if (restarted) {
    // Attend que le serveur revienne avant de reverifier : quelques secondes le temps qu'Ollama redémarre
    // et réouvre son API.
    await waitUntil(() => isUp(`${config.ollama.host}/api/tags`), 20000)
    await checkOllamaFreshness()
    const status = getOllamaVersionStatus()
    if (status && !status.outdated) {
      return { success: true, message: `Ollama redémarré et mis à jour (${status.current}).` }
    }
    // Le redémarrage n'a rien changé (rien de prêt en arrière-plan, "Auto-download updates" désactivé côté
    // Ollama, ou le vrai payload de mise à jour vit ailleurs que dans le binaire déjà installé — voir
    // downloadAndLaunchOfficialInstaller) : télécharger et lancer le vrai installeur reste une tentative
    // garantie de fonctionner, pas juste un message d'erreur.
  }

  if (await downloadAndLaunchOfficialInstaller()) {
    return {
      success: true,
      message:
        "L'installeur Ollama officiel a été téléchargé et lancé : termine l'installation dans la fenêtre " +
        'qui vient de s\'ouvrir (Ollama redémarre automatiquement à la fin).'
    }
  }

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
        message: `Le téléchargement automatique de l'installeur a aussi échoué, et winget est introuvable (${err.message}) : installe "App Installer" depuis le Microsoft Store, ou télécharge/lance l'installeur toi-même depuis ton navigateur sur ollama.com/download.`
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
      // "scope"/type d'installeur que winget attend pour appliquer une mise à jour dessus.
      if (code === 2316632107 || code === -1978335189) {
        resolve({
          success: false,
          message:
            "Ni le redémarrage d'Ollama, ni le téléchargement automatique de l'installeur, ni winget n'ont " +
            "trouvé de mise à jour applicable, alors qu'une version plus récente existe bien sur GitHub : " +
            'vérifie ta connexion, ou télécharge/lance l\'installeur toi-même depuis ton navigateur sur ' +
            'ollama.com/download.'
        })
        return
      }
      resolve({
        success: false,
        message: `Le téléchargement automatique de l'installeur a échoué, et winget aussi (code ${code}) : ${output.trim().slice(-500) || 'aucun détail'} — essaie depuis ton navigateur sur ollama.com/download.`
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
 * Arrête TOUT process Ollama en cours (le serveur `ollama.exe`, ET l'appli barre système `ollama app.exe`
 * qui le relancerait sinon tout seul) — nécessaire avant de déplacer le dossier des modèles
 * (Options → Modèles, voir modelsLocation.ts) : tant qu'un fichier de ce dossier est ouvert par Ollama, le
 * déplacer échouerait ou laisserait des données corrompues. `ensureOllamaRunning` (appelé juste après par
 * l'appelant) le relance proprement une fois le déplacement terminé.
 */
export async function stopOllamaCompletely(): Promise<void> {
  ollamaProcessStartedByJaris = null
  await execAsync('taskkill /IM ollama.exe /F').catch(() => {})
  await execAsync('taskkill /IM "ollama app.exe" /F').catch(() => {})
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
    await execAsync('docker compose up -d', { cwd: resourcesRoot(), windowsHide: true })
  } catch (err) {
    log(`Échec du démarrage de SearXNG : ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const up = await waitUntil(() => isUp(config.searxng.host), 30000)
  log(up ? 'SearXNG démarré.' : 'SearXNG ne répond pas encore, réessaie la recherche web dans un instant.')
}
