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

test('fond clair : le thème annonce le mode clair et un fond clair', () => {
  assert.match(rules, /color-scheme:\s*light/)
  const bg = rules.match(/--ui-bg:\s*#([0-9a-f]{6})/i)
  assert.ok(bg, 'token --ui-bg introuvable')
  const lum = [0, 2, 4].map((i) => parseInt(bg[1].slice(i, i + 2), 16)).reduce((a, b) => a + b, 0) / 3
  assert.ok(lum > 200, `fond trop sombre (${lum})`)
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

test('l’icône de l’application est la mascotte : visage blanc au centre, coins transparents, corps bleu', async () => {
  const src = readFileSync(new URL('../shared/mascotPixels.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { renderMascotRgba } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  const size = 128
  const px = renderMascotRgba(size)
  const at = (x, y) => Array.from(px.slice((y * size + x) * 4, (y * size + x) * 4 + 4))
  assert.equal(at(0, 0)[3], 0, 'coin haut gauche transparent')
  assert.equal(at(size - 1, size - 1)[3], 0, 'coin bas droit transparent')
  const face = at(Math.round(size * 0.5), Math.round(size * 0.52))
  assert.ok(face[3] === 255 && face[0] > 230 && face[1] > 230 && face[2] > 230, `visage blanc attendu, obtenu ${face}`)
  const body = at(Math.round(size * 0.5), Math.round(size * 0.93))
  assert.ok(body[3] > 200 && body[2] > body[0] + 60, `corps bleu attendu en bas, obtenu ${body}`)
  const eye = at(Math.round(((48 - 7) / 106) * size), Math.round(((63 - 3) / 106) * size))
  assert.ok(eye[0] < 80 && eye[1] < 80, `œil sombre attendu, obtenu ${eye}`)
})
