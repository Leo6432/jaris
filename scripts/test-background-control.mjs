import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 263 — pilotage en arrière-plan : scripts Windows (backgroundControl.ts, capture de screenMarks.ts) et lecture
 * de leurs réponses. La lecture est testée ici sans Windows ; les scripts, eux, sont au moins passés au VRAI parseur de
 * PowerShell quand il est présent (CI Windows, ou PWSH_PATH) — une faute de syntaxe ne se verrait sinon que chez Léo.
 */
function load(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${code}\n})`)(module.exports, () => ({}), module)
  return module.exports
}
const bg = load('../electron/services/backgroundControl.ts')
const marks = load('../electron/services/screenMarks.ts')

test('réponse d’action : seul un « ok » explicite compte ; illisible = échec, jamais une action réussie', () => {
  assert.deepEqual({ ...bg.parseActionOutput('{"ok":true,"how":"invoke"}') }, { ok: true, how: 'invoke' })
  assert.deepEqual({ ...bg.parseActionOutput('{"ok":false,"reason":" élément introuvable dans la fenêtre "}') }, { ok: false, reason: 'élément introuvable dans la fenêtre' })
  for (const bad of ['', 'Exception: accès refusé', '{"ok":"true"}', 'null', '{"how":"invoke"}']) assert.equal(bg.parseActionOutput(bad).ok, false, bad)
})

test('premier plan : la fenêtre d’avant n’est rendue que si Windows a donné une vraie poignée', () => {
  assert.deepEqual({ ...bg.parseFocusOutput('{"ok":true,"previous":"65810"}') }, { ok: true, previous: '65810' })
  assert.deepEqual({ ...bg.parseFocusOutput('{"ok":true,"previous":"0"}') }, { ok: true, previous: undefined })
  assert.equal(bg.parseFocusOutput('{"ok":false,"previous":"12; rm"}').previous, undefined)
  assert.equal(bg.parseFocusOutput('pas du JSON').ok, false)
})

test('liste des fenêtres : une seule fenêtre (PowerShell 5.1 sans tableau) n’est pas perdue', () => {
  assert.deepEqual([...bg.parseWindowList('{"hwnds":"65810"}')], ['65810'])
  assert.deepEqual([...bg.parseWindowList('{"hwnds":["1","2","x","0"]}')], ['1', '2'])
  assert.deepEqual([...bg.parseWindowList('{"hwnds":null}')], [])
  assert.deepEqual([...bg.parseWindowList('???')], [])
})

test('capture : poignée, rectangle, mode et identifiants lus ; tout champ abîmé est ignoré, comme avant l’étape 263', () => {
  const out = marks.parseMarksCaptureOutput(JSON.stringify({
    width: 1920, height: 1080, window: 'Calculatrice', hwnd: '65810', capture: 'window', rect: { x: 300, y: 200, w: 400, h: 600 },
    elements: [{ name: 'Sept', type: 'Button', x: 310, y: 500, w: 60, h: 40, rid: '42.1234.4' }, { name: 'Huit', type: 'Button', x: 380, y: 500, w: 60, h: 40, rid: 'x; y' }]
  }))
  assert.equal(out.hwnd, '65810')
  assert.equal(out.capture, 'window')
  assert.deepEqual({ ...out.rect }, { x: 300, y: 200, w: 400, h: 600 })
  assert.equal(out.elements[0].rid, '42.1234.4')
  assert.equal(out.elements[1].rid, undefined, 'identifiant abîmé retiré')
  // Ancienne forme (sans les champs de l'étape 263) : lue comme avant, pas de mode fenêtre.
  const old = marks.parseMarksCaptureOutput('{"width":1280,"height":720,"window":"x","elements":[]}')
  assert.equal(old.hwnd, undefined)
  assert.equal(old.capture, undefined)
  // « window » sans poignée ni rectangle n'est pas une capture de fenêtre exploitable.
  assert.equal(marks.parseMarksCaptureOutput('{"width":1,"height":1,"elements":[],"capture":"window","hwnd":""}').capture, undefined)
  assert.equal(marks.parseMarksCaptureOutput('{"width":1,"height":1,"elements":[],"hwnd":"0"}').hwnd, undefined)
  // Boîte de dialogue : capturée (hwnd), sa fenêtre principale (root), et la fenêtre gardée encore vivante (target).
  const dialog = marks.parseMarksCaptureOutput('{"width":1,"height":1,"elements":[],"hwnd":"777","root":"100","target":"100"}')
  assert.deepEqual([dialog.hwnd, dialog.root, dialog.target], ['777', '100', '100'])
  // Fenêtre gardée disparue : « target » vide, Jaris le voit.
  assert.equal(marks.parseMarksCaptureOutput('{"width":1,"height":1,"elements":[],"hwnd":"555","root":"555","target":""}').target, undefined)
})

test('repère de la fenêtre : un élément ramené dans l’image puis rendu à l’écran retrouve sa place', () => {
  const screen = [{ name: 'Sept', type: 'Button', x: 310, y: 500, w: 60, h: 40, rid: '1' }]
  const local = marks.offsetElements(screen, -300, -200)
  assert.deepEqual({ ...local[0] }, { name: 'Sept', type: 'Button', x: 10, y: 300, w: 60, h: 40, rid: '1' })
  assert.deepEqual({ ...marks.offsetElements(local, 300, 200)[0] }, { ...screen[0] })
})

test('aucune donnée d’un modèle n’entre dans un script : demande par l’entrée standard, poignées par variable', () => {
  for (const script of [bg.BACKGROUND_ACTION_SCRIPT, bg.FOCUS_WINDOW_SCRIPT, bg.LIST_WINDOWS_SCRIPT, marks.MARKS_CAPTURE_SCRIPT]) {
    assert.ok(!/\$\{/.test(script), 'aucune interpolation restante')
  }
  assert.match(bg.BACKGROUND_ACTION_SCRIPT, /\[Console\]::In\.ReadToEnd\(\) \| ConvertFrom-Json/)
  assert.match(bg.BACKGROUND_ACTION_SCRIPT, /\[Console\]::InputEncoding = \[System\.Text\.Encoding\]::UTF8/)
  // Le texte n'est jamais évalué : il n'est que passé à SetValue.
  assert.match(bg.BACKGROUND_ACTION_SCRIPT, /\$pattern\.SetValue\(\[string\]\$req\.text\)/)
  assert.ok(!/Invoke-Expression|iex /.test(bg.BACKGROUND_ACTION_SCRIPT))
  // Premier plan sans simuler de touche (Alt ouvrirait le menu de certaines applis).
  assert.ok(!/keybd_event|SendInput/.test(bg.FOCUS_WINDOW_SCRIPT))
  assert.match(bg.FOCUS_WINDOW_SCRIPT, /AttachThreadInput/)
  const runner = readFileSync(new URL('../electron/services/backgroundControl.ts', import.meta.url), 'utf8')
  assert.match(runner, /stdin: JSON\.stringify\(request\)/)
  assert.match(runner, /env: \{ JARIS_HWND: hwnd \}/)
})

test('les éléments cliquables de l’action sont exactement ceux de la capture (le numéro vu désigne l’un d’eux)', () => {
  const types = (script) => [...script.matchAll(/ControlType\]::(\w+)/g)].map((m) => m[1]).sort()
  assert.deepEqual(types(bg.BACKGROUND_ACTION_SCRIPT), types(marks.MARKS_CAPTURE_SCRIPT))
  assert.ok([...bg.FIELD_TYPES].every((t) => types(marks.MARKS_CAPTURE_SCRIPT).includes(t)))
})

// Le parseur de PowerShell : `powershell` (Windows, CI), `pwsh`, ou PWSH_PATH.
function findPowerShell() {
  for (const candidate of [process.env.PWSH_PATH, 'powershell', 'pwsh'].filter(Boolean)) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' })
      return candidate
    } catch {
      // essai suivant
    }
  }
  return null
}
const shell = findPowerShell()

test('les 4 scripts sont du PowerShell valide (parseur officiel)', { skip: shell ? false : 'PowerShell absent ici (vérifié par la CI Windows)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-ps-'))
  try {
    const scripts = { action: bg.BACKGROUND_ACTION_SCRIPT, focus: bg.FOCUS_WINDOW_SCRIPT, list: bg.LIST_WINDOWS_SCRIPT, capture: marks.MARKS_CAPTURE_SCRIPT }
    for (const [name, script] of Object.entries(scripts)) {
      const file = join(dir, `${name}.ps1`)
      writeFileSync(file, script, 'utf8')
      const report = execFileSync(shell, ['-NoProfile', '-Command',
        `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } } else { 'OK' }`
      ], { encoding: 'utf8' }).trim()
      assert.equal(report, 'OK', `${name} : ${report}`)
    }
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})
