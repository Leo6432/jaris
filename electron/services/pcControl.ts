import { shell } from 'electron'
import { t } from '../../shared/i18n'
import { foregroundMatchesApp, runPowerShellScript, waitForForegroundApp } from './inputControl'

/**
 * Étape 508 (Léo : « oui tout », pour les outils qui manquaient à Jaris) : fermer ou remettre devant une application,
 * régler le volume à un pourcentage, et quelques réglages de Windows. Toujours par PowerShell sans shell, les valeurs
 * de l'utilisateur passées par variables d'environnement (jamais dans le texte du script), et des listes fixes : un
 * texte libre ne choisit jamais un réglage ni une page qui n'est pas prévu ici.
 */

export interface OpenWindow {
  id: number
  name: string
  title: string
}

export const LIST_WINDOWS = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ id = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } }) | ConvertTo-Json -Compress'
].join('; ')

/** Jamais Jaris lui-même, ni l'Explorateur (sa « fenêtre principale » est souvent la barre des tâches). */
const PROTECTED_PROCESSES = new Set(['explorer', 'jaris', 'electron'])

/** Les fenêtres ouvertes qui correspondent à `appName` (titre ou programme), sans Jaris ni l'Explorateur. */
export function matchingWindows(windows: readonly OpenWindow[], appName: string, ownPid: number = process.pid): OpenWindow[] {
  return windows.filter(
    (w) => w.id !== ownPid && !PROTECTED_PROCESSES.has(w.name.toLowerCase()) && foregroundMatchesApp(`${w.title}\t${w.name}`, appName)
  )
}

const comparable = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Les navigateurs (programme → son nom) : un onglet dont le titre parle de Spotify n'est pas Spotify. */
const BROWSERS: Record<string, string> = { chrome: 'chrome', msedge: 'edge', firefox: 'firefox', brave: 'brave', opera: 'opera', vivaldi: 'vivaldi', iexplore: 'internet explorer' }

/**
 * Relecture adverse (étape 508) : quoi fermer pour « ferme X ». D'abord le PROGRAMME qui porte ce nom (« spotify ») ;
 * sinon les fenêtres dont le titre contient le nom ENTIER (« Microsoft Edge », jamais « Microsoft Teams »), jamais un
 * navigateur pour un autre nom. Plusieurs programmes différents : rien n'est fermé, on demande lequel.
 */
export function windowsToClose(windows: readonly OpenWindow[], appName: string, ownPid: number = process.pid): OpenWindow[] | { ambiguous: OpenWindow[] } {
  const candidates = matchingWindows(windows, appName, ownPid)
  const wanted = comparable(appName)
  const words = wanted.split(' ').filter((w) => w.length >= 3)
  const byProgram = candidates.filter((w) => words.includes(comparable(w.name)) || comparable(w.name) === wanted.replace(/ /g, ''))
  if (byProgram.length) return byProgram
  const namesBrowser = (process: string): boolean => {
    const browser = Object.hasOwn(BROWSERS, process) ? BROWSERS[process] : null
    return browser === null || ` ${wanted} `.includes(` ${browser} `)
  }
  const byTitle = candidates.filter((w) => ` ${comparable(w.title)} `.includes(` ${wanted} `) && namesBrowser(w.name.toLowerCase()))
  // Étape 520 (audit) : le nom à la FIN du titre (« Rapport.docx - Word », « Calculatrice ») est celui de l'application,
  // là où Windows le met. Ailleurs dans le titre, c'est un document qui en PARLE (« Discord tutorial.mp4 - VLC » pour
  // « ferme Discord ») : jamais fermé d'office, on demande — avant, VLC était fermé.
  const atEnd = byTitle.filter((w) => ` ${comparable(w.title)}`.endsWith(` ${wanted}`))
  if (!atEnd.length) return byTitle.length ? { ambiguous: byTitle } : []
  const programs = new Set(atEnd.map((w) => w.name.toLowerCase()))
  return programs.size > 1 ? { ambiguous: atEnd } : atEnd
}

/** Lit la sortie JSON de LIST_WINDOWS (un seul objet ou un tableau) ; tout ce qui n'y ressemble pas est ignoré. */
export function parseWindows(stdout: string): OpenWindow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter(
    (w): w is OpenWindow =>
      Boolean(w) && typeof w === 'object' && Number.isInteger((w as OpenWindow).id) && typeof (w as OpenWindow).name === 'string' && typeof (w as OpenWindow).title === 'string'
  )
}

export const CLOSE_WINDOW = '$p = Get-Process -Id ([int]$env:JARIS_PID) -ErrorAction Stop; if (-not $p.CloseMainWindow()) { exit 3 }'

export const FOCUS_WINDOW = [
  "Add-Type -Namespace JarisWin -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);'",
  '$p = Get-Process -Id ([int]$env:JARIS_PID) -ErrorAction Stop',
  'if ([JarisWin.W]::IsIconic($p.MainWindowHandle)) { [void][JarisWin.W]::ShowWindow($p.MainWindowHandle, 9) }',
  'if (-not (New-Object -ComObject WScript.Shell).AppActivate([int]$env:JARIS_PID)) { exit 3 }'
].join('; ')

/**
 * « Ferme Spotify » / « remets Chrome devant ». Fermer = demander poliment à la fenêtre de se fermer (comme la croix) :
 * une application qui a un document non enregistré le demande elle-même. Jamais un arrêt forcé.
 */
export async function appWindow(action: string, appName: string): Promise<string> {
  const name = appName.trim()
  if (action !== 'close' && action !== 'focus') return `Action "${action}" inconnue : close ou focus.`
  if (!name) return t('app.noName')
  const listed = await runPowerShellScript(LIST_WINDOWS)
  if (listed.error) return t('pc.windowsFailed', { error: listed.error })
  const windows = parseWindows(listed.stdout)
  // Étape 520 (audit) : « remets X devant » suit la même règle que « ferme X » (le programme, sinon le nom en fin de
  // titre) — « edge » ne désigne plus la fenêtre « knowledge… ».
  const found = windowsToClose(windows, name)
  const chosen = Array.isArray(found) && action === 'focus' ? found.slice(0, 1) : found
  if (!Array.isArray(chosen)) {
    if (chosen.ambiguous.length === 1) {
      return `Aucune application « ${name} » n'est ouverte ; seule cette fenêtre en parle : ${chosen.ambiguous[0].title}. Demande à l'utilisateur si c'est bien elle avant de ${action === 'close' ? 'la fermer' : 'la remettre devant'} (avec son titre complet).`
    }
    return `Plusieurs applications correspondent, laquelle ${action === 'close' ? 'fermer' : 'remettre devant'} ?\n${chosen.ambiguous.map((w, i) => `${i + 1}. ${w.title}`).join('\n')}`
  }
  if (!chosen.length) return t('pc.appNotOpen', { app: name })
  for (const target of chosen) {
    const done = await runPowerShellScript(action === 'close' ? CLOSE_WINDOW : FOCUS_WINDOW, { ...process.env, JARIS_PID: String(target.id) })
    // « exit 3 » : la fenêtre a refusé de se fermer, ou Windows a refusé de la mettre devant — dit en clair.
    if (done.error && /code de sortie 3/.test(done.error)) return t(action === 'close' ? 'pc.closeRefused' : 'pc.focusBlocked', { app: target.title })
    if (done.error) return t(action === 'close' ? 'pc.closeFailed' : 'pc.focusFailed', { app: target.title, error: done.error })
  }
  if (action === 'focus') {
    // Windows peut se contenter de faire clignoter la fenêtre dans la barre des tâches : vérifié, jamais affirmé.
    if (!(await waitForForegroundApp(name, 2000))) return t('pc.focusBlocked', { app: chosen[0].title })
    return `${chosen[0].title} est au premier plan.`
  }
  return `Fermé : ${chosen.map((w) => w.title).join(', ')}.`
}

/**
 * Le volume général à un pourcentage exact, par l'API audio de Windows (Core Audio, IAudioEndpointVolume) — sans
 * dépendance. Les identifiants sont ceux de mmdeviceapi.h et endpointvolume.h ; l'ordre des méthodes doit suivre leur
 * déclaration (appel par la table virtuelle).
 */
export const VOLUME_CS = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n); int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float db, Guid ctx); int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float db); int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float db, Guid ctx); int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float db); int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class JarisVolume {
  public static void Set(float level) {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    var v = (IAudioEndpointVolume)o;
    Marshal.ThrowExceptionForHR(v.SetMute(false, Guid.Empty));
    Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(level, Guid.Empty));
  }
}
`

export async function setVolume(percent: unknown): Promise<string> {
  // Étape 520 (audit) : Number(null) et Number("") valent 0 — un pourcentage absent coupait le son au lieu d'être refusé.
  const value = percent === null || percent === undefined || String(percent).trim() === '' ? Number.NaN : Number(percent)
  if (!Number.isFinite(value)) return 'Pourcentage de volume invalide : un nombre de 0 à 100.'
  const level = Math.min(100, Math.max(0, Math.round(value)))
  const done = await runPowerShellScript(
    `Add-Type -TypeDefinition @'${VOLUME_CS}'@ -ErrorAction Stop; [JarisVolume]::Set([float]([int]$env:JARIS_VOLUME / 100))`,
    { ...process.env, JARIS_VOLUME: String(level) }
  )
  return done.error ? t('pc.volumeFailed', { error: done.error }) : `Volume réglé à ${level} %.`
}

/** Les pages de Paramètres que Jaris peut ouvrir (adresses ms-settings: de Microsoft), et seulement elles. */
export const SETTINGS_PAGES: Record<string, string> = {
  wifi: 'ms-settings:network-wifi',
  bluetooth: 'ms-settings:bluetooth',
  display: 'ms-settings:display',
  sound: 'ms-settings:sound',
  colors: 'ms-settings:colors',
  night_light: 'ms-settings:nightlight',
  battery: 'ms-settings:batterysaver',
  notifications: 'ms-settings:notifications',
  updates: 'ms-settings:windowsupdate',
  apps: 'ms-settings:appsfeatures',
  default_apps: 'ms-settings:defaultapps',
  mouse: 'ms-settings:mousetouchpad',
  keyboard: 'ms-settings:typing',
  printers: 'ms-settings:printers',
  storage: 'ms-settings:storagesense',
  privacy: 'ms-settings:privacy',
  language: 'ms-settings:regionlanguage',
  date_time: 'ms-settings:dateandtime',
  power: 'ms-settings:powersleep'
}

export const SET_BRIGHTNESS =
  '$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1; ' +
  'if (-not $m) { exit 4 }; Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$env:JARIS_BRIGHTNESS } -ErrorAction Stop | Out-Null'

export const SET_DARK_MODE =
  "$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; $v = [int]$env:JARIS_LIGHT; " +
  'Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value $v -Type DWord -ErrorAction Stop; ' +
  'Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value $v -Type DWord -ErrorAction Stop'

const plainWord = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
const DARK_ON = new Set(['true', 'on', 'oui', 'yes', '1', 'sombre', 'dark', 'mode sombre', 'dark mode', 'active', 'activer', 'enable', 'enabled'])
const DARK_OFF = new Set(['false', 'off', 'non', 'no', '0', 'clair', 'light', 'mode clair', 'light mode', 'desactive', 'desactiver', 'disable', 'disabled'])

/**
 * Un réglage de Windows : la luminosité (écrans de portable), le mode sombre, ou l'ouverture d'une page de Paramètres
 * (Wi-Fi, Bluetooth… : Léo y change lui-même ce qu'il veut). Le mode sombre de la version Store ouvre la page
 * « Couleurs » : Windows range à part les écritures de registre d'une application du Store (doc Microsoft « How
 * packaged desktop apps run on Windows ») — l'écrire aurait eu l'air de marcher sans rien changer.
 */
export async function windowsSetting(setting: string, value: unknown, store: boolean = process.windowsStore === true): Promise<string> {
  switch (setting) {
    case 'brightness': {
      const level = Number(value)
      if (!Number.isFinite(level)) return 'Luminosité invalide : un nombre de 0 à 100.'
      const percent = Math.min(100, Math.max(0, Math.round(level)))
      const done = await runPowerShellScript(SET_BRIGHTNESS, { ...process.env, JARIS_BRIGHTNESS: String(percent) })
      if (done.error) return /code de sortie 4|WmiMonitorBrightness|Not supported|non pris en charge/i.test(done.error) ? t('pc.brightnessUnsupported') : t('pc.settingFailed', { error: done.error })
      return `Luminosité réglée à ${percent} %.`
    }
    case 'dark_mode': {
      // Étape 520 (audit) : toute valeur non reconnue passait en mode CLAIR (« activé », « yes »…) — le contraire de la
      // demande. Les deux listes sont explicites ; le reste est refusé.
      const said = plainWord(String(value ?? ''))
      const dark = value === true || DARK_ON.has(said) ? true : value === false || DARK_OFF.has(said) ? false : null
      if (dark === null) return `Valeur "${String(value ?? '')}" inconnue pour le mode sombre : true (sombre) ou false (clair).`
      if (store) {
        await shell.openExternal(SETTINGS_PAGES.colors)
        return t('pc.darkModeStore')
      }
      const done = await runPowerShellScript(SET_DARK_MODE, { ...process.env, JARIS_LIGHT: dark ? '0' : '1' })
      return done.error ? t('pc.settingFailed', { error: done.error }) : dark ? 'Mode sombre activé.' : 'Mode clair activé.'
    }
    case 'open_page': {
      const key = String(value ?? '').trim().toLowerCase()
      // Étape 520 (audit) : « constructor », « __proto__ »… ne sont pas des pages.
      const page = Object.hasOwn(SETTINGS_PAGES, key) ? SETTINGS_PAGES[key] : undefined
      if (!page) return `Page "${String(value ?? '')}" inconnue. Pages disponibles : ${Object.keys(SETTINGS_PAGES).join(', ')}.`
      await shell.openExternal(page)
      return `Page de Paramètres ouverte : ${String(value)}.`
    }
    default:
      return `Réglage "${setting}" inconnu : brightness, dark_mode ou open_page.`
  }
}
