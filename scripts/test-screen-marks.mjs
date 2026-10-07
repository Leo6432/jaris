import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Étape 256 : le module est pur (aucun import) — chargé tel quel, dans le realm du test (comparaisons d'objets).
const source = ts.transpileModule(readFileSync(new URL('../electron/services/screenMarks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const marksModule = { exports: {} }
vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(marksModule.exports, () => ({}), marksModule)
const {
  MARKS_CAPTURE_SCRIPT, MARK_COLORS, MAX_MARKS, drawMarks, labelSize, markCenter, parseMarksCaptureOutput, scaleMarks, selectMarks
} = marksModule.exports

const el = (name, x, y, w = 80, h = 30, type = 'Button') => ({ name, type, x, y, w, h })

test('sortie du script : un seul élément (objet, pas tableau, PowerShell 5.1) n’est pas perdu', () => {
  const out = parseMarksCaptureOutput('{"width":1920,"height":1080,"window":" YouTube - Firefox ","elements":{"name":"Rechercher","type":"Edit","x":600,"y":20,"w":500,"h":40}}')
  assert.deepEqual(out, { width: 1920, height: 1080, window: 'YouTube - Firefox', elements: [el('Rechercher', 600, 20, 500, 40, 'Edit')] })
})

test('sortie du script : illisible, sans taille ou sans fenêtre', () => {
  assert.equal(parseMarksCaptureOutput('Exception: accès refusé'), null)
  assert.equal(parseMarksCaptureOutput('{"elements":[]}'), null)
  assert.equal(parseMarksCaptureOutput('null'), null)
  const none = parseMarksCaptureOutput('{"width":1280,"height":720,"window":"","elements":[]}')
  assert.deepEqual(none, { width: 1280, height: 720, window: undefined, elements: [] })
  // Un élément mal formé (nom vide, position manquante) est écarté, les autres restent.
  const mixed = parseMarksCaptureOutput(JSON.stringify({ width: 100, height: 100, elements: [{ name: ' ', type: 'Button', x: 1, y: 1, w: 9, h: 9 }, { name: 'OK', type: 'Button', x: 1 }, el('Fermer', 1, 1, 9, 9)] }))
  assert.deepEqual(mixed.elements.map((e) => e.name), ['Fermer'])
})

test('sélection : numéros 1, 2, 3… dans l’ordre de Windows ; trop petit ou hors de l’écran écarté', () => {
  const marks = selectMarks([
    el('Accueil', 10, 10),
    el('Minuscule', 50, 50, 4, 30),
    el('Hors écran', 1900, 10, 80, 30),
    el('Négatif', -5, 10),
    el('  Rechercher   sur\n YouTube ', 300, 10, 400, 30, 'Edit')
  ], 1920, 1080)
  assert.deepEqual(marks.map((m) => [m.id, m.name]), [[1, 'Accueil'], [2, 'Rechercher sur YouTube']])
})

test('sélection : une ligne de liste et le lien qu’elle contient (même rectangle) n’ont qu’un numéro', () => {
  const marks = selectMarks([
    el('Vidéo : Tuto guitare', 100, 200, 400, 90, 'ListItem'),
    el('Tuto guitare', 102, 201, 398, 88, 'Hyperlink'),
    // Le bouton « J'aime » DANS la ligne ne la recouvre pas : il garde son numéro.
    el("J'aime", 420, 260, 40, 24)
  ], 1920, 1080)
  assert.deepEqual(marks.map((m) => [m.id, m.type]), [[1, 'ListItem'], [2, 'Button']])
})

test('sélection : au plus MAX_MARKS numéros', () => {
  const many = Array.from({ length: 300 }, (_, i) => el(`Lien ${i}`, (i % 20) * 90, Math.floor(i / 20) * 40))
  const marks = selectMarks(many, 1920, 1080)
  assert.equal(marks.length, MAX_MARKS)
  assert.equal(marks.at(-1).id, MAX_MARKS)
})

test('le clic vise le centre du rectangle donné par Windows', () => {
  assert.deepEqual(markCenter(el('Rechercher', 600, 20, 500, 41)), { x: 850, y: 41 })
})

test('rectangles ramenés de l’écran (pixels réels) à l’image envoyée', () => {
  assert.deepEqual(scaleMarks([{ ...el('A', 200, 100, 80, 40), id: 1 }], 2), [{ ...el('A', 100, 50, 40, 20), id: 1 }])
})

/** Une image unie de 4 octets par pixel (B, V, R, A), comme NativeImage.toBitmap sous Windows. */
function blank(width, height, value = 40) {
  const buf = Buffer.alloc(width * height * 4, value)
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255
  return buf
}
const px = (buf, width, x, y) => [buf[(y * width + x) * 4 + 2], buf[(y * width + x) * 4 + 1], buf[(y * width + x) * 4]]

test('dessin : cadre de la couleur du numéro, intérieur intact, numéro blanc au-dessus du coin', () => {
  const [w, h] = [200, 120]
  const image = blank(w, h)
  const out = drawMarks(image, w, h, [{ ...el('Rechercher', 50, 40, 60, 30), id: 7 }])
  const color = MARK_COLORS[6 % MARK_COLORS.length]
  // Les quatre bords du cadre.
  for (const [x, y] of [[50, 40], [109, 40], [50, 69], [109, 69], [80, 41], [51, 55]]) assert.deepEqual(px(out, w, x, y), color, `${x},${y}`)
  // L'intérieur du bouton n'est pas recouvert : le texte reste lisible pour le modèle.
  assert.deepEqual(px(out, w, 80, 55), [40, 40, 40])
  // L'étiquette juste au-dessus : couleur du cadre, avec des pixels blancs (le chiffre 7).
  const label = labelSize(7)
  let white = 0
  for (let y = 40 - label.h; y < 40; y++) for (let x = 50; x < 50 + label.w; x++) if (px(out, w, x, y).every((c) => c === 255)) white++
  assert.ok(white > 20, `${white} pixels blancs`)
  // Copie : l'image propre (pour le viseur) n'est pas modifiée.
  assert.deepEqual(px(image, w, 50, 40), [40, 40, 40])
})

test('dessin : un élément collé au bord haut porte son numéro à l’intérieur, sans sortir de l’image', () => {
  const [w, h] = [100, 60]
  const out = drawMarks(blank(w, h), w, h, [{ ...el('Fichier', 90, 0, 10, 30), id: 12 }])
  const label = labelSize(12)
  assert.ok(label.w > 10)
  // Repoussée à gauche pour tenir dans l'image, posée en haut.
  let white = 0
  for (let y = 0; y < label.h; y++) for (let x = w - label.w; x < w; x++) if (px(out, w, x, y).every((c) => c === 255)) white++
  assert.ok(white > 20)
})

test('dessin : les numéros 1 à 10 sont tous différents (police de chiffres)', () => {
  const seen = new Set()
  for (let id = 1; id <= 10; id++) {
    const [w, h] = [60, 40]
    const out = drawMarks(blank(w, h, 0), w, h, [{ ...el('x', 5, 25, 20, 10), id }])
    const label = labelSize(id)
    let bits = ''
    for (let y = 25 - label.h; y < 25; y++) for (let x = 5; x < 5 + label.w; x++) bits += px(out, w, x, y).every((c) => c === 255) ? '1' : '0'
    seen.add(bits)
  }
  assert.equal(seen.size, 10)
})

test('script : sensible au DPI AVANT de lire les positions et de capturer, Jaris écarté, rien du modèle dedans', () => {
  const dpi = MARKS_CAPTURE_SCRIPT.indexOf('[Jaris.Marks]::SetProcessDPIAware()')
  assert.ok(dpi > 0)
  assert.ok(dpi < MARKS_CAPTURE_SCRIPT.indexOf('FindAll(') && dpi < MARKS_CAPTURE_SCRIPT.indexOf('CopyFromScreen'))
  // La fenêtre visée n'est plus « la fenêtre active » (Jaris lui-même quand Léo lui parle depuis sa fenêtre).
  assert.ok(!MARKS_CAPTURE_SCRIPT.includes('GetForegroundWindow'))
  assert.match(MARKS_CAPTURE_SCRIPT, /\(\$p -ne \$jarisPid\)/)
  assert.match(MARKS_CAPTURE_SCRIPT, /\$jarisPid = \[uint32\]\$env:JARIS_PID/)
  assert.match(MARKS_CAPTURE_SCRIPT, /\$bmp\.Save\(\$env:JARIS_MARKS_PNG,/)
  // Relecture pour Chromium (arbre construit à la première demande).
  assert.match(MARKS_CAPTURE_SCRIPT, /if \(\$found\.Count -lt 5\) \{\s+Start-Sleep -Milliseconds 1500/)
  // Aucune interpolation restée dans le script (seule la limite de lecture est remplacée, par un nombre).
  assert.ok(!MARKS_CAPTURE_SCRIPT.includes('${'))
  assert.match(MARKS_CAPTURE_SCRIPT, /if \(\$out\.Count -ge \d+\) \{ break \}/)
})
