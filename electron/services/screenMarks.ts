/**
 * Étape 256 — pilotage d'écran : les boutons que Windows connaît sont encadrés et numérotés sur la capture
 * (méthode « Set-of-Marks », reprise d'Hermes Agent, tools/computer_use). Le modèle répond « clique le 12 » et Jaris
 * clique au centre du rectangle que Windows a donné : aucune position à deviner sur l'image.
 *
 * Deux défauts du pilotage d'avant, corrigés ici :
 * - la liste venait de la fenêtre ACTIVE (GetForegroundWindow) : quand Léo parlait depuis Jaris, c'étaient les
 *   boutons de Jaris qui étaient listés. On prend la fenêtre visible la plus haute qui n'est PAS Jaris, avec les
 *   mêmes filtres que le duel des pilotes (étape 249), éprouvés sur la machine de Léo ;
 * - la liste et la capture venaient de deux processus de DPI différents : sur un écran à 125 % ou 150 %, leurs
 *   repères ne coïncidaient pas. Capture et rectangles sont pris par LE MÊME processus PowerShell, déclaré sensible
 *   au DPI (pixels réels), et les clics qui en découlent sont faits dans ce même repère (inputControl.ts).
 *
 * Module pur (ni Electron ni Windows) : le script n'est qu'une chaîne, la sélection et le dessin des numéros
 * travaillent sur des données — testés sans Windows (scripts/test-screen-marks.mjs).
 */

/** Un élément de la fenêtre visée, en pixels réels de l'écran principal (coin haut gauche + taille). */
export interface ScreenElement {
  name: string
  /** Type de contrôle sans son préfixe (`Button`, `Hyperlink`, `Edit`...). */
  type: string
  x: number
  y: number
  w: number
  h: number
  /** Étape 263 : identifiant de Windows (RuntimeId), pour retrouver l'élément et agir dessus sans la souris. */
  rid?: string
}

/** Un élément retenu, avec le numéro dessiné sur la capture. */
export interface ScreenMark extends ScreenElement {
  id: number
}

export interface MarksCaptureOutput {
  width: number
  height: number
  /** Titre de la fenêtre visée (absent si aucune fenêtre ne convient : bureau seul, tout réduit). */
  window?: string
  elements: ScreenElement[]
  /** Étape 263 : poignée de la fenêtre capturée (nombre en texte) — une boîte de dialogue de la fenêtre gardée, s'il y en a une. */
  hwnd?: string
  /** Étape 263 : la fenêtre principale dont elle dépend : c'est elle qu'on garde d'une étape à l'autre. */
  root?: string
  /** Étape 263 : la fenêtre gardée demandée, renvoyée seulement si elle existe encore. */
  target?: string
  /** Étape 263 : rectangle de cette fenêtre à l'écran, en pixels réels. */
  rect?: { x: number; y: number; w: number; h: number }
  /** Étape 263 : `window` = l'image est la fenêtre seule (même cachée derrière d'autres), `screen` = l'écran entier. */
  capture?: 'window' | 'screen'
}

/** Au-delà, les numéros couvrent la page et noient le modèle ; la liste garde les premiers dans l'ordre de Windows. */
export const MAX_MARKS = 100

/** Trop petit pour être cliqué de façon fiable, ou pour porter un numéro lisible. */
const MIN_SIDE = 6

/**
 * Lu par le script, dans l'ordre de l'arbre de Windows (haut de page d'abord) ; MAX_MARKS en est tiré après tri.
 * Chaque propriété lue est un aller-retour avec la fenêtre inspectée : la limite tient le temps de capture.
 */
const MAX_READ = 250

/**
 * Le script de capture : écran + éléments de la fenêtre visée, dans un seul processus sensible au DPI. Repris du
 * duel des pilotes (étape 249), qui a tourné sur la machine de Léo (Explorateur, YouTube, Firefox, Discord) :
 * même choix de fenêtre, même relecture pour Chromium, mêmes rectangles. Lecture seule, aucune donnée venant d'un
 * modèle ou de l'utilisateur dans le script : le chemin du fichier (créé par Jaris) et le numéro de processus de
 * Jaris passent par des variables d'environnement.
 */
export const MARKS_CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace Jaris -Name Marks -MemberDefinition @'
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
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
'@
[void][Jaris.Marks]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# La fenêtre VISIBLE la plus au-dessus qui n'est PAS Jaris (ordre Z, de haut en bas). On écarte : Jaris, les
# fenêtres réduites, masquées par Windows (« cloaked »), transparentes aux clics ou d'outil, sans titre,
# minuscules, et le bureau/la barre des tâches.
$jarisPid = [uint32]$env:JARIS_PID
$win = [IntPtr]::Zero
$title = ''
$rect = New-Object Jaris.Marks+RECT
# Étape 263 : la fenêtre gardée d'une étape à l'autre (pilotage en arrière-plan), si elle existe encore ; sinon les
# fenêtres à écarter (celles qui existaient avant d'ouvrir une application : on cherche la NOUVELLE).
$exclude = @()
if ($env:JARIS_EXCLUDE_HWNDS) { $exclude = @($env:JARIS_EXCLUDE_HWNDS -split ',' | Where-Object { $_ -match '^[0-9]+$' }) }
# « target » : la fenêtre gardée, renvoyée seulement si elle existe encore (sinon Jaris le saura et ne piochera pas une
# autre fenêtre en silence, peut-être celle de Léo).
$requested = ''
if ($env:JARIS_TARGET_HWND -match '^[0-9]+$') {
  $t = [IntPtr][int64]$env:JARIS_TARGET_HWND
  if ([Jaris.Marks]::IsWindow($t) -and [Jaris.Marks]::IsWindowVisible($t)) {
    $requested = [string]$t.ToInt64()
    # Réduite, elle ne se dessine pas : on la rouvre sans la mettre au premier plan (SW_SHOWNOACTIVATE).
    if ([Jaris.Marks]::IsIconic($t)) { [void][Jaris.Marks]::ShowWindow($t, 4); Start-Sleep -Milliseconds 300 }
    # Une boîte de dialogue ouverte par cette fenêtre (Enregistrer sous, confirmation) est une fenêtre à part :
    # c'est elle qu'on regarde tant qu'elle est là (GW_ENABLEDPOPUP).
    $popup = [Jaris.Marks]::GetWindow($t, 6)
    if ($popup -ne [IntPtr]::Zero -and $popup -ne $t -and [Jaris.Marks]::IsWindowVisible($popup)) { $t = $popup }
    $txt = New-Object System.Text.StringBuilder 512
    [void][Jaris.Marks]::GetWindowText($t, $txt, 512)
    [void][Jaris.Marks]::GetWindowRect($t, [ref]$rect)
    $win = $t; $title = $txt.ToString()
  }
}
$h = [IntPtr]::Zero
if ($win -eq [IntPtr]::Zero) { $h = [Jaris.Marks]::GetTopWindow([IntPtr]::Zero) }
while ($h -ne [IntPtr]::Zero) {
  if ([Jaris.Marks]::IsWindowVisible($h) -and -not [Jaris.Marks]::IsIconic($h)) {
    $p = [uint32]0
    [void][Jaris.Marks]::GetWindowThreadProcessId($h, [ref]$p)
    $cloaked = 0
    [void][Jaris.Marks]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    $ex = [Jaris.Marks]::GetWindowLong($h, -20)
    $cls = New-Object System.Text.StringBuilder 256
    [void][Jaris.Marks]::GetClassName($h, $cls, 256)
    $txt = New-Object System.Text.StringBuilder 512
    [void][Jaris.Marks]::GetWindowText($h, $txt, 512)
    $r = New-Object Jaris.Marks+RECT
    [void][Jaris.Marks]::GetWindowRect($h, [ref]$r)
    $ok = ($p -ne $jarisPid) -and ($cloaked -eq 0) -and (($ex -band 0xA0) -eq 0) -and ($txt.Length -gt 0) -and
      (($r.Right - $r.Left) -ge 300) -and (($r.Bottom - $r.Top) -ge 200) -and
      (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -notcontains $cls.ToString()) -and
      ($exclude -notcontains ([string]$h.ToInt64()))
    if ($ok) { $win = $h; $title = $txt.ToString(); $rect = $r; break }
  }
  $h = [Jaris.Marks]::GetWindow($h, 2)
}

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$out = New-Object System.Collections.ArrayList
if ($win -ne [IntPtr]::Zero) {
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
  try {
    $root = $auto::FromHandle($win)
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    # Chromium (Chrome, Edge, Discord, Electron…) ne construit son arbre d'accessibilité qu'au PREMIER client qui le
    # demande : la 1re lecture peut revenir presque vide. On redemande une fois, après lui avoir laissé le temps.
    if ($found.Count -lt 5) {
      Start-Sleep -Milliseconds 1500
      $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    }
    foreach ($element in $found) {
      if ($out.Count -ge ${MAX_READ}) { break }
      try {
        $name = $element.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $er = $element.Current.BoundingRectangle
        if ($er.IsEmpty -or $er.Width -le 0 -or $er.Height -le 0) { continue }
        # Un bouton qui dépasse de SA fenêtre (liste défilée, menu replié) n'est pas entièrement visible.
        if ($er.Left -lt $rect.Left -or $er.Top -lt $rect.Top -or $er.Right -gt $rect.Right -or $er.Bottom -gt $rect.Bottom) { continue }
        [void]$out.Add([pscustomobject]@{
          name = $name.Trim()
          type = ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '')
          x = [int]($er.X - $b.X); y = [int]($er.Y - $b.Y); w = [int]$er.Width; h = [int]$er.Height
          rid = ($element.GetRuntimeId() -join '.')
        })
      } catch { continue }
    }
  } catch { }
}

# Capture APRÈS la lecture des éléments : le délai de relecture de Chromium ne la rend pas plus ancienne qu'eux.
# Étape 263 : en arrière-plan, la fenêtre SEULE, même cachée par d'autres (PrintWindow, PW_RENDERFULLCONTENT pour
# Chromium et les applis modernes) ; si Windows refuse, l'écran entier comme avant, et Jaris le saura (capture).
$mode = 'screen'
$rw = $rect.Right - $rect.Left
$rh = $rect.Bottom - $rect.Top
$bmp = $null
if ($env:JARIS_CAPTURE -eq 'window' -and $win -ne [IntPtr]::Zero -and $rw -gt 0 -and $rh -gt 0) {
  $bmp = New-Object System.Drawing.Bitmap $rw, $rh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $printed = [Jaris.Marks]::PrintWindow($win, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  if ($printed) { $mode = 'window' } else { $bmp.Dispose(); $bmp = $null }
}
if ($bmp -eq $null) {
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
}
$bmp.Save($env:JARIS_MARKS_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$hwndText = ''
$rootText = ''
if ($win -ne [IntPtr]::Zero) {
  $hwndText = [string]$win.ToInt64()
  # La fenêtre principale dont dépend la fenêtre capturée (elle-même si ce n'est pas une boîte de dialogue).
  $root = [Jaris.Marks]::GetAncestor($win, 3)
  if ($root -eq [IntPtr]::Zero) { $root = $win }
  $rootText = [string]$root.ToInt64()
}
Write-Output (@{
  width = $b.Width; height = $b.Height; window = $title; elements = @($out); hwnd = $hwndText; capture = $mode
  root = $rootText; target = $requested
  rect = @{ x = [int]($rect.Left - $b.X); y = [int]($rect.Top - $b.Y); w = [int]$rw; h = [int]$rh }
} | ConvertTo-Json -Compress -Depth 4)
`

function isElement(value: unknown): value is ScreenElement {
  const e = value as Partial<ScreenElement> | null
  return (
    !!e &&
    typeof e.name === 'string' &&
    e.name.trim() !== '' &&
    typeof e.type === 'string' &&
    [e.x, e.y, e.w, e.h].every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * Lit la sortie du script. `ConvertTo-Json` de PowerShell 5.1 n'a pas `-AsArray` : une liste d'UN élément ressort en
 * objet et non en tableau (piège de l'étape 32) — sans ce garde, une fenêtre avec un seul bouton perdrait ce bouton.
 */
export function parseMarksCaptureOutput(stdout: string): MarksCaptureOutput | null {
  let data: { width?: unknown; height?: unknown; window?: unknown; elements?: unknown; hwnd?: unknown; rect?: unknown; capture?: unknown; root?: unknown; target?: unknown }
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!data || typeof data.width !== 'number' || typeof data.height !== 'number' || data.width <= 0 || data.height <= 0) return null
  const list = Array.isArray(data.elements) ? data.elements : data.elements ? [data.elements] : []
  const window = typeof data.window === 'string' && data.window.trim() ? data.window.trim() : undefined
  const elements = list.filter(isElement).map((e) => {
    const rid = (e as { rid?: unknown }).rid
    return typeof rid === 'string' && /^-?\d+(\.-?\d+)*$/.test(rid) ? e : { name: e.name, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h }
  })
  const out: MarksCaptureOutput = { width: data.width, height: data.height, window, elements }
  // Étape 263 : fenêtre visée, son rectangle, et ce que montre l'image. Un champ absent ou abîmé = comme avant.
  const handle = (value: unknown): string | undefined => {
    const text = typeof value === 'number' ? String(value) : value
    return typeof text === 'string' && /^[1-9]\d*$/.test(text) ? text : undefined
  }
  out.hwnd = handle(data.hwnd)
  if (!out.hwnd) delete out.hwnd
  const root = handle(data.root)
  if (root && out.hwnd) out.root = root
  const target = handle(data.target)
  if (target) out.target = target
  const r = data.rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null | undefined
  if (r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && (r.w as number) > 0 && (r.h as number) > 0) {
    out.rect = { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number }
  }
  if (data.capture === 'window' && out.hwnd && out.rect) out.capture = 'window'
  else if (data.capture === 'screen') out.capture = 'screen'
  return out
}

/** Étape 263 : déplace des éléments (repère de l'écran <-> repère de l'image de la fenêtre). */
export function offsetElements<T extends ScreenElement>(elements: T[], dx: number, dy: number): T[] {
  return elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }))
}

/** Part de recouvrement de deux rectangles (intersection / union). */
function overlap(a: ScreenElement, b: ScreenElement): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/**
 * Les éléments numérotés : entièrement sur l'écran, assez grands, et un seul numéro par zone — une ligne de liste et
 * le lien qu'elle contient occupent souvent le même rectangle, deux numéros superposés y seraient illisibles et
 * cliquer l'un ou l'autre revient au même. Le premier dans l'ordre de Windows (le conteneur) est gardé.
 */
export function selectMarks(elements: ScreenElement[], width: number, height: number, max: number = MAX_MARKS): ScreenMark[] {
  const kept: ScreenMark[] = []
  for (const element of elements) {
    if (kept.length >= max) break
    const e = { ...element, x: Math.round(element.x), y: Math.round(element.y), w: Math.round(element.w), h: Math.round(element.h) }
    if (e.w < MIN_SIDE || e.h < MIN_SIDE) continue
    if (e.x < 0 || e.y < 0 || e.x + e.w > width || e.y + e.h > height) continue
    if (kept.some((k) => overlap(k, e) > 0.85)) continue
    const name = e.name.replace(/\s+/g, ' ').trim().slice(0, 80)
    kept.push({ ...e, name, id: kept.length + 1 })
  }
  return kept
}

/** Le point cliqué pour un élément numéroté : le centre du rectangle donné par Windows. */
export function markCenter(mark: ScreenElement): { x: number; y: number } {
  return { x: Math.round(mark.x + mark.w / 2), y: Math.round(mark.y + mark.h / 2) }
}

/** Chiffres 3 x 5 (une chaîne par ligne) : aucune police à charger, rien à installer. */
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
}

/** Couleurs franches qui tranchent sur la plupart des pages ; deux voisins n'ont pas la même. [R, V, B] */
export const MARK_COLORS: Array<[number, number, number]> = [
  [230, 0, 150],
  [255, 110, 0],
  [0, 120, 255],
  [0, 160, 60],
  [150, 0, 230],
  [210, 20, 20]
]

/** Taille d'un pixel de chiffre : 3 donne des chiffres de 9 x 15 px, lisibles sur l'image de 1280 px envoyée. */
const DIGIT_SCALE = 3
const LABEL_PAD = 2
const OUTLINE = 2

/** Taille de l'étiquette d'un numéro, en pixels de l'image. */
export function labelSize(id: number): { w: number; h: number } {
  const n = String(id).length
  return { w: n * 3 * DIGIT_SCALE + (n - 1) * DIGIT_SCALE + 2 * LABEL_PAD, h: 5 * DIGIT_SCALE + 2 * LABEL_PAD }
}

/**
 * Dessine les rectangles et leurs numéros dans une image brute de 4 octets par pixel (celle de NativeImage.toBitmap :
 * B, V, R, A sous Windows). Renvoie une copie : l'image propre reste intacte pour le viseur (MAI-UI), qui ne doit pas
 * voir de numéros. `marks` est en pixels de CETTE image. Le numéro se pose juste au-dessus du coin haut gauche, pour
 * ne pas cacher le texte du bouton ; à l'intérieur s'il n'y a pas la place au-dessus.
 */
export function drawMarks(bitmap: Buffer, width: number, height: number, marks: ScreenMark[]): Buffer {
  const out = Buffer.from(bitmap)
  const put = (x: number, y: number, [r, g, b]: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    out[i] = b
    out[i + 1] = g
    out[i + 2] = r
    out[i + 3] = 255
  }
  const fill = (x: number, y: number, w: number, h: number, color: [number, number, number]): void => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, color)
  }
  for (const mark of marks) {
    const color = MARK_COLORS[(mark.id - 1) % MARK_COLORS.length]
    const x = Math.round(mark.x)
    const y = Math.round(mark.y)
    const w = Math.max(1, Math.round(mark.w))
    const h = Math.max(1, Math.round(mark.h))
    fill(x, y, w, OUTLINE, color)
    fill(x, y + h - OUTLINE, w, OUTLINE, color)
    fill(x, y, OUTLINE, h, color)
    fill(x + w - OUTLINE, y, OUTLINE, h, color)
    const label = labelSize(mark.id)
    const lx = Math.min(Math.max(0, x), Math.max(0, width - label.w))
    const ly = y >= label.h ? y - label.h : Math.min(y, Math.max(0, height - label.h))
    fill(lx, ly, label.w, label.h, color)
    String(mark.id)
      .split('')
      .forEach((digit, index) => {
        const ox = lx + LABEL_PAD + index * 4 * DIGIT_SCALE
        DIGITS[digit].forEach((row, ry) => {
          for (let rx = 0; rx < 3; rx++) if (row[rx] === '1') fill(ox + rx * DIGIT_SCALE, ly + LABEL_PAD + ry * DIGIT_SCALE, DIGIT_SCALE, DIGIT_SCALE, [255, 255, 255])
        })
      })
  }
  return out
}

/** Les éléments retenus, ramenés de l'écran (pixels réels) à l'image envoyée aux modèles (`scale` = écran / image). */
export function scaleMarks(marks: ScreenMark[], scale: number): ScreenMark[] {
  return marks.map((m) => ({ ...m, x: m.x / scale, y: m.y / scale, w: m.w / scale, h: m.h / scale }))
}
