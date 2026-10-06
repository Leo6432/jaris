import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { DuelCapture, DuelElement } from './pilotDuel'

/**
 * Étape 249 : une capture du vrai écran ET la position exacte de ses boutons, prises par LE MÊME processus
 * PowerShell, déclaré sensible au DPI avant tout : capture et rectangles sont alors dans le même repère (pixels
 * réels), quel que soit le zoom d'affichage de Windows (125 %, 150 %…). Les prendre dans deux processus
 * différents, ou la capture par Electron (pixels logiques) et les rectangles par PowerShell, aurait décalé
 * toutes les cibles sur un écran mis à l'échelle — et faussé le duel sans que rien ne le signale.
 * Lecture seule, aucune donnée venant d'un modèle ni de l'utilisateur dans le script : le chemin du fichier (créé
 * par Jaris) passe par une variable d'environnement.
 */
export const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace Jaris -Name Duel -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
'@
[void][Jaris.Duel]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save($env:JARIS_DUEL_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# La fenêtre VISIBLE la plus au-dessus qui n'est PAS Jaris : Jaris vient de se cacher, mais Windows le considère
# souvent encore comme « la fenêtre active » — ses boutons, absents de la photo, devenaient des cibles impossibles
# (1er duel de Léo, 06/10/2026 : 14 cibles sur 30). On parcourt donc les fenêtres de haut en bas (ordre Z) et on
# écarte : Jaris, les fenêtres réduites, masquées par Windows (« cloaked »), transparentes aux clics ou d'outil,
# sans titre, minuscules, et le bureau/la barre des tâches.
$jarisPid = [uint32]$env:JARIS_PID
$win = [IntPtr]::Zero
$title = ''
$rect = New-Object Jaris.Duel+RECT
$h = [Jaris.Duel]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  if ([Jaris.Duel]::IsWindowVisible($h) -and -not [Jaris.Duel]::IsIconic($h)) {
    $p = [uint32]0
    [void][Jaris.Duel]::GetWindowThreadProcessId($h, [ref]$p)
    $cloaked = 0
    [void][Jaris.Duel]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    $ex = [Jaris.Duel]::GetWindowLong($h, -20)
    $cls = New-Object System.Text.StringBuilder 256
    [void][Jaris.Duel]::GetClassName($h, $cls, 256)
    $txt = New-Object System.Text.StringBuilder 512
    [void][Jaris.Duel]::GetWindowText($h, $txt, 512)
    $r = New-Object Jaris.Duel+RECT
    [void][Jaris.Duel]::GetWindowRect($h, [ref]$r)
    $ok = ($p -ne $jarisPid) -and ($cloaked -eq 0) -and (($ex -band 0xA0) -eq 0) -and ($txt.Length -gt 0) -and
      (($r.Right - $r.Left) -ge 300) -and (($r.Bottom - $r.Top) -ge 200) -and
      (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -notcontains $cls.ToString())
    if ($ok) { $win = $h; $title = $txt.ToString(); $rect = $r; break }
  }
  $h = [Jaris.Duel]::GetWindow($h, 2)
}

$auto = [System.Windows.Automation.AutomationElement]
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
) | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $_) }
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($auto::IsOffscreenProperty, $false)),
  (New-Object System.Windows.Automation.OrCondition($types))
)

$out = New-Object System.Collections.ArrayList
$zones = @(@{ hwnd = $win; zone = 'window' }, @{ hwnd = [Jaris.Duel]::FindWindow('Shell_TrayWnd', $null); zone = 'taskbar' })
foreach ($z in $zones) {
  if ($z.hwnd -eq [IntPtr]::Zero) { continue }
  try { $root = $auto::FromHandle($z.hwnd) } catch { continue }
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  # Chromium (Chrome, Edge, Discord, Electron…) ne construit son arbre d'accessibilité qu'au PREMIER client qui le
  # demande : la 1re lecture peut revenir presque vide. On redemande une fois, après lui avoir laissé le temps.
  if ($found.Count -lt 5) {
    Start-Sleep -Milliseconds 1500
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  }
  $count = 0
  foreach ($element in $found) {
    if ($count -ge 300) { break }
    try {
      $name = $element.Current.Name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      $er = $element.Current.BoundingRectangle
      if ($er.IsEmpty -or $er.Width -le 0 -or $er.Height -le 0) { continue }
      # Un bouton qui dépasse de SA fenêtre (liste défilée, menu replié) n'est pas entièrement sur la photo.
      if ($z.zone -eq 'window' -and ($er.Left -lt $rect.Left -or $er.Top -lt $rect.Top -or $er.Right -gt $rect.Right -or $er.Bottom -gt $rect.Bottom)) { continue }
      [void]$out.Add([pscustomobject]@{
        name = $name.Trim()
        type = ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '')
        zone = $z.zone
        x = [int]($er.X - $b.X); y = [int]($er.Y - $b.Y); w = [int]$er.Width; h = [int]$er.Height
      })
      $count++
    } catch { continue }
  }
}
Write-Output (@{ width = $b.Width; height = $b.Height; window = $title; elements = @($out) } | ConvertTo-Json -Compress -Depth 4)
`

function isElement(value: unknown): value is DuelElement {
  const e = value as Partial<DuelElement> | null
  return (
    !!e &&
    typeof e.name === 'string' &&
    typeof e.type === 'string' &&
    [e.x, e.y, e.w, e.h].every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * Lit la sortie du script. Comme ailleurs avec PowerShell 5.1, une liste d'UN élément ressort en objet et non en
 * tableau : sans ce garde, un écran avec un seul bouton perdrait ce bouton.
 */
export function parseCaptureOutput(stdout: string, png: string): DuelCapture | null {
  let data: { width?: unknown; height?: unknown; window?: unknown; elements?: unknown }
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (typeof data.width !== 'number' || typeof data.height !== 'number' || data.width <= 0 || data.height <= 0) return null
  const list = Array.isArray(data.elements) ? data.elements : data.elements ? [data.elements] : []
  const window = typeof data.window === 'string' && data.window.trim() ? data.window.trim() : undefined
  return { png, width: data.width, height: data.height, window, elements: list.filter(isElement) }
}

/** Capture + positions. Lève une erreur claire (lisible par Léo) si Windows ne répond pas. */
export async function captureScreenWithElements(png: string): Promise<DuelCapture> {
  if (process.platform !== 'win32') throw new Error('Le duel des pilotes ne fonctionne que sous Windows.')
  await mkdir(dirname(png), { recursive: true })
  const stdout = await new Promise<string>((resolve, reject) => {
    // Même lancement que listClickableElements (uiAutomation.ts), éprouvé sur la machine de Léo.
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', CAPTURE_SCRIPT], {
      windowsHide: true,
      // Le processus principal d'Electron possède toutes les fenêtres de Jaris : c'est lui qu'on écarte.
      env: { ...process.env, JARIS_DUEL_PNG: png, JARIS_PID: String(process.pid) }
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error("La capture de l'écran a pris plus de 60 secondes."))
    }, 60_000)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => (out += chunk))
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`La capture de l'écran a échoué : ${err.trim().split('\n')[0] || `code ${code}`}`))
    })
  })
  const capture = parseCaptureOutput(stdout, png)
  if (!capture) throw new Error("La capture de l'écran n'a rien renvoyé de lisible.")
  return capture
}
