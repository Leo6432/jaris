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
/** Un signe de vie tous les 50 caractères tapés : moins d'une seconde, même à ~16 ms par caractère (voir POWERSHELL_IDLE_MS). */
export const TYPE_ALIVE_EVERY = 50

export const INPUT_HELPER_CS = `
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

    private const int TYPE_ALIVE_EVERY = ${TYPE_ALIVE_EVERY};
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
        int typed = 0;
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
            // Signe de vie pour Jaris (inputControl.ts), qui surveille l'INACTIVITÉ et non la durée : sous Windows 10/11,
            // Sleep(5) dure souvent ~15,6 ms (résolution de l'horloge), un long texte prend donc bien plus que prévu.
            if (++typed % TYPE_ALIVE_EVERY == 0)
            {
                Console.Out.WriteLine(".");
                Console.Out.Flush();
            }
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

    /** Étape 508 : un raccourci (ctrl+c, alt+tab…) — les modificateurs enfoncés, la touche, puis tout relâché à l'envers. */
    public static void KeyCombo(ushort[] modifiers, ushort vk)
    {
        foreach (ushort m in modifiers) SendKey(m, 0);
        SendKey(vk, 0);
        SendKey(vk, KEYEVENTF_KEYUP);
        for (int i = modifiers.Length - 1; i >= 0; i--) SendKey(modifiers[i], KEYEVENTF_KEYUP);
    }

    private static void SendKey(ushort vk, uint flags)
    {
        // Flèches, Début, Fin, Inser, Suppr : touches « étendues », sinon Windows les prend pour celles du pavé numérique
        // (Verr. Num. activé) et shift+flèche ne sélectionne rien.
        if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E) flags |= 0x0001;
        INPUT k = new INPUT();
        k.type = INPUT_KEYBOARD;
        k.U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new INPUT[] { k }, Marshal.SizeOf(typeof(INPUT)));
    }

    /** Étape 508 : la molette, notches crans (positif = vers le haut), là où se trouve la souris. */
    public static void Wheel(int notches)
    {
        INPUT w = new INPUT();
        w.type = INPUT_MOUSE;
        w.U.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = (uint)(notches * 120), dwFlags = 0x0800, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new INPUT[] { w }, Marshal.SizeOf(typeof(INPUT)));
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
/**
 * Relecture croisée : sans limite, un PowerShell figé (Windows qui ne répond plus, compilation bloquée par un antivirus)
 * laissait l'action en cours — et toute la réponse de Jaris — attendre pour toujours. Surveillé par INACTIVITÉ : sans
 * aucun signe de vie de PowerShell pendant ce temps (compilation de l'aide C# comprise, ~1 à 3 s d'habitude), il est
 * arrêté, avec un vrai message. Un long texte n'est jamais coupé parce qu'il est long : TypeUnicode écrit un signe de
 * vie tous les TYPE_ALIVE_EVERY caractères (une durée totale calculée d'avance était fausse sous Windows 10/11, où
 * chaque pause de 5 ms dure ~15,6 ms).
 */
export const POWERSHELL_IDLE_MS = 30_000

/** Tout l'arbre (Add-Type lance le compilateur C# à côté de PowerShell), comme le moteur de dessin. */
function killTree(proc: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && proc.pid) {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    proc.kill()
  }
}

function runPowerShell(invocation: string, env?: NodeJS.ProcessEnv, idleMs = POWERSHELL_IDLE_MS): Promise<string | null> {
  return runPowerShellScript(`Add-Type -TypeDefinition @'${INPUT_HELPER_CS}'@ -ErrorAction Stop\n${invocation}`, env, idleMs).then((r) => r.error)
}

/**
 * Étape 508 : un script PowerShell quelconque, surveillé par inactivité comme les actions clavier/souris. Les données de
 * l'utilisateur passent TOUJOURS par `env` (relues avec $env:), jamais dans le texte du script. `error` : `null` si le
 * script a réussi ; `stdout` : ce qu'il a écrit.
 */
export function runPowerShellScript(script: string, env?: NodeJS.ProcessEnv, idleMs = POWERSHELL_IDLE_MS): Promise<{ error: string | null; stdout: string }> {
  let stdout = ''
  return new Promise<string | null>((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: env ?? process.env
    })
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // (Re)part de zéro à chaque signe de vie : un « . » de TypeUnicode, un message d'erreur.
    const alive = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        killTree(proc)
        finish(t('input.timeout', { seconds: Math.round(idleMs / 1000) }))
      }, idleMs)
    }
    alive()
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      alive()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      alive()
    })
    proc.on('error', (err) => finish(err.message))
    proc.on('close', (code) => finish(code === 0 ? null : stderr.trim() || `code de sortie ${code}`))
  }).then((error) => ({ error, stdout }))
}

/** Tape du texte à l'endroit où se trouve le focus actuel (champ de texte, barre de recherche...). */
export async function typeText(text: string): Promise<string> {
  if (!text.trim()) return "Aucun texte à taper."
  const error = await runPowerShell('[JarisInput]::TypeUnicode($env:JARIS_TYPE_TEXT)', { ...process.env, JARIS_TYPE_TEXT: text })
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

/**
 * Étape 508 (Léo : « oui tout », pour les outils qui manquaient) : les raccourcis clavier. Modificateurs et touches
 * toujours lus dans des listes fixes : un texte libre ne peut jamais déclencher une touche non prévue.
 */
const MODIFIER_CODES: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  contrôle: 0x11,
  controle: 0x11,
  alt: 0x12,
  shift: 0x10,
  maj: 0x10,
  majuscule: 0x10,
  win: 0x5b,
  windows: 0x5b
}

/**
 * Relecture adverse (étape 508) : les raccourcis permis, et SEULEMENT eux. Bloquer « win+r » ne suffisait pas : la
 * recherche du menu Démarrer (win+s, ctrl+échap), le Gestionnaire des tâches (ctrl+shift+échap), alt+f4 sur le bureau ou
 * win+1…9 mènent aussi à lancer une commande. Copier, coller, annuler, enregistrer, chercher, onglets, changer de
 * fenêtre, sélectionner du texte, afficher le bureau : rien d'autre.
 */
export const ALLOWED_SHORTCUTS = [
  'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+s', 'ctrl+f', 'ctrl+p', 'ctrl+n', 'ctrl+t', 'ctrl+w',
  'ctrl+r', 'ctrl+l', 'ctrl+tab', 'ctrl+début', 'ctrl+fin', 'ctrl+gauche', 'ctrl+droite',
  'ctrl+shift+t', 'ctrl+shift+tab', 'ctrl+shift+gauche', 'ctrl+shift+droite',
  'alt+tab', 'alt+shift+tab', 'alt+gauche', 'alt+droite',
  'shift+tab', 'shift+haut', 'shift+bas', 'shift+gauche', 'shift+droite', 'shift+début', 'shift+fin',
  'win+d'
]

/** Une lettre, un chiffre ou F1…F12, en plus des touches nommées de KEY_CODES. */
function keyCode(name: string): number | undefined {
  if (Object.hasOwn(KEY_CODES, name)) return KEY_CODES[name]
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0)
  const f = name.match(/^f([1-9]|1[0-2])$/)
  if (f) return 0x70 + Number(f[1]) - 1
  return undefined
}

/** Une touche (« entrée ») ou un raccourci (« ctrl+c », « alt + tab », « ctrl+shift+t ») ; `null` si inconnu. */
export function parseKeys(key: string): { modifiers: number[]; vk: number } | null {
  const parsed = parseKeysRaw(key)
  if (!parsed || !parsed.modifiers.length) return parsed
  return ALLOWED_SIGNATURES.has(signature(parsed)) ? parsed : null
}

function signature(parsed: { modifiers: number[]; vk: number }): string {
  return `${[...parsed.modifiers].sort((a, b) => a - b).join('+')}|${parsed.vk}`
}

function parseKeysRaw(key: string): { modifiers: number[]; vk: number } | null {
  const parts = key
    .trim()
    .toLowerCase()
    .split(/\s*\+\s*/)
    .filter(Boolean)
  if (!parts.length) return null
  const last = parts[parts.length - 1]
  const vk = keyCode(last)
  if (vk === undefined) return null
  const modifiers: number[] = []
  for (const part of parts.slice(0, -1)) {
    const code = Object.hasOwn(MODIFIER_CODES, part) ? MODIFIER_CODES[part] : undefined
    if (code === undefined || modifiers.includes(code)) return null
    modifiers.push(code)
  }
  // Une lettre ou un chiffre seuls s'écrivent avec type_text : press_key, ce sont les touches spéciales et les raccourcis.
  if (!modifiers.length && !Object.hasOwn(KEY_CODES, last) && !/^f([1-9]|1[0-2])$/.test(last)) return null
  if (!Number.isInteger(vk) || modifiers.some((m) => !Number.isInteger(m))) return null
  return { modifiers, vk }
}

const ALLOWED_SIGNATURES = new Set(
  ALLOWED_SHORTCUTS.map((combo) => {
    const parsed = parseKeysRaw(combo)
    if (!parsed) throw new Error(`raccourci permis illisible : ${combo}`)
    return signature(parsed)
  })
)

/** Appuie sur une touche spéciale nommée (entrée, tab, échap...) ou un raccourci (ctrl+c, alt+tab...), listes fixes. */
export async function pressKey(key: string): Promise<string> {
  const parsed = parseKeys(key)
  if (!parsed) {
    return `Touche "${key}" inconnue. Touches disponibles : ${Object.keys(KEY_CODES).join(', ')}, F1 à F12 ; raccourcis permis : ${ALLOWED_SHORTCUTS.join(', ')}.`
  }
  const invocation = parsed.modifiers.length
    ? `[JarisInput]::KeyCombo([uint16[]]@(${parsed.modifiers.join(',')}), ${parsed.vk})`
    : `[JarisInput]::KeyPress(${parsed.vk})`
  const error = await runPowerShell(invocation)
  return error ? t('input.keyFailed', { error }) : `Touche "${key}" pressée.`
}

/** Étape 508 : fait défiler (molette) vers le haut ou le bas, de 1 à 20 crans, là où se trouve la souris. */
export async function scrollWheel(direction: string, amount: unknown): Promise<string> {
  const dir = direction.trim().toLowerCase()
  if (dir !== 'up' && dir !== 'down') return `Direction "${direction}" inconnue : up ou down.`
  const n = Math.min(20, Math.max(1, Math.round(Number(amount) || 3)))
  const error = await runPowerShell(`[JarisInput]::Wheel(${dir === 'up' ? n : -n})`)
  return error ? t('input.scrollFailed', { error }) : `Défilé de ${n} cran${n > 1 ? 's' : ''} vers le ${dir === 'up' ? 'haut' : 'bas'}.`
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
