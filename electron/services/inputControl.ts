import { spawn } from 'child_process'

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

    private const int INPUT_MOUSE = 0;
    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;

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

    public static void KeyCombo(int[] vks)
    {
        foreach (int vk in vks)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero };
            SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
        }
        for (int i = vks.Length - 1; i >= 0; i--)
        {
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.U.ki = new KEYBDINPUT { wVk = (ushort)vks[i], wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };
            SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void Scroll(int x, int y, bool hasPos, int amount, bool horizontal)
    {
        if (hasPos) SetCursorPos(x, y);
        INPUT wheel = new INPUT();
        wheel.type = INPUT_MOUSE;
        wheel.U.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = unchecked((uint)amount), dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new INPUT[] { wheel }, Marshal.SizeOf(typeof(INPUT)));
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
  return error ? `Échec de la saisie du texte : ${error}` : `Texte tapé.`
}

/** Appuie sur une touche spéciale nommée (entrée, tab, échap...), whitelist fixe dans KEY_CODES. */
export async function pressKey(key: string): Promise<string> {
  const vk = KEY_CODES[key.trim().toLowerCase()]
  if (vk === undefined) {
    return `Touche "${key}" inconnue. Touches disponibles : ${Object.keys(KEY_CODES).join(', ')}.`
  }
  const error = await runPowerShell(`[JarisInput]::KeyPress(${vk})`)
  return error ? `Échec de l'appui sur la touche : ${error}` : `Touche "${key}" pressée.`
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
  return error ? `Échec de l'action multimédia : ${error}` : `Action "${action}" effectuée.`
}

/** Clique à une position écran donnée (pixels), ou à la position actuelle du curseur si non précisée. */
export async function clickMouse(x: number | null, y: number | null, button: string): Promise<string> {
  const safeButton = (['left', 'right', 'double'] as const).includes(button as 'left' | 'right' | 'double')
    ? button
    : 'left'
  const hasPos = x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)
  const px = hasPos ? Math.round(x as number) : 0
  const py = hasPos ? Math.round(y as number) : 0

  const error = await runPowerShell(`[JarisInput]::Click(${px}, ${py}, $${hasPos ? 'true' : 'false'}, "${safeButton}")`)
  return error ? `Échec du clic : ${error}` : `Clic ${safeButton} effectué${hasPos ? ` à (${px}, ${py})` : ''}.`
}

/**
 * Combinaisons de touches du pilotage d'écran (étape 231 : UI-TARS écrit par exemple « hotkey(key='ctrl l') »
 * pour aller dans la barre d'adresse). Liste fermée, comme KEY_CODES : modificateurs, lettres, chiffres, F1-F12
 * et touches de navigation — jamais un code de touche arbitraire tiré d'un texte libre.
 */
const HOTKEY_CODES: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, windows: 0x5b, cmd: 0x5b, command: 0x5b, meta: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27
}

/** Noms de touches -> codes Windows, `null` si une seule touche n'est pas dans la liste autorisée. */
export function hotkeyVirtualKeys(keys: string[]): number[] | null {
  const codes: number[] = []
  for (const raw of keys) {
    const key = raw.trim().toLowerCase()
    if (/^[a-z]$/.test(key)) codes.push(key.toUpperCase().charCodeAt(0))
    else if (/^[0-9]$/.test(key)) codes.push(key.charCodeAt(0))
    else if (/^f([1-9]|1[0-2])$/.test(key)) codes.push(0x6f + Number(key.slice(1)))
    else if (HOTKEY_CODES[key] !== undefined) codes.push(HOTKEY_CODES[key])
    else return null
  }
  return codes.length ? codes : null
}

/** Appuie sur une combinaison (« ctrl l ») : toutes les touches enfoncées dans l'ordre, relâchées à l'envers. */
export async function pressHotkey(keys: string[]): Promise<string> {
  const codes = hotkeyVirtualKeys(keys)
  const label = keys.join('+')
  if (!codes) return `Combinaison "${label}" impossible : une des touches n'est pas autorisée.`
  const error = await runPowerShell(`[JarisInput]::KeyCombo([int[]]@(${codes.join(',')}))`)
  return error ? `Échec de la combinaison de touches : ${error}` : `Combinaison "${label}" pressée.`
}

/** Fait défiler (molette) de 5 crans, à une position écran donnée ou là où se trouve la souris. */
export async function scrollMouse(x: number | null, y: number | null, direction: 'up' | 'down' | 'left' | 'right'): Promise<string> {
  const hasPos = x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)
  const px = hasPos ? Math.round(x as number) : 0
  const py = hasPos ? Math.round(y as number) : 0
  // Molette verticale : positif = vers le haut. Horizontale : positif = vers la droite. 120 = un cran.
  const amount = (direction === 'up' || direction === 'right' ? 1 : -1) * 5 * 120
  const horizontal = direction === 'left' || direction === 'right'
  const error = await runPowerShell(`[JarisInput]::Scroll(${px}, ${py}, $${hasPos ? 'true' : 'false'}, ${amount}, $${horizontal ? 'true' : 'false'})`)
  return error ? `Échec du défilement : ${error}` : `Défilement ${direction} effectué.`
}
