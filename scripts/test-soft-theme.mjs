import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

/**
 * Étape 144, Léo : « je veux un design rassurant » — Jaris devient une application grand public (plus de
 * thème science-fiction pour initiés). Ces garde-fous échouent si un motif de l'ancien thème revient par
 * inadvertance (un copier-coller d'une ancienne règle, par exemple), et vérifient l'icône dessinée par code.
 */
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '') // commentaires exclus : ils racontent l'historique

// Étape 146, Léo : « mets le mode dark, pas blanc ». Sombre, mais doux : jamais du noir pur, et du texte
// qui reste lisible (contraste WCAG), y compris le plus discret.
const token = (name) => {
  const m = rules.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i'))
  assert.ok(m, `token --${name} introuvable`)
  return m[1]
}
const luminance = (hex) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('mode sombre : le thème annonce le mode sombre, un fond sombre mais pas noir pur', () => {
  assert.match(rules, /color-scheme:\s*dark/)
  const bg = token('ui-bg')
  assert.ok(luminance(bg) < 0.03, `fond trop clair (#${bg})`)
  assert.notEqual(bg.toLowerCase(), '000000', 'noir pur : trop dur pour les yeux')
})

test('mode sombre : tous les niveaux de texte restent lisibles sur le fond et sur les cartes', () => {
  for (const surface of ['ui-bg', 'ui-panel', 'ui-panel-raised']) {
    assert.ok(contrast(token('ui-text'), token(surface)) >= 7, `texte principal sur ${surface}`)
    assert.ok(contrast(token('ui-text-dim'), token(surface)) >= 4.5, `texte secondaire sur ${surface}`)
    assert.ok(contrast(token('ui-text-faint'), token(surface)) >= 3, `texte discret sur ${surface}`)
  }
})

test('la fenêtre s’ouvre directement sur le fond sombre (pas d’éclair blanc au démarrage)', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, new RegExp(`backgroundColor:\\s*'#${token('ui-bg')}'`, 'i'))
})

test('plus aucun motif « cockpit » : coins coupés, capitales espacées, grille, balayage, néons', () => {
  assert.doesNotMatch(rules, /clip-path:\s*polygon/, 'coins coupés')
  assert.doesNotMatch(rules, /text-transform:\s*uppercase/, 'capitales')
  assert.doesNotMatch(rules, /text-shadow/, 'lueur de texte')
  assert.doesNotMatch(rules, /hud-sweep|hud-ring-spin/, 'animations de l’ancien thème')
  assert.doesNotMatch(rules, /--hud-/, 'anciens tokens')
  assert.doesNotMatch(rules, /Rajdhani|Barlow/, 'anciennes polices')
})

test('une seule police douce, embarquée (Jaris doit marcher hors ligne)', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /@fontsource\/nunito/)
  assert.doesNotMatch(main, /^import .*(rajdhani|barlow)/im)
  assert.match(rules, /--ui-font-body:\s*'Nunito'/)
  assert.match(rules, /button,\s*input,\s*select,\s*textarea\s*\{\s*font-family:\s*inherit/, 'les boutons doivent hériter de la police')
})

test('l’icône de l’application est la mascotte : bulle bleue, deux yeux blancs, coins transparents', async () => {
  const src = readFileSync(new URL('../shared/mascotPixels.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { renderMascotRgba } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  const size = 128
  const px = renderMascotRgba(size)
  const at = (x, y) => Array.from(px.slice((y * size + x) * 4, (y * size + x) * 4 + 4))
  // Même repère que shared/mascotPixels.ts (VIEW) : un point du dessin 120 × 120 -> un pixel de l'icône.
  const view = (vx, vy) => at(Math.round(((vx - 13) / 94) * size), Math.round(((vy - 15) / 94) * size))
  assert.equal(at(0, 0)[3], 0, 'coin haut gauche transparent')
  assert.equal(at(size - 1, size - 1)[3], 0, 'coin bas droit transparent')
  const body = view(55, 85)
  assert.ok(body[3] === 255 && body[2] > body[0] + 100, `bulle bleue attendue au centre, obtenu ${body}`)
  for (const eyeX of [47, 73]) {
    const eye = view(eyeX, 53)
    assert.ok(eye[3] === 255 && eye[0] > 230 && eye[1] > 230 && eye[2] > 230, `œil blanc attendu en ${eyeX}, obtenu ${eye}`)
  }
  const between = view(60, 53)
  assert.ok(between[2] > between[0] + 100, `du bleu entre les deux yeux (deux yeux distincts), obtenu ${between}`)
})
