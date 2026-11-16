import type { LaunchAtStartupStatus } from '../../shared/ipc'

/**
 * Lancer Jaris au démarrage de Windows (Options → Général, étape 165 — Léo : « dès que le PC démarre on voit
 * la fenêtre Jaris et pas le fond d'écran, et pour l'activer/désactiver »).
 *
 * La SEULE source de vérité est l'entrée de démarrage de Windows elle-même (clé Run du registre, posée par
 * `app.setLoginItemSettings`), jamais un champ du profil : un champ à part pourrait dire « activé » alors que
 * l'entrée a été retirée depuis le Gestionnaire des tâches, et l'interface mentirait.
 *
 * `LOGIN_LAUNCH_ARG` est ajouté à la commande enregistrée : c'est ce qui permet au démarrage de savoir que
 * c'est Windows qui a lancé Jaris (afficher la fenêtre) et pas un démarrage normal (rester discret). Sur
 * Windows, `getLoginItemSettings` doit recevoir les MÊMES arguments pour retrouver l'entrée — d'où une seule
 * constante partagée par les deux appels.
 *
 * L'objet `app` est passé en paramètre (pas importé d'electron) pour que la logique soit testable sans
 * Electron.
 */
export const LOGIN_LAUNCH_ARG = '--launched-at-login'

export interface LoginItemApi {
  isPackaged: boolean
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void
}

/** Une version de développement (non installée) enregistrerait `electron.exe` sans l'application : refusé. */
function isSupported(api: LoginItemApi, platform: string): boolean {
  return platform === 'win32' && api.isPackaged
}

/**
 * Étape 491 : dans la version Microsoft Store, la clé Run ne sert à rien (Windows range les écritures d'un paquet dans
 * HKCU à part, invisibles de l'ouverture de session). Le manifeste déclare une tâche de démarrage
 * (installer/AppxManifest.xml) : Jaris apparaît dans Paramètres → Applications → Démarrage, où Léo l'active. Électron
 * ne sait ni lire ni changer cette tâche : l'écran propose d'ouvrir cette page de Windows au lieu d'un interrupteur.
 */
export const STORE_STARTUP_SETTINGS_URL = 'ms-settings:startupapps'

export function getLaunchAtStartup(api: LoginItemApi, platform: string, store = false): LaunchAtStartupStatus {
  if (store) return { supported: true, enabled: false, blockedByWindows: false, store: true }
  if (!isSupported(api, platform)) return { supported: false, enabled: false, blockedByWindows: false }
  const settings = api.getLoginItemSettings({ args: [LOGIN_LAUNCH_ARG] })
  return {
    supported: true,
    enabled: settings.openAtLogin,
    // Entrée présente mais désactivée dans Paramètres → Applications → Démarrage (ou le Gestionnaire des
    // tâches) : Windows ne lancera PAS Jaris, et le dire vaut mieux qu'un interrupteur « activé » trompeur.
    blockedByWindows: settings.openAtLogin && settings.executableWillLaunchAtLogin === false
  }
}

export function setLaunchAtStartup(api: LoginItemApi, platform: string, enabled: boolean, store = false): LaunchAtStartupStatus {
  if (store || !isSupported(api, platform)) return getLaunchAtStartup(api, platform, store)
  api.setLoginItemSettings({ openAtLogin: enabled, args: [LOGIN_LAUNCH_ARG] })
  // Relu plutôt que supposé : c'est l'état réellement enregistré par Windows qui s'affiche.
  return getLaunchAtStartup(api, platform)
}

export function wasLaunchedAtLogin(argv: readonly string[]): boolean {
  return argv.includes(LOGIN_LAUNCH_ARG)
}

/**
 * Après un lancement au démarrage, la perte de focus ne replie pas la fenêtre en widget pendant ce délai :
 * pendant l'ouverture de session, l'Explorateur et les autres programmes de démarrage prennent le focus tour
 * à tour — sans ce délai, la fenêtre se replierait aussitôt et on retrouverait le fond d'écran.
 */
export const LOGIN_REVEAL_GRACE_MS = 30_000
