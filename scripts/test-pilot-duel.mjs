import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 249 : duel des pilotes d'écran (UI-TARS contre MAI-UI 8B) sur le vrai écran de Léo, sans aucun clic. La
 * vérité vient de Windows (positions des boutons) ; ce test vérifie que le duel compte juste — y compris le zoom,
 * où une erreur de conversion de repère ferait gagner ou perdre un modèle à tort sans que rien ne le signale.
 */
const nodeRequire = createRequire(import.meta.url)
function load(path, modules = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, (name) => modules[name] ?? nodeRequire(name), module)
  return module.exports
}
const uiTars = load('electron/services/uiTars.ts')
const duel = load('electron/services/pilotDuel.ts', { './uiTars': uiTars })
const captureModule = load('electron/services/pilotDuelCapture.ts', { './pilotDuel': duel })
const { pickTargets, instructionFor, parseMaiUiPoint, parseUiTarsPoint, zoomRect, hits, runDuel, formatDuelReport } = duel

const el = (name, x, y, w = 40, h = 20, type = 'Button') => ({ name, type, x, y, w, h })

test('les cibles : nommées, sans homonyme, ni minuscules ni immenses, dans l’écran', () => {
  const capture = {
    png: 'c.png',
    width: 1920,
    height: 1080,
    elements: [
      el('Rechercher', 100, 100),
      el('Fermer', 1880, 5),
      el('Fermer', 10, 500), // homonyme : ambigu, écarté (les deux)
      el('x', 10, 10), // nom trop court
      el('Minuscule', 10, 10, 4, 4),
      el('Immense', 0, 0, 1900, 1000),
      el('Dehors', 1900, 1070, 40, 20),
      el('Démarrer', 900, 1040, 48, 40)
    ]
  }
  assert.deepEqual(pickTargets(capture).map((e) => e.name), ['Rechercher', 'Démarrer'])
  const many = { png: 'c.png', width: 1920, height: 1080, elements: Array.from({ length: 30 }, (_, i) => el(`Bouton ${i}`, i * 50, 100)) }
  const picked = pickTargets(many, 10).map((e) => e.name)
  assert.equal(picked.length, 10)
  assert.equal(picked[0], 'Bouton 0')
  assert.ok(picked.includes('Bouton 27'), 'réparties sur toute la liste, pas seulement les 10 premières')
  assert.deepEqual(pickTargets(many, 10), pickTargets(many, 10), 'même écran, même duel')
})

test('la même consigne pour les deux pilotes', () => {
  assert.equal(instructionFor(el('Rechercher', 0, 0, 40, 20, 'Edit')), 'Click on the "Rechercher" text field')
  assert.equal(instructionFor(el('Firefox - 2 fenêtres', 0, 0)), 'Click on the "Firefox - 2 fenêtres" button')
  assert.equal(instructionFor(el('Le "vrai" lien', 0, 0, 40, 20, 'Hyperlink')), `Click on the "Le 'vrai' lien" link`)
  assert.equal(instructionFor(el('Inconnu', 0, 0, 40, 20, 'Pane')), 'Click on the "Inconnu" element')
})

test('MAI-UI : coordonnées sur 0–999 (vérifié avec le vrai modèle), dernière réponse retenue', () => {
  const real = '<grounding_think>The search box is the long white input field near the top.\n</grounding_think>\n<answer>\n{"coordinate":[267,130]}\n</answer>'
  const p = parseMaiUiPoint(real)
  assert.ok(Math.abs(p.fx - 267 / 999) < 1e-9 && Math.abs(p.fy - 130 / 999) < 1e-9)
  // Sur 1920x1080 : (513, 140), dans la vraie barre de recherche de la page de test (244..834, 109..147).
  assert.ok(hits({ x: 244, y: 109, w: 590, h: 38 }, p.fx * 1920, p.fy * 1080))
  assert.deepEqual(parseMaiUiPoint('<answer>{"coordinate": [100, 200, 300, 400]}</answer>'), { fx: 200 / 999, fy: 300 / 999 })
  assert.deepEqual(parseMaiUiPoint('think [1,1] <answer>{"coordinate":[999,0]}</answer>'), { fx: 1, fy: 0 })
  assert.equal(parseMaiUiPoint('<answer>{"coordinate":[1200,40]}</answer>'), null, 'hors échelle : illisible, jamais ramené de force')
  assert.equal(parseMaiUiPoint('je ne sais pas'), null)
})

test('UI-TARS : lu exactement comme dans le vrai pilotage (repère smart_resize de l’image envoyée)', () => {
  // Image 1280x720 -> UI-TARS voit 1288x728 : le point (644, 364) de son repère est le centre de l'image.
  const p = parseUiTarsPoint("Thought: je clique sur la barre.\nAction: click(start_box='<|box_start|>(644,364)<|box_end|>')", 1280, 720)
  assert.ok(Math.abs(p.fx - 0.5) < 0.002 && Math.abs(p.fy - 0.5) < 0.002, JSON.stringify(p))
  assert.equal(parseUiTarsPoint("Thought: fini.\nAction: finished(content='ok')", 1280, 720), null)
  assert.equal(parseUiTarsPoint("Action: type(content='bonjour')", 1280, 720), null)
})

test('zoom : la moitié de l’écran autour du 1er point, sans jamais déborder', () => {
  assert.deepEqual(zoomRect(1280, 720, 2560, 1440), { x: 640, y: 360, w: 1280, h: 720 })
  assert.deepEqual(zoomRect(10, 10, 2560, 1440), { x: 0, y: 0, w: 1280, h: 720 })
  assert.deepEqual(zoomRect(2550, 1430, 2560, 1440), { x: 1280, y: 720, w: 1280, h: 720 })
})

/**
 * Faux modèles : l'image « envoyée » porte dans son texte le rectangle d'écran qu'elle montre. Le faux pilote
 * vise le centre de sa cible avec une petite erreur, puis on vérifie que le duel convertit tout sans se tromper.
 */
function fakeWorld(capture, { maiError = [0, 0], tarsError = [0, 0] } = {}) {
  const image = async (_png, rect, maxWidth) => {
    const r = rect ?? { x: 0, y: 0, w: capture.width, h: capture.height }
    const scale = Math.min(1, maxWidth / r.w)
    return { base64: JSON.stringify(r), width: Math.round(r.w * scale), height: Math.round(r.h * scale) }
  }
  const calls = []
  const chat = async (model, messages) => {
    const user = messages.at(-1)
    const name = user.content.match(/Click on the "([^"]+)"/)[1]
    const r = JSON.parse(user.images[0])
    const target = capture.elements.find((e) => e.name === name)
    const zoomed = r.w < capture.width
    calls.push({ model, name, zoomed, system: messages[0].role === 'system' })
    if (model === 'mai') {
      const [ex, ey] = zoomed ? [0, 0] : maiError
      const fx = (target.x + target.w / 2 + ex - r.x) / r.w
      const fy = (target.y + target.h / 2 + ey - r.y) / r.h
      return `<grounding_think>ok</grounding_think><answer>{"coordinate":[${Math.round(fx * 999)},${Math.round(fy * 999)}]}</answer>`
    }
    const scale = Math.min(1, 1280 / r.w)
    const seen = uiTars.smartResize(Math.round(r.w * scale), Math.round(r.h * scale))
    const [ex, ey] = tarsError
    const fx = (target.x + target.w / 2 + ex - r.x) / r.w
    const fy = (target.y + target.h / 2 + ey - r.y) / r.h
    return `Thought: ok\nAction: click(start_box='<|box_start|>(${Math.round(fx * seen.width)},${Math.round(fy * seen.height)})<|box_end|>')`
  }
  return { deps: { image, chat, now: (() => { let t = 0; return () => (t += 1500) })() }, calls }
}

test('duel complet : zoom bien reconverti, consignes officielles, et un pilote qui vise à côté perd vraiment', async () => {
  const capture = {
    png: 'c.png',
    width: 2560,
    height: 1440,
    elements: [el('Rechercher', 400, 150, 600, 40, 'Edit'), el('Fermer', 2500, 10, 46, 30), el('Firefox', 1300, 1392, 44, 44), el('Shorts', 20, 300, 120, 30, 'Hyperlink')]
  }
  // MAI-UI : 1er regard 30 px trop à droite (rate les plus petits boutons), zoom exact. UI-TARS : 70 px à droite partout.
  const { deps, calls } = fakeWorld(capture, { maiError: [30, 0], tarsError: [70, 0] })
  const results = await runDuel(
    [capture],
    [
      { label: 'UI-TARS', model: 'tars', kind: 'ui-tars' },
      { label: 'MAI-UI', model: 'mai', kind: 'mai-ui' }
    ],
    deps
  )
  const [tars, mai] = results
  assert.equal(tars.total, 4)
  assert.equal(tars.hits, 1, 'seul le grand champ de recherche est atteint à 70 px près')
  assert.equal(tars.zoomHits, 1)
  assert.equal(mai.hits, 2, 'à 30 px près : le champ de recherche et le lien Shorts (120 px de large)')
  assert.equal(mai.zoomHits, 4, 'le zoom corrige tout : la conversion recadrage -> écran est juste')
  // Chaque pilote reçoit SA consigne officielle : MAI-UI un message système de visée, UI-TARS celle du vrai pilotage.
  assert.ok(calls.filter((c) => c.model === 'mai').every((c) => c.system))
  assert.ok(calls.filter((c) => c.model === 'tars').every((c) => !c.system))
  // Un pilote entier, puis l'autre : un seul chargement de modèle chacun.
  const order = calls.map((c) => c.model)
  assert.equal(order.lastIndexOf('tars') < order.indexOf('mai'), true)
  // 4 cibles x 2 regards x 2 pilotes, moins UNE : UI-TARS vise 70 px à droite de « Fermer », collé au bord droit — hors
  // de l'image, son tir est illisible, et il n'y a pas de 2e regard sur un point qui n'existe pas.
  assert.equal(calls.length, 15)
  assert.equal(tars.shots.find((s) => s.name === 'Fermer').first, null)
  const report = formatDuelReport(results, [capture], new Date(2026, 9, 6, 18, 0))
  assert.match(report, /\| UI-TARS \| 1\/4 \(25 %\) \| 1\/4 \(25 %\) \|/)
  assert.match(report, /\| MAI-UI \| 2\/4 \(50 %\) \| 4\/4 \(100 %\) \|/)
  assert.match(report, /Aucun clic n'a été fait/)
})

test('un pilote injoignable : noté une fois, sans 20 échecs d’affilée, et l’autre joue quand même', async () => {
  const capture = { png: 'c.png', width: 1920, height: 1080, elements: [el('Un', 10, 10), el('Deux', 100, 10), el('Trois', 200, 10)] }
  const { deps } = fakeWorld(capture)
  const chat = deps.chat
  let failing = 0
  deps.chat = async (model, messages) => {
    if (model === 'tars') {
      failing++
      throw new Error('Ollama a répondu 404 : modèle introuvable')
    }
    return chat(model, messages)
  }
  const [tars, mai] = await runDuel([capture], [{ label: 'UI-TARS', model: 'tars', kind: 'ui-tars' }, { label: 'MAI-UI', model: 'mai', kind: 'mai-ui' }], deps)
  assert.equal(failing, 1)
  assert.match(tars.error, /404/)
  assert.equal(mai.hits, 3)
  assert.match(formatDuelReport([tars, mai], [capture], new Date()), /\| UI-TARS \| impossible : Ollama a répondu 404/)
})

test('capture Windows : un seul processus sensible au DPI, rien d’interpolé, et un écran à un seul bouton gardé', () => {
  const script = captureModule.CAPTURE_SCRIPT
  assert.ok(script.indexOf('SetProcessDPIAware()') < script.indexOf('PrimaryScreen.Bounds'), 'DPI déclaré AVANT de lire la taille de l’écran')
  assert.ok(script.indexOf('CopyFromScreen') < script.indexOf('BoundingRectangle'), 'capture et positions dans le même processus')
  assert.match(script, /\$env:JARIS_DUEL_PNG/)
  assert.ok(!/\$\{/.test(script), 'aucune valeur interpolée dans le script')
  const one = captureModule.parseCaptureOutput('{"width":2560,"height":1440,"elements":{"name":"Démarrer","type":"Button","x":1,"y":2,"w":3,"h":4}}', 'c.png')
  assert.equal(one.elements.length, 1)
  assert.equal(one.elements[0].name, 'Démarrer')
  assert.equal(captureModule.parseCaptureOutput('pas du json', 'c.png'), null)
  assert.equal(captureModule.parseCaptureOutput('{"width":0,"height":1440,"elements":[]}', 'c.png'), null)
})

test('le script de capture est du PowerShell valide (vérifié sur la CI Windows)', { skip: process.platform === 'win32' ? false : 'PowerShell seulement sur Windows (vérifié par la CI)' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const check = `$e = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:JARIS_PS, [ref]$null, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, JARIS_PS: captureModule.CAPTURE_SCRIPT }, stdio: 'pipe' })
})

test('la capture tourne vraiment sous Windows : image écrite, taille de l’écran, liste lisible (CI Windows)', { skip: process.platform === 'win32' ? false : 'Windows seulement (vérifié par la CI)' }, async () => {
  const { mkdtempSync, existsSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const png = join(mkdtempSync(join(tmpdir(), 'jaris-duel-')), 'capture-1.png')
  const capture = await captureModule.captureScreenWithElements(png)
  assert.ok(capture.width > 0 && capture.height > 0, JSON.stringify(capture).slice(0, 300))
  assert.ok(existsSync(png) && statSync(png).size > 1000, 'la capture PNG doit exister')
  assert.ok(Array.isArray(capture.elements))
  for (const e of capture.elements) assert.ok(e.w > 0 && e.h > 0 && typeof e.name === 'string')
})
