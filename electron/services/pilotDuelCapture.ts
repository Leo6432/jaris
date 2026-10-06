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
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
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
# La fenêtre au premier plan (celle que Léo a ouverte) et la barre des tâches.
foreach ($hwnd in @([Jaris.Duel]::GetForegroundWindow(), [Jaris.Duel]::FindWindow('Shell_TrayWnd', $null))) {
  if ($hwnd -eq [IntPtr]::Zero) { continue }
  try { $root = $auto::FromHandle($hwnd) } catch { continue }
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $count = 0
  foreach ($element in $found) {
    if ($count -ge 300) { break }
    try {
      $name = $element.Current.Name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      $r = $element.Current.BoundingRectangle
      if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
      [void]$out.Add([pscustomobject]@{
        name = $name.Trim()
        type = ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '')
        x = [int]($r.X - $b.X); y = [int]($r.Y - $b.Y); w = [int]$r.Width; h = [int]$r.Height
      })
      $count++
    } catch { continue }
  }
}
Write-Output (@{ width = $b.Width; height = $b.Height; elements = @($out) } | ConvertTo-Json -Compress -Depth 4)
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
  let data: { width?: unknown; height?: unknown; elements?: unknown }
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (typeof data.width !== 'number' || typeof data.height !== 'number' || data.width <= 0 || data.height <= 0) return null
  const list = Array.isArray(data.elements) ? data.elements : data.elements ? [data.elements] : []
  return { png, width: data.width, height: data.height, elements: list.filter(isElement) }
}

/** Capture + positions. Lève une erreur claire (lisible par Léo) si Windows ne répond pas. */
export async function captureScreenWithElements(png: string): Promise<DuelCapture> {
  if (process.platform !== 'win32') throw new Error('Le duel des pilotes ne fonctionne que sous Windows.')
  await mkdir(dirname(png), { recursive: true })
  const stdout = await new Promise<string>((resolve, reject) => {
    // Même lancement que listClickableElements (uiAutomation.ts), éprouvé sur la machine de Léo.
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', CAPTURE_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, JARIS_DUEL_PNG: png }
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
