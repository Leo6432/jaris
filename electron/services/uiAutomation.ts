import { spawn } from 'child_process'

/**
 * Étape 32 — clics fiables via l'API d'accessibilité Windows (UI Automation).
 *
 * Le pilotage d'écran (computerUse.ts, étape 34) demandait jusqu'ici au modèle de vision de DEVINER des
 * coordonnées en pixels sur une capture : la moindre erreur de quelques pixels, un défilement, une fenêtre
 * déplacée entre la capture et le clic, et le clic atterrit à côté. UI Automation expose au contraire les
 * VRAIS éléments cliquables de la fenêtre active (nom, type, point de clic exact) — cliquer devient une
 * certitude au lieu d'une estimation.
 *
 * Choix d'implémentation :
 * - PowerShell (`UIAutomationClient`/`UIAutomationTypes`, livrés avec le .NET Framework de Windows) plutôt
 *   qu'un paquet natif npm, exactement pour la même raison que inputControl.ts (étape 15) : rien à
 *   recompiler pour l'ABI d'Electron, rien de plus à embarquer dans l'installeur en un clic (étape 16).
 * - Ce module ne fait QUE lire l'écran : il renvoie les éléments et leurs coordonnées, et c'est
 *   `clickMouse` (inputControl.ts, déjà en place) qui clique. Aucune donnée venant du modèle n'entre donc
 *   jamais dans le script PowerShell — pas de nom d'élément interpolé, donc aucun risque d'injection, et la
 *   recherche par nom (`findElementByName` plus bas) reste du TypeScript pur, testable sans Windows.
 * - Les deux processus PowerShell (celui qui lit les positions, celui qui clique) sont lancés exactement de
 *   la même façon, donc avec la même conscience du DPI : les coordonnées sont dans le même repère de part et
 *   d'autre. C'est aussi pourquoi on ne touche PAS à `SetProcessDPIAware` ici — ça ne changerait la
 *   cohérence dans aucun sens, seulement le repère utilisé des deux côtés.
 * - Toute défaillance (Windows sans arbre d'accessibilité, script en erreur, délai dépassé) renvoie une
 *   liste VIDE plutôt qu'une exception : le pilotage retombe alors sur le clic en pixels d'origine, le repli
 *   explicitement prévu par l'étape 32 pour les interfaces qui n'exposent pas d'arbre complet (jeux, rendus
 *   sur mesure).
 */

/** Un élément réellement cliquable de la fenêtre active, tel que Windows lui-même le décrit. */
export interface ClickableElement {
  name: string
  /** Type de contrôle sans son préfixe (`Button`, `Hyperlink`, `MenuItem`...). */
  type: string
  x: number
  y: number
}

/**
 * Au-delà, la liste sert plus à noyer le modèle qu'à l'aider (et chaque élément coûte des allers-retours
 * avec le processus de la fenêtre inspectée). Coupée côté PowerShell, pas seulement à l'affichage : c'est la
 * lecture des propriétés qui coûte cher, pas le texte envoyé au modèle.
 */
const MAX_ELEMENTS = 60

/**
 * Une fenêtre très fournie (un navigateur avec une grosse page) peut rendre l'inspection longue. Passé ce
 * délai on abandonne la liste pour ce tour et on laisse le clic en pixels prendre le relais — jamais bloquer
 * la boucle de pilotage, qui a déjà son propre budget de 45s par étape pour le modèle de vision.
 */
const LIST_TIMEOUT_MS = 5000

/**
 * Types de contrôles retenus : ceux sur lesquels un humain clique vraiment. Le filtre est appliqué par UI
 * Automation lui-même (condition passée à `FindAll`) et pas après coup dans PowerShell — sur une fenêtre de
 * navigateur, filtrer après coup voudrait dire lire les propriétés de plusieurs milliers d'éléments un par
 * un, chacun étant un aller-retour entre processus.
 */
const UIA_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Sans ça, les noms accentués ("Paramètres", "Rechercher"...) ressortent mal encodés dans le tube de sortie :
# PowerShell 5.1 encode par défaut avec la page de codes OEM, pas en UTF-8.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace Jaris -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'

$hwnd = [Jaris.Fg]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '[]'; exit 0 }

$auto = [System.Windows.Automation.AutomationElement]
$root = $auto::FromHandle($hwnd)

$typeConditions = @(
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
  (New-Object System.Windows.Automation.OrCondition($typeConditions))
)

$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$out = New-Object System.Collections.ArrayList
foreach ($element in $found) {
  if ($out.Count -ge ${MAX_ELEMENTS}) { break }
  try {
    $name = $element.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $point = New-Object System.Windows.Point
    # Un élément sans point de clic (masqué par un autre, hors de la zone visible d'une liste défilante...)
    # n'est de toute façon pas cliquable : l'exclure vaut mieux que renvoyer une position inutilisable.
    if (-not $element.TryGetClickablePoint([ref]$point)) { continue }
    [void]$out.Add([pscustomobject]@{
      name = $name.Trim()
      type = ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '')
      x = [int]$point.X
      y = [int]$point.Y
    })
  } catch {
    continue
  }
}
Write-Output (@($out) | ConvertTo-Json -Compress -Depth 3)
`

function isClickableElement(value: unknown): value is ClickableElement {
  const candidate = value as Partial<ClickableElement> | null
  return (
    !!candidate &&
    typeof candidate.name === 'string' &&
    candidate.name.trim() !== '' &&
    typeof candidate.type === 'string' &&
    typeof candidate.x === 'number' &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === 'number' &&
    Number.isFinite(candidate.y)
  )
}

/**
 * `ConvertTo-Json` de Windows PowerShell 5.1 n'a pas `-AsArray` : un seul élément ressort donc en OBJET, pas
 * en tableau d'un élément. Sans ce garde, une fenêtre avec un unique bouton cliquable renverrait une liste
 * vide au lieu de ce bouton.
 */
export function parseElements(stdout: string): ClickableElement[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter(isClickableElement).slice(0, MAX_ELEMENTS)
}

/**
 * Liste les éléments réellement cliquables de la fenêtre au premier plan. Ne lève JAMAIS : une liste vide
 * signifie "pas d'arbre d'accessibilité exploitable ici", et l'appelant reprend le clic en pixels.
 */
export function listClickableElements(): Promise<ClickableElement[]> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (elements: ClickableElement[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(elements)
    }

    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', UIA_SCRIPT], {
      windowsHide: true
    })
    const timer = setTimeout(() => {
      proc.kill()
      finish([])
    }, LIST_TIMEOUT_MS)

    let stdout = ''
    proc.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    proc.on('error', () => finish([]))
    proc.on('close', (code) => finish(code === 0 ? parseElements(stdout) : []))
  })
}

/**
 * Normalise pour comparer : le modèle reprend rarement le nom au caractère près (casse, accents, espaces en
 * trop). Comparer sur une forme normalisée évite de rater "Rechercher" parce qu'il a écrit "rechercher".
 */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Retrouve l'élément visé par le modèle dans la liste renvoyée par Windows. Volontairement du TypeScript pur
 * (aucun PowerShell) : c'est la seule partie où une donnée venant du modèle est manipulée, donc la seule
 * qu'il fallait pouvoir tester sans Windows — voir scripts/test-ui-automation.mjs.
 *
 * Trois tours de plus en plus permissifs, dans cet ordre, pour préférer toujours la correspondance la plus
 * précise : égalité, puis début du nom, puis nom contenu. Sans cet ordre, un "Fermer" exact pourrait perdre
 * face à un "Fermer l'onglet" simplement placé plus haut dans la liste.
 */
export function findElementByName(elements: ClickableElement[], target: string): ClickableElement | null {
  const wanted = normalize(target)
  if (!wanted) return null
  const named = elements.map((element) => ({ element, name: normalize(element.name) }))
  return (
    named.find((candidate) => candidate.name === wanted)?.element ??
    named.find((candidate) => candidate.name.startsWith(wanted))?.element ??
    named.find((candidate) => candidate.name.includes(wanted))?.element ??
    null
  )
}

/** Rend la liste lisible pour le modèle de vision, en gardant les lignes courtes (budget de contexte). */
export function describeElements(elements: ClickableElement[]): string {
  if (!elements.length) return ''
  return elements.map((element) => `- [${element.type}] ${element.name.slice(0, 80)}`).join('\n')
}
