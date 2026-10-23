import { execFile, spawn } from 'child_process'
import { t } from '../../shared/i18n'

/**
 * Simule des vrais événements clavier/souris bas niveau via l'API Win32 SendInput (P/Invoke depuis un
 * script PowerShell compilé à la volée), plutôt qu'un paquet npm dédié (robotjs, nut.js...) : ces paquets
 * embarquent du code natif qui doit être recompilé pour l'ABI exacte d'Electron, un risque et une
 * complexité en plus pour l'installeur en un clic (étape 16). SendInput (et non l'ancien keybd_event/
 * mouse_event) car c'est l'API recommandée par Microsoft, avec le mode KEYEVENTF_UNICODE qui tape
 * n'importe quel caractère (accents compris) sans avoir à connaître la disposition clavier de l'utilisateur.
 */
const INPUT_HELPER_CS = `
using System;
using System.Runtime.InteropServices;

public static class JarisInput
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    public static void DpiAware()
    {
        SetProcessDPIAware();
    }

    private const int INPUT_MOUSE = 0;
    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public InputUnion U;
    }

    public static void TypeUnicode(string text)
    {
        foreach (char c in text)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero };
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };
            SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
            SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
            System.Threading.Thread.Sleep(5);
        }
    }

    public static void KeyPress(ushort vk)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero };
        INPUT up = new INPUT();
        up.type = INPUT_KEYBOARD;
        up.U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
        SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Click(int x, int y, bool hasPos, string button)
    {
        if (hasPos) SetCursorPos(x, y);
        uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        int clicks = button == "double" ? 2 : 1;
        for (int i = 0; i < clicks; i++)
        {
            INPUT mDown = new INPUT();
            mDown.type = INPUT_MOUSE;
            mDown.U.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = 0, dwFlags = down, time = 0, dwExtraInfo = IntPtr.Zero };
            INPUT mUp = new INPUT();
            mUp.type = INPUT_MOUSE;
            mUp.U.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = 0, dwFlags = up, time = 0, dwExtraInfo = IntPtr.Zero };
            SendInput(1, new INPUT[] { mDown }, Marshal.SizeOf(typeof(INPUT)));
            SendInput(1, new INPUT[] { mUp }, Marshal.SizeOf(typeof(INPUT)));
            if (clicks == 2 && i == 0) System.Threading.Thread.Sleep(50);
        }
    }
}
`

/**
 * Touches spéciales nommées en français par l'utilisateur -> code de touche virtuelle Windows (VK_*).
 * Liste volontairement restreinte à un jeu fixe : press_key ne doit jamais pouvoir déclencher une touche
 * arbitraire non prévue à partir d'un texte libre.
 */
const KEY_CODES: Record<string, number> = {
  entrée: 0x0d,
  entree: 0x0d,
  enter: 0x0d,
  tab: 0x09,
  tabulation: 0x09,
  échap: 0x1b,
  echap: 0x1b,
  escape: 0x1b,
  espace: 0x20,
  space: 0x20,
  'retour arrière': 0x08,
  'retour arriere': 0x08,
  backspace: 0x08,
  effacer: 0x08,
  suppr: 0x2e,
  supprimer: 0x2e,
  delete: 0x2e,
  haut: 0x26,
  bas: 0x28,
  gauche: 0x25,
  droite: 0x27,
  début: 0x24,
  debut: 0x24,
  home: 0x24,
  fin: 0x23,
  end: 0x23
}

/**
 * Le texte à taper vient du modèle (donc, en amont, de la voix de l'utilisateur) et peut contenir
 * n'importe quel caractère (guillemets, `$`, backticks...) : il ne doit jamais être interpolé dans le
 * script PowerShell lui-même (risque d'injection), il passe par une variable d'environnement que le
 * script relit avec $env:, jamais réinterprétée comme du code.
 */
function runPowerShell(invocation: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const script = `Add-Type -TypeDefinition @'${INPUT_HELPER_CS}'@ -ErrorAction Stop\n${invocation}`
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: env ?? process.env
    })
    let stderr = ''
    proc.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
    proc.on('error', (err) => resolve(err.message))
    proc.on('close', (code) => resolve(code === 0 ? null : stderr.trim() || `code de sortie ${code}`))
  })
}

/** Tape du texte à l'endroit où se trouve le focus actuel (champ de texte, barre de recherche...). */
export async function typeText(text: string): Promise<string> {
  if (!text.trim()) return "Aucun texte à taper."
  const error = await runPowerShell('[JarisInput]::TypeUnicode($env:JARIS_TYPE_TEXT)', {
    ...process.env,
    JARIS_TYPE_TEXT: text
  })
  return error ? t('input.typeFailed', { error }) : `Texte tapé.`
}

/**
 * Titre et programme de la fenêtre au premier plan (étape 346). Aucune donnée de l'utilisateur dans le script.
 */
const FOREGROUND_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "Add-Type -Namespace JarisFg -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'",
  '$h = [JarisFg.W]::GetForegroundWindow()',
  '$sb = New-Object System.Text.StringBuilder 512',
  '[void][JarisFg.W]::GetWindowText($h, $sb, 512)',
  '$procId = 0',
  '[void][JarisFg.W]::GetWindowThreadProcessId($h, [ref]$procId)',
  '$name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName',
  'Write-Output ($sb.ToString() + "`t" + $name)'
].join('; ')

function readForeground(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT], { windowsHide: true, timeout: 4000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim())
    )
  })
}

function comparable(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Vrai si le titre ou le programme de la fenêtre au premier plan évoque l'application (un mot d'au moins 4 lettres). */
export function foregroundMatchesApp(foreground: string, appName: string): boolean {
  const seen = ` ${comparable(foreground)} `
  const words = comparable(appName).split(' ').filter((word) => word.length >= 4)
  const whole = comparable(appName)
  return (whole.length >= 2 && seen.includes(` ${whole} `)) || words.some((word) => seen.includes(` ${word} `) || seen.includes(word))
}

/**
 * Étape 346 (« ouvre un bloc-notes et écris bonjour ») : après une ouverture d'application, le texte ne doit partir
 * que si cette application est bien au premier plan — sinon il serait tapé dans la fenêtre au hasard qui a le focus
 * (Jaris lui-même, le navigateur…). Attend jusqu'à `timeoutMs` qu'elle s'affiche. Hors Windows : rien à vérifier.
 */
export async function waitForForegroundApp(
  appName: string,
  timeoutMs = 6000,
  read: () => Promise<string | null> = readForeground,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<boolean> {
  if (process.platform !== 'win32' && read === readForeground) return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const foreground = await read()
    if (foreground !== null && foregroundMatchesApp(foreground, appName)) return true
    if (Date.now() >= deadline) return false
    await wait(400)
  }
}

/** Appuie sur une touche spéciale nommée (entrée, tab, échap...), whitelist fixe dans KEY_CODES. */
export async function pressKey(key: string): Promise<string> {
  const vk = KEY_CODES[key.trim().toLowerCase()]
  if (vk === undefined) {
    return `Touche "${key}" inconnue. Touches disponibles : ${Object.keys(KEY_CODES).join(', ')}.`
  }
  const error = await runPowerShell(`[JarisInput]::KeyPress(${vk})`)
  return error ? t('input.keyFailed', { error }) : `Touche "${key}" pressée.`
}

/**
 * Actions multimédia nommées -> code de touche virtuelle Windows (VK_*), les mêmes que sur un clavier
 * physique avec touches multimédia. Réutilise le même mécanisme KeyPress que pressKey ci-dessus, jamais de
 * volume en pourcentage exact (pas d'API Windows simple pour ça sans dépendance supplémentaire) : chaque
 * appel est un cran, comme une vraie touche qu'on presse.
 */
const MEDIA_KEY_CODES: Record<string, number> = {
  volume_up: 0xaf,
  volume_down: 0xae,
  mute: 0xad,
  play_pause: 0xb3,
  next: 0xb0,
  previous: 0xb1
}

/** Appuie sur une touche multimédia (volume, lecture/pause, piste suivante/précédente...), whitelist fixe. */
export async function mediaKey(action: string): Promise<string> {
  const vk = MEDIA_KEY_CODES[action.trim().toLowerCase()]
  if (vk === undefined) {
    return `Action multimédia "${action}" inconnue. Actions disponibles : ${Object.keys(MEDIA_KEY_CODES).join(', ')}.`
  }
  const error = await runPowerShell(`[JarisInput]::KeyPress(${vk})`)
  return error ? t('input.mediaFailed', { error }) : `Action "${action}" effectuée.`
}

/**
 * Clique à une position écran donnée (pixels), ou à la position actuelle du curseur si non précisée.
 * `physicalPixels` (étape 256) : la position vient d'une capture sensible au DPI (screenMarks.ts), en pixels RÉELS.
 * Le processus qui clique doit alors l'être aussi, sinon Windows remet la position à l'échelle (×1,25 sur un écran
 * à 125 %) et le clic part à côté. Sans ce drapeau, rien ne change : pixels logiques, comme avant.
 */
export async function clickMouse(x: number | null, y: number | null, button: string, physicalPixels = false): Promise<string> {
  const safeButton = (['left', 'right', 'double'] as const).includes(button as 'left' | 'right' | 'double')
    ? button
    : 'left'
  const hasPos = x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)
  const px = hasPos ? Math.round(x as number) : 0
  const py = hasPos ? Math.round(y as number) : 0

  const dpi = physicalPixels && hasPos ? '[JarisInput]::DpiAware()\n' : ''
  const error = await runPowerShell(`${dpi}[JarisInput]::Click(${px}, ${py}, $${hasPos ? 'true' : 'false'}, "${safeButton}")`)
  return error ? t('input.clickFailed', { error }) : `Clic ${safeButton} effectué${hasPos ? ` à (${px}, ${py})` : ''}.`
}
