import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/imageAttachment.ts (étape 91) prépare une image jointe avant de l'envoyer au modèle de vision.
 * Le redimensionnement lui-même a besoin d'un vrai `canvas` (donc d'un navigateur, vérifié à part par
 * scripts/test-image-attachment-ui.mjs), mais le CALCUL de la taille cible est une fonction pure, isolée
 * exprès pour être testée directement ici — même principe que findElementByName (uiAutomation.ts) : mettre
 * du côté vérifiable ce qui peut l'être.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/imageAttachment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Chargé dans le realm COURANT (pas via runInNewContext) : sinon les objets renvoyés ont des prototypes
// différents de ceux du test et `assert.deepEqual` échoue sur "same structure but not reference-equal" —
// piège déjà rencontré et documenté dans CLAUDE.md.
const exports = {}
const load = vm.runInThisContext(`(function (exports, module, require) { ${source} })`)
load(exports, { exports }, () => ({}))
const { computeScaledSize, isSupportedImageType, MAX_IMAGE_WIDTH } = exports

test('une image plus large que la limite est réduite en gardant ses proportions', () => {
  const scaled = computeScaledSize(3840, 2160)
  assert.equal(scaled.width, MAX_IMAGE_WIDTH)
  assert.equal(scaled.height, Math.round((2160 / 3840) * MAX_IMAGE_WIDTH))
  // Proportions conservées : le rapport d'origine doit se retrouver à l'arrondi près.
  assert.ok(Math.abs(scaled.width / scaled.height - 3840 / 2160) < 0.01)
})

test("une image plus petite que la limite n'est JAMAIS agrandie", () => {
  // Agrandir n'ajoute aucun détail au modèle de vision, mais gonflerait le poids transmis.
  assert.deepEqual(computeScaledSize(320, 200), { width: 320, height: 200 })
  assert.deepEqual(computeScaledSize(MAX_IMAGE_WIDTH, 720), { width: MAX_IMAGE_WIDTH, height: 720 })
})

test('une image très haute et étroite garde sa hauteur (seule la largeur est bornée)', () => {
  // Cas réel : une capture de page web entière, beaucoup plus haute que large.
  const scaled = computeScaledSize(900, 6000)
  assert.deepEqual(scaled, { width: 900, height: 6000 })
})

test('une image extrêmement large ne tombe jamais à une hauteur nulle', () => {
  // Sans le Math.max(1, ...), une bannière 10000x3 donnerait une hauteur arrondie à 0, donc un canvas vide.
  const scaled = computeScaledSize(10000, 3)
  assert.equal(scaled.width, MAX_IMAGE_WIDTH)
  assert.ok(scaled.height >= 1)
})

for (const [width, height] of [
  [0, 100],
  [100, 0],
  [-10, 100],
  [Number.NaN, 100]
]) {
  test(`des dimensions invalides sont refusées explicitement : ${width}x${height}`, () => {
    assert.throws(() => computeScaledSize(width, height), /invalides/)
  })
}

test('seuls les vrais formats image sont acceptés', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG']) {
    assert.equal(isSupportedImageType(type), true, type)
  }
  // Un PDF ou un fichier texte collé/déposé ne doit pas être envoyé au modèle de vision comme une image.
  for (const type of ['application/pdf', 'text/plain', '', 'image/svg+xml']) {
    assert.equal(isSupportedImageType(type), false, type)
  }
})
