import { spawn } from 'child_process'

/**
 * Étape 263 — pilotage en arrière-plan (Léo : « on ne peut pas faire autre chose à côté, il faut attendre qu'il
 * clique »). Le pilote agissait avec la VRAIE souris et le VRAI clavier : pendant une tâche, Léo ne pouvait plus se
 * servir de son PC. Windows sait pourtant actionner un élément d'une fenêtre sans y toucher, par son accessibilité
 * (UI Automation) : « appuyer » sur un bouton (Invoke), cocher (Toggle), choisir (Select), déplier (ExpandCollapse),
 * remplir un champ (Value). La fenêtre peut rester derrière celle de Léo.
 *
 * Quand ce n'est pas possible (clic par position, touche du clavier, élément sans ces gestes), le pilote EMPRUNTE la
 * souris un instant : il ramène la fenêtre devant, fait le geste, puis rend le premier plan à la fenêtre de Léo
 * (focusWindow deux fois).
 *
 * Même découpage que screenMarks.ts : les scripts ne sont que des chaînes, toute la lecture de leurs réponses est du
 * TypeScript testable sans Windows. AUCUNE donnée venant d'un modèle n'entre dans un script : la demande (texte à
 * écrire compris) arrive en JSON par l'entrée standard, les poignées de fenêtre par variable d'environnement.
 */

/** Une action sur un élément, retrouvé par son identifiant Windows (RuntimeId), sinon par nom + position. */
export interface BackgroundActionRequest {
  hwnd: string
  rid?: string
  name: string
  type: string
  x: number
  y: number
  w: number
  h: number
  /** `invoke` : le geste naturel de l'élément ; `setValue` : écrire `text` dans un champ. */
  action: 'invoke' | 'setValue'
  text?: string
}

export interface BackgroundActionResult {
  ok: boolean
  /** Le geste utilisé (invoke, toggle, select, expand, value). */
  how?: string
  reason?: string
  /** Délai dépassé : Windows a peut-être fait l'action (un bouton qui ouvre une fenêtre bloque Invoke). */
  maybeDone?: boolean
}

/** Les éléments où l'on ÉCRIT : les choisir ne déclenche rien, le texte suivant y est déposé directement. */
export const FIELD_TYPES: ReadonlySet<string> = new Set(['Edit', 'ComboBox'])

const UIA_TYPES = `
  $types = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::MenuItem,
    [System.Windows.Automation.ControlType]::TabItem,
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::CheckBox,
    [System.Windows.Automation.ControlType]::RadioButton,
    [System.Windows.Automation.ControlType]::ComboBox,
    [System.Windows.Automation.ControlType]::Edit
  ) | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $_) }`

/**
 * Agit sur UN élément de la fenêtre, sans souris ni clavier. La demande est lue en JSON sur l'entrée standard.
 * Les mêmes types d'éléments que la capture (screenMarks.ts) : le numéro vu par le modèle désigne l'un d'eux.
 */
export const BACKGROUND_ACTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Send-Result($result) { Write-Output ($result | ConvertTo-Json -Compress) }
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $auto = [System.Windows.Automation.AutomationElement]
  $root = $auto::FromHandle([IntPtr][int64]$req.hwnd)
${UIA_TYPES}
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.OrCondition($types)))
  $target = $null
  if ($req.rid) {
    foreach ($element in $found) {
      try { if ((($element.GetRuntimeId()) -join '.') -eq [string]$req.rid) { $target = $element; break } } catch { }
    }
  }
  if ($target -eq $null) {
    # L'identifiant change quand la page se redessine : même nom, même place (à quelques pixels près).
    foreach ($element in $found) {
      try {
        $r = $element.Current.BoundingRectangle
        if ($element.Current.Name -eq [string]$req.name -and [Math]::Abs($r.X - [double]$req.x) -le 6 -and [Math]::Abs($r.Y - [double]$req.y) -le 6) { $target = $element; break }
      } catch { }
    }
  }
  if ($target -eq $null) { Send-Result @{ ok = $false; reason = 'élément introuvable dans la fenêtre' }; exit 0 }
  $pattern = $null
  if ($req.action -eq 'setValue') {
    if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
      $pattern.SetValue([string]$req.text)
      Send-Result @{ ok = $true; how = 'value' }
    } else {
      Send-Result @{ ok = $false; reason = 'ce champ ne se remplit pas sans le clavier' }
    }
    exit 0
  }
  if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); Send-Result @{ ok = $true; how = 'invoke' }; exit 0 }
  if ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); Send-Result @{ ok = $true; how = 'toggle' }; exit 0 }
  if ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); Send-Result @{ ok = $true; how = 'select' }; exit 0 }
  if ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    if ($pattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $pattern.Expand() } else { $pattern.Collapse() }
    Send-Result @{ ok = $true; how = 'expand' }; exit 0
  }
  Send-Result @{ ok = $false; reason = 'cet élément ne se déclenche pas sans la souris' }
} catch {
  Send-Result @{ ok = $false; reason = $_.Exception.Message }
}
`

/**
 * Met la fenêtre JARIS_HWND au premier plan et renvoie celle qui l'était avant (pour la rendre ensuite). Sert dans les
 * deux sens : prendre la fenêtre du pilote, puis rendre celle de Léo. Windows refuse le premier plan à un processus
 * en arrière-plan : on s'attache d'abord à la file de saisie de la fenêtre active (AttachThreadInput), ce qui ne
 * simule aucune touche (une pression d'Alt ouvrirait le menu de certaines applis de Léo).
 */
export const FOCUS_WINDOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Jaris -Name Focus -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
'@
try {
  $previous = [Jaris.Focus]::GetForegroundWindow()
  if (-not ($env:JARIS_HWND -match '^[0-9]+$')) { Write-Output (@{ ok = $false; previous = [string]$previous.ToInt64() } | ConvertTo-Json -Compress); exit 0 }
  $t = [IntPtr][int64]$env:JARIS_HWND
  if (-not [Jaris.Focus]::IsWindow($t)) { Write-Output (@{ ok = $false; previous = [string]$previous.ToInt64() } | ConvertTo-Json -Compress); exit 0 }
  if ([Jaris.Focus]::IsIconic($t)) { [void][Jaris.Focus]::ShowWindow($t, 9) }
  $me = [Jaris.Focus]::GetCurrentThreadId()
  $other = [Jaris.Focus]::GetWindowThreadProcessId($previous, [IntPtr]::Zero)
  $attached = $false
  if ($other -ne 0 -and $other -ne $me) { $attached = [Jaris.Focus]::AttachThreadInput($me, $other, $true) }
  [void][Jaris.Focus]::BringWindowToTop($t)
  [void][Jaris.Focus]::SetForegroundWindow($t)
  if ($attached) { [void][Jaris.Focus]::AttachThreadInput($me, $other, $false) }
  Start-Sleep -Milliseconds 250
  $ok = ([Jaris.Focus]::GetForegroundWindow() -eq $t)
  Write-Output (@{ ok = $ok; previous = [string]$previous.ToInt64() } | ConvertTo-Json -Compress)
} catch {
  Write-Output (@{ ok = $false; previous = ''; reason = $_.Exception.Message } | ConvertTo-Json -Compress)
}
`

/** Les fenêtres visibles, de la plus haute à la plus basse : prise juste avant d'ouvrir une application. */
export const LIST_WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Jaris -Name Windows -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
'@
$ids = New-Object System.Collections.ArrayList
$h = [Jaris.Windows]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ([Jaris.Windows]::IsWindowVisible($h)) { [void]$ids.Add([string]$h.ToInt64()) }
  $h = [Jaris.Windows]::GetWindow($h, 2)
}
Write-Output (@{ hwnds = @($ids) } | ConvertTo-Json -Compress)
`

const HWND = /^[1-9]\d*$/

/** Réponse du script d'action ; toute sortie illisible est un échec, jamais une action réussie. */
export function parseActionOutput(stdout: string): BackgroundActionResult {
  try {
    const data = JSON.parse(stdout.trim()) as { ok?: unknown; how?: unknown; reason?: unknown }
    if (data?.ok === true) return { ok: true, how: typeof data.how === 'string' ? data.how : undefined }
    return { ok: false, reason: typeof data?.reason === 'string' && data.reason.trim() ? data.reason.trim() : 'réponse de Windows sans explication' }
  } catch {
    return { ok: false, reason: 'réponse de Windows illisible' }
  }
}

export function parseFocusOutput(stdout: string): { ok: boolean; previous?: string } {
  try {
    const data = JSON.parse(stdout.trim()) as { ok?: unknown; previous?: unknown }
    const previous = typeof data?.previous === 'string' && HWND.test(data.previous) ? data.previous : undefined
    return { ok: data?.ok === true, previous }
  } catch {
    return { ok: false }
  }
}

/** `ConvertTo-Json` de PowerShell 5.1 sort UNE fenêtre en texte simple et non en tableau (piège de l'étape 32). */
export function parseWindowList(stdout: string): string[] {
  try {
    const data = JSON.parse(stdout.trim()) as { hwnds?: unknown }
    const list = Array.isArray(data?.hwnds) ? data.hwnds : data?.hwnds !== undefined && data?.hwnds !== null ? [data.hwnds] : []
    return list.map(String).filter((h) => HWND.test(h))
  } catch {
    return []
  }
}

interface RunOptions {
  env?: Record<string, string>
  stdin?: string
  timeoutMs: number
}

/** Lance un script PowerShell caché ; `null` si Windows ne répond pas à temps. */
function runPowerShell(script: string, { env = {}, stdin, timeoutMs }: RunOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, ...env }
    })
    let out = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(null)
    }, timeoutMs)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => (out += chunk))
    proc.on('error', () => finish(''))
    proc.on('close', () => finish(out))
    if (stdin !== undefined) proc.stdin.end(stdin, 'utf8')
    else proc.stdin.end()
  })
}

/** Un bouton qui ouvre une fenêtre modale bloque Invoke jusqu'à sa fermeture : au-delà, on ne sait pas. */
const ACTION_TIMEOUT_MS = 20_000
const FOCUS_TIMEOUT_MS = 8_000

export async function runBackgroundAction(request: BackgroundActionRequest): Promise<BackgroundActionResult> {
  if (process.platform !== 'win32') return { ok: false, reason: 'pilotage en arrière-plan réservé à Windows' }
  const stdout = await runPowerShell(BACKGROUND_ACTION_SCRIPT, { stdin: JSON.stringify(request), timeoutMs: ACTION_TIMEOUT_MS })
  if (stdout === null) return { ok: false, maybeDone: true, reason: `pas de réponse de Windows en ${ACTION_TIMEOUT_MS / 1000} s` }
  return parseActionOutput(stdout)
}

/** Met `hwnd` au premier plan ; renvoie la fenêtre qui l'était avant (pour la rendre après le geste). */
export async function focusWindow(hwnd: string): Promise<{ ok: boolean; previous?: string }> {
  if (process.platform !== 'win32' || !HWND.test(hwnd)) return { ok: false }
  const stdout = await runPowerShell(FOCUS_WINDOW_SCRIPT, { env: { JARIS_HWND: hwnd }, timeoutMs: FOCUS_TIMEOUT_MS })
  return stdout ? parseFocusOutput(stdout) : { ok: false }
}

export async function listTopWindows(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const stdout = await runPowerShell(LIST_WINDOWS_SCRIPT, { timeoutMs: FOCUS_TIMEOUT_MS })
  return stdout ? parseWindowList(stdout) : []
}
