import { downloadsDir } from './storageRoot'
import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { DownloadError, downloadToFile } from './download'
import { runPowerShellScript } from './inputControl'
import type { UpdateProgress } from '../../shared/ipc'
import { t } from '../../shared/i18n'

/**
 * Met à jour Jaris lui-même depuis l'interface (étape 20 du roadmap), sans jamais `git pull`/`npm run
 * build` : même principe que la mise à jour d'Ollama (dependencyServices.ts) — comparer la version locale
 * à la dernière publiée, puis télécharger et lancer l'installeur au lieu de renvoyer vers un site.
 *
 * Repose sur `.github/workflows/build-installer.yml` : dès qu'un push (sur n'importe quelle branche)
 * contient une version de `package.json` sans Release correspondante, le workflow publie lui-même une
 * vraie Release GitHub stable (ex: `v0.1.1`) avec `Jaris-Setup-*.exe` en pièce jointe — personne ne pousse
 * de tag à la main. `GET /releases/latest` ignore naturellement la Release "dernier-build" (marquée
 * `--prerelease` dans le workflow, utilisée pour tester le développement en cours) : elle ne peut jamais
 * être confondue avec une vraie sortie versionnée.
 */
export interface AppVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

const REPO = 'Leo6432/jaris'

let cachedStatus: AppVersionStatus | null = null
let cachedDownloadUrl: string | null = null
let freshnessCheck: Promise<void> | null = null

/**
 * Attend la vérification en cours si `checkAppFreshness` n'a pas encore fini (appelée en `void` au
 * démarrage, sans attendre) avant de renvoyer le cache : sans ça, l'appel IPC déclenché par le montage de
 * l'interface (App.tsx, quasi instantané) gagnait quasi systématiquement la course contre l'appel réseau
 * vers GitHub (bien plus lent), et `cachedStatus` valait encore `null` à ce moment-là — la popup de mise à
 * jour ne pouvait alors jamais s'afficher, peu importe la version réellement publiée.
 */
export async function getAppVersionStatus(): Promise<AppVersionStatus | null> {
  if (freshnessCheck) await freshnessCheck
  return cachedStatus
}

/** Version réellement installée, lue localement (`app.getVersion()`) — jamais bloquée par le réseau,
 * contrairement à getAppVersionStatus() qui compare à la dernière Release GitHub. */
export function getInstalledVersion(): string {
  return app.getVersion()
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * Compare la version installée (`app.getVersion()`, lue par Electron dans `package.json` au moment du
 * build — pas modifiable à l'exécution) à la dernière Release GitHub stable. Met le résultat en cache pour
 * que l'UI (App.tsx, OptionsMenu.tsx) le lise à tout moment sans refaire l'appel réseau — un seul check par
 * lancement de Jaris suffit. Ignore silencieusement toute erreur (pas de réseau, GitHub inaccessible...) :
 * ce check en tâche de fond au démarrage ne doit jamais empêcher Jaris de démarrer. Pour un vrai diagnostic
 * (bouton "Rechercher une mise à jour" dans Options → Mise à jour), voir checkForUpdate ci-dessous, qui elle remonte
 * l'erreur au lieu de l'avaler.
 */
export function checkAppFreshness(): Promise<void> {
  freshnessCheck = checkForUpdate().then(() => undefined)
  return freshnessCheck
}

/**
 * Vérifie pour de vrai (jamais depuis le cache) et renvoie l'erreur telle quelle en cas d'échec, contrairement
 * à checkAppFreshness ci-dessus qui l'avale silencieusement : déclenchée par un clic explicite sur "Rechercher
 * une mise à jour" (OptionsMenu.tsx), l'utilisateur doit voir la vraie raison d'un échec (pare-feu, réseau
 * d'entreprise, GitHub injoignable...) plutôt qu'un silence qui ressemble à un bug côté Jaris.
 */
/**
 * Étape 502 (Léo : « quand il y a une mise à jour du Store, ça met ou pas nouvelle version dispo ? ») : la version
 * Microsoft Store annonce aussi une nouvelle version — mais ne télécharge jamais d'installeur (le Store installe,
 * étape 491) : Options propose seulement d'ouvrir le Store. Depuis l'étape 512, elle le demande au Store (voir plus bas).
 */
export const STORE_UPDATES_URL = 'ms-windows-store://downloadsandupdates'

/**
 * Étape 512 (capture de Léo : « Jaris 0.75.3 est sorti… il arrive par le Microsoft Store » alors que la 0.75.3 était
 * encore en certification) : la version Store ne lit plus GitHub — une Release y est publiée des jours avant que
 * Microsoft valide le paquet. Elle demande au Store LUI-MÊME s'il a une mise à jour pour Jaris
 * (`StoreContext.GetAppAndOptionalStorePackageUpdatesAsync`, API Windows.Services.Store) : une seule source de vérité,
 * le message n'apparaît que quand la mise à jour est vraiment téléchargeable. PowerShell lancé par Jaris hérite de
 * l'identité du paquet (application empaquetée « full trust »). Toute erreur est rendue en JSON, jamais un plantage.
 */
export const STORE_UPDATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  } | Select-Object -First 1
  $null = [Windows.Services.Store.StoreContext, Windows.Services.Store, ContentType = WindowsRuntime]
  $context = [Windows.Services.Store.StoreContext]::GetDefault()
  $operation = $context.GetAppAndOptionalStorePackageUpdatesAsync()
  $listType = [System.Collections.Generic.IReadOnlyList[Windows.Services.Store.StorePackageUpdate]]
  $task = $asTask.MakeGenericMethod($listType).Invoke($null, @($operation))
  if (-not $task.Wait(60000)) { throw 'no answer from the Microsoft Store after 60 s' }
  $versions = @($task.Result | ForEach-Object { $v = $_.Package.Id.Version; "$($v.Major).$($v.Minor).$($v.Build)" })
  [pscustomobject]@{ updates = $versions } | ConvertTo-Json -Compress
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  [pscustomobject]@{ error = $e.Message } | ConvertTo-Json -Compress
}
`

type PowerShellRunner = (script: string, env?: NodeJS.ProcessEnv, idleMs?: number) => Promise<{ error: string | null; stdout: string }>

/** Lit la réponse du script : `{"updates":[…]}` ou `{"error":"…"}` (dernière ligne JSON de la sortie). */
export function parseStoreAnswer(stdout: string): { updates: string[] } | { error: string } | null {
  const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
  if (!line) return null
  try {
    const data = JSON.parse(line) as { updates?: unknown; error?: unknown }
    if (typeof data.error === 'string') return { error: data.error }
    if (data.updates === undefined || data.updates === null) return { updates: [] }
    const list = Array.isArray(data.updates) ? data.updates : [data.updates]
    return { updates: list.filter((v): v is string => typeof v === 'string') }
  } catch {
    return null
  }
}

/** Version Store : ce que le Microsoft Store propose vraiment (jamais GitHub). */
export async function checkStoreUpdate(run: PowerShellRunner = runPowerShellScript): Promise<{ status: AppVersionStatus | null; error: string | null }> {
  const currentVersion = app.getVersion()
  const currentParts = parseSemver(currentVersion) ?? [0, 0, 0]
  const { error, stdout } = await run(STORE_UPDATE_SCRIPT, undefined, 90_000)
  const answer = parseStoreAnswer(stdout)
  if (error || !answer) return { status: null, error: t('upd.storeFailed', { error: error ?? (stdout.trim() || '?') }) }
  if ('error' in answer) return { status: null, error: t('upd.storeFailed', { error: answer.error }) }
  let latest = currentParts
  for (const version of answer.updates) {
    const parts = parseSemver(version)
    if (parts && isNewer(parts, latest)) latest = parts
  }
  cachedDownloadUrl = null
  cachedStatus = { current: currentVersion, latest: latest.join('.'), outdated: isNewer(latest, currentParts) }
  return { status: cachedStatus, error: null }
}

export async function checkForUpdate(): Promise<{ status: AppVersionStatus | null; error: string | null }> {
  if (process.windowsStore === true) return checkStoreUpdate()
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000)
    })
    // 404 tant qu'aucune Release stable (tag v*) n'a jamais été publiée : pas une erreur, juste "rien à
    // comparer" — jamais affiché comme "à jour" par défaut dans ce cas.
    if (!response.ok) {
      return response.status === 404
        ? { status: null, error: null }
        : { status: null, error: t('upd.githubHttp', { status: response.status }) }
    }
    const release = (await response.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
    const latestParts = release.tag_name ? parseSemver(release.tag_name) : null
    if (!latestParts) return { status: null, error: t('upd.githubUnexpected') }

    const currentVersion = app.getVersion()
    const currentParts = parseSemver(currentVersion) ?? [0, 0, 0]
    const exeAsset = release.assets?.find((a) => a.name.endsWith('.exe'))

    cachedDownloadUrl = exeAsset?.browser_download_url ?? null
    cachedStatus = {
      current: currentVersion,
      latest: latestParts.join('.'),
      outdated: isNewer(latestParts, currentParts)
    }
    return { status: cachedStatus, error: null }
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Arguments de l'installeur pour une MISE À JOUR : silencieuse, même dossier, Jaris relancé à la fin. */
export const UPDATE_INSTALLER_ARGS = ['/S', '--updated', '--force-run']

/**
 * Déclenché par le bouton "Mettre à jour" (OptionsMenu.tsx, comme celui d'Ollama). Télécharge le VRAI
 * installeur de la Release GitHub (jamais un fichier généré à la volée) et le lance seulement une fois Jaris
 * réellement en train de quitter (voir plus bas), pour ne jamais déclencher l'invite "Jaris tourne déjà,
 * fermer et continuer ?" de l'installeur NSIS (electron-builder.yml).
 *
 * `onBeforeQuit` : la fenêtre principale (main.ts) intercepte sa propre fermeture pour se cacher en widget
 * au lieu de vraiment quitter, sauf si le drapeau module `quitting` est déjà à `true` (voir le menu barre
 * système "Quitter"). Sans prévenir main.ts juste avant d'appeler `app.quit()` ci-dessous, cette
 * interception s'applique aussi ici : Jaris ne quittait donc jamais réellement pendant une mise à jour (il
 * se repliait juste en widget), ce qui explique que l'installeur voie systématiquement Jaris.exe encore actif
 * à son contrôle de démarrage — jamais un problème de timing, Jaris ne fermait tout simplement pas du tout.
 */
export async function updateApp(
  onBeforeQuit?: () => void,
  // `target` est ajouté par main.ts, seul à savoir sur quel canal ça part (même convention que
  // dependencyServices pour Ollama depuis l'étape 112) : ce module ne décrit que son propre avancement.
  onProgress?: (progress: Omit<UpdateProgress, 'target'>) => void
): Promise<{ success: boolean; message: string }> {
  if (process.windowsStore === true) return { success: false, message: t('options.update.store') }
  if (!cachedStatus?.outdated) {
    return { success: false, message: t('upd.none') }
  }
  if (!cachedDownloadUrl) {
    return {
      success: false,
      message: t('upd.noInstaller', { version: cachedStatus.latest })
    }
  }

  // Nommé d'après la version téléchargée : un reste d'une tentative précédente (fichier encore verrouillé
  // par un antivirus, installation abandonnée) ne peut plus faire échouer l'écriture de celle-ci.
  const installerPath = join(downloadsDir(), `Jaris-Setup-${cachedStatus.latest}.exe`)

  try {
    // Téléchargé au fil de l'eau, avec l'avancement renvoyé à l'interface (étape 98) : l'installeur pèse
    // ~98 Mo, soit plusieurs minutes sur une connexion modeste — sans ce retour, le bouton restait figé sur
    // "Mise à jour en cours…" sans que rien ne distingue un téléchargement qui avance d'un blocage.
    // downloadToFile vérifie aussi que le fichier reçu est COMPLET avant qu'on ferme Jaris pour le lancer :
    // un .exe tronqué se lance sans rien faire de visible, et Jaris serait déjà fermé pour le dire.
    await downloadToFile(cachedDownloadUrl, installerPath, {
      onProgress: (progress) => onProgress?.({ phase: 'download', ...progress })
    })
    onProgress?.({ phase: 'install', receivedBytes: 0, totalBytes: null, percent: 100 })

    // Lancé seulement une fois Jaris réellement en train de quitter ('will-quit', après la fermeture de ses
    // fenêtres), jamais avant : l'installeur NSIS vérifie si Jaris.exe tourne encore quasi immédiatement
    // après son propre démarrage. Avec l'ancien ordre (spawn immédiat, puis Jaris ne se fermait qu'une
    // seconde plus tard), ce contrôle voyait systématiquement Jaris encore actif et affichait son invite
    // "Jaris tourne déjà, fermer et continuer ?" à chaque mise à jour — jamais un cas limite, constaté à
    // chaque fois en usage réel (Léo). windowsHide: false — cette invite doit rester visible si jamais elle
    // apparaît encore malgré ce nouvel ordre (Jaris trop lent à quitter sur une machine chargée, par exemple).
    app.once('will-quit', () => {
      // Étape 142 : l'installeur est devenu ASSISTÉ (choix du dossier à la première installation,
      // electron-builder.yml). Sans arguments, chaque mise à jour rouvrirait tout l'assistant. `/S` = silencieux,
      // dans le dossier déjà choisi (InstallLocation du registre) ; `--updated` = ne jamais redemander le
      // dossier ; `--force-run` = relancer Jaris à la fin, ce que l'assistant ne fait sinon qu'avec une case à
      // cocher sur sa dernière page.
      spawn(installerPath, UPDATE_INSTALLER_ARGS, { detached: true, stdio: 'ignore', windowsHide: false })
        .on('error', () => {
          // Rien à faire de plus ici : Jaris est de toute façon en train de quitter, plus personne à qui
          // rapporter un échec asynchrone du spawn lui-même à ce stade.
        })
        .unref()
    })
    onBeforeQuit?.()
    app.quit()

    return { success: true, message: t('upd.restarting', { version: cachedStatus.latest }) }
  } catch (err) {
    // Un message de DownloadError est DÉJÀ rédigé pour Léo (voir download.ts) : le réhabiller en "Échec de
    // la mise à jour : The operation was aborted due to timeout" lui enlevait justement ce qui était
    // actionnable dedans. Tout le reste garde le préfixe, qui situe au moins l'erreur.
    if (err instanceof DownloadError) return { success: false, message: err.message }
    return { success: false, message: t('upd.failed', { error: err instanceof Error ? err.message : String(err) }) }
  }
}
