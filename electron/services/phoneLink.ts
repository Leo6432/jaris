import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PhoneNotification, PhoneNotificationsResult } from '../../shared/ipc'

const execFileAsync = promisify(execFile)

/**
 * Lecture des notifications du téléphone via "Mobile connecté" (Phone Link), étape 21bis.
 *
 * POURQUOI CE CHEMIN, après avoir retiré KDE Connect à la demande de Léo ("enlève tout kde connect on va
 * faire soit mobile connecté soit rien"). Mobile connecté n'expose AUCUNE API : le piloter voudrait dire
 * cliquer dans sa fenêtre à l'aveugle. MAIS il n'y a pas besoin de lui parler pour lire les notifications
 * du téléphone — il les dépose dans le CENTRE DE NOTIFICATIONS de Windows, et Windows, lui, a une vraie API
 * documentée pour ça : `UserNotificationListener` (Windows.UI.Notifications.Management, présente depuis
 * Windows 10 1607). On lit donc la source officielle de Windows plutôt que l'écran d'une application.
 *
 * CE QUE ÇA CHANGE PAR RAPPORT À UN PILOTAGE DE FENÊTRE : rien à cliquer, rien qui dépende de la langue de
 * Windows, de la version de Mobile connecté ou de la position des éléments à l'écran, et aucune action
 * déclenchée — c'est une LECTURE. Un échec est inoffensif : on renvoie une liste vide et un message clair.
 *
 * DEUX CONDITIONS, toutes les deux hors de notre contrôle et annoncées comme telles à Léo :
 *  - Windows demande une AUTORISATION explicite (`RequestAccessAsync`, documenté sur learn.microsoft.com :
 *    « UserNotificationListener requires explicit user permission to be granted before it may be used »).
 *    La première utilisation ouvre donc une demande Windows ; refusée, on le DIT au lieu de rendre une liste
 *    vide qui ressemblerait à "tu n'as rien reçu".
 *  - Les notifications de l'iPhone n'arrivent dans le centre de notifications QUE si Mobile connecté est
 *    installé, appairé au téléphone en Bluetooth, et que "Partager les notifications du système" est activé
 *    côté iPhone. Sinon, cette lecture ne verra que les notifications du PC — ce qui est un FAIT utile à
 *    afficher, pas un échec à masquer.
 *
 * NON VÉRIFIABLE DANS CET ENVIRONNEMENT (ni Windows, ni iPhone, ni Mobile connecté) : que l'autorisation
 * soit accordée à une application non empaquetée comme Jaris. La documentation Microsoft ne le dit pas
 * explicitement, et je ne l'invente pas : le résultat renvoyé ici distingue explicitement "refusé" de
 * "impossible sur cette machine", pour que le premier essai de Léo tranche avec un fait plutôt qu'avec une
 * supposition de ma part.
 *
 * SÉCURITÉ : ce script ne contient AUCUNE donnée venant du modèle ou d'une phrase dictée — il ne prend
 * aucun paramètre. C'est la même règle que le script UI Automation de l'étape 32 : ce qui n'est pas
 * vérifiable ici (PowerShell) ne manipule jamais de données non fiables, et tout ce qui les manipule
 * (l'analyse de la sortie, ci-dessous) est du TypeScript testable.
 */
const READ_NOTIFICATIONS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
  Write-Output (@{ status = 'unsupported'; detail = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}

# Les appels WinRT rendent un IAsyncOperation : en PowerShell 5.1 (celui livré avec Windows), on l'attend
# via l'extension AsTask, récupérée par réflexion — il n'existe pas de mot-clé await ici.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $null = $task.Wait(20000)
  $task.Result
}

try {
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
  if ("$access" -ne 'Allowed') {
    Write-Output (@{ status = 'denied'; detail = "$access" } | ConvertTo-Json -Compress)
    exit 0
  }

  $notifications = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
  $items = @()
  foreach ($notification in $notifications) {
    $app = ''
    try { $app = $notification.AppInfo.DisplayInfo.DisplayName } catch { $app = '' }
    $lines = @()
    try {
      $binding = $notification.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      if ($binding) { foreach ($element in $binding.GetTextElements()) { $lines += $element.Text } }
    } catch { }
    $items += @{ app = $app; lines = $lines }
  }
  Write-Output (@{ status = 'allowed'; notifications = $items } | ConvertTo-Json -Compress -Depth 4)
} catch {
  Write-Output (@{ status = 'error'; detail = $_.Exception.Message } | ConvertTo-Json -Compress)
}
`

/**
 * Remet en forme ce que le script renvoie.
 *
 * Fonction PURE, exportée pour être testable sans Windows — même principe que `findElementByName`
 * (uiAutomation.ts) : tout ce qui peut être vérifié ici l'est, et la partie PowerShell reste minimale.
 *
 * PIÈGE DÉJÀ RENCONTRÉ DANS CE DÉPÔT, et qui frappe exactement ici : `ConvertTo-Json` de PowerShell 5.1 n'a
 * pas `-AsArray`, donc une liste d'UN SEUL élément ressort en OBJET, pas en tableau d'un élément. Une seule
 * notification — le cas le plus banal — se serait donc perdue sans ce garde. Idem pour les lignes de texte
 * d'une notification qui n'en contient qu'une.
 */
export function parseNotificationsOutput(stdout: string): PhoneNotificationsResult {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { status: 'error', notifications: [], message: messageFor('error', "Windows n'a rien répondu.") }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { status: 'error', notifications: [], message: messageFor('error', trimmed.slice(0, 200)) }
  }

  const payload = parsed as { status?: string; detail?: string; notifications?: unknown }
  const status = payload.status === 'allowed' || payload.status === 'denied' || payload.status === 'unsupported' ? payload.status : 'error'
  if (status !== 'allowed') {
    return { status, notifications: [], message: messageFor(status, payload.detail ?? '') }
  }

  const raw = toArray(payload.notifications)
  const notifications: PhoneNotification[] = raw.map((entry) => {
    const item = entry as { app?: unknown; lines?: unknown }
    return {
      app: typeof item.app === 'string' ? item.app : '',
      lines: toArray(item.lines).filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    }
  })
  return { status, notifications, message: messageFor('allowed', '', notifications.length) }
}

/** Un objet seul là où on attend une liste = le cas "un seul élément" de ConvertTo-Json (voir ci-dessus). */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

/** Messages écrits pour Léo, lisibles tels quels : rien ne les reformule avant affichage (assistant.ts). */
function messageFor(status: PhoneNotificationsResult['status'], detail: string, count = 0): string {
  switch (status) {
    case 'allowed':
      return count === 0
        ? "Aucune notification en cours sur cet ordinateur. Si tu en attendais depuis ton téléphone : ouvre Mobile connecté, vérifie qu'il est bien relié à ton iPhone, et sur le téléphone que « Partager les notifications du système » est activé dans les réglages Bluetooth."
        : `${count} notification(s) en cours.`
    case 'denied':
      return "Windows n'autorise pas Jaris à lire tes notifications. Va dans Paramètres Windows → Confidentialité et sécurité → Notifications, et autorise l'accès aux notifications, puis réessaie."
    case 'unsupported':
      return `Cette version de Windows ne permet pas de lire les notifications (${detail.trim() || 'composant absent'}).`
    default:
      return `La lecture des notifications a échoué : ${detail.trim() || 'raison inconnue'}.`
  }
}

/**
 * Lit les notifications actuellement affichées par Windows (donc celles du téléphone quand Mobile connecté
 * les y dépose). Ne lève jamais : un échec devient un résultat lisible, comme partout ailleurs dans Jaris.
 */
export async function readPhoneNotifications(): Promise<PhoneNotificationsResult> {
  try {
    // windowsHide : sans lui, une console noire clignote à chaque lecture (piège déjà rencontré avec les
    // commandes internes d'Ollama). `-NoProfile` : le profil de l'utilisateur peut écrire dans la sortie.
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', READ_NOTIFICATIONS_SCRIPT],
      { windowsHide: true, timeout: 40_000, maxBuffer: 4 * 1024 * 1024 }
    )
    return parseNotificationsOutput(stdout)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'error', notifications: [], message: messageFor('error', detail) }
  }
}

/** Rend les notifications lisibles à voix haute / en chat : une ligne par notification, sans jargon. */
export function formatNotificationsForSpeech(result: PhoneNotificationsResult): string {
  if (result.status !== 'allowed' || result.notifications.length === 0) return result.message
  return result.notifications
    .map((notification) => {
      const texte = notification.lines.join(' — ')
      return notification.app ? `${notification.app} : ${texte}` : texte
    })
    .join('\n')
}
