// Étape 393 : l'orbe animée a la forme exacte du logo (Léo : « c'est un peu au hasard les cercles, fais en sorte que ce
// soit pareil que le logo »). Vérifie la courbe contre le VRAI logo (assets/jaris-logo.png), pixel par pixel, et que la
// copie de la page du téléphone est identique.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadTsModule } from './load-ts-module.mjs'

const require = createRequire(import.meta.url)
const { LOGO_LOOP, logoLoopOffset } = loadTsModule('shared/logoOrb.ts')
/** Les mesures ont été prises dans le cadrage du logo, puis ramenées à l'échelle du canvas (×0,9231). */
const SCALE = 0.9231

async function logoAlpha() {
  const sharp = require('sharp')
  const frame = JSON.parse(readFileSync(new URL('../assets/icon-frame.json', import.meta.url), 'utf8'))
  const { data, info } = await sharp(fileURLToPath(new URL('../assets/jaris-logo.png', import.meta.url)))
    .extract(frame)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const half = info.width / 2
  return (u, theta) => {
    const r = (u / SCALE) * half
    const x = Math.round(half + r * Math.cos(theta))
    const y = Math.round(half + r * Math.sin(theta))
    return data[(y * info.width + x) * 4 + 3]
  }
}

test('la courbe ondulée de l\'orbe suit le trait du logo sur ses deux tours', async () => {
  const alpha = await logoAlpha()
  let onStroke = 0
  const samples = 1440
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * Math.PI * 4
    if (alpha(LOGO_LOOP.base + logoLoopOffset(theta), theta) > 150) onStroke++
  }
  assert.ok(onStroke / samples > 0.95, `seulement ${onStroke}/${samples} points sur le trait du logo`)
})

test('les deux cercles et le noyau sont là où le logo les dessine', async () => {
  const alpha = await logoAlpha()
  for (const radius of LOGO_LOOP.circles) {
    let on = 0
    for (let i = 0; i < 360; i++) if (alpha(radius, (i / 360) * Math.PI * 2) > 150) on++
    assert.ok(on > 340, `cercle ${radius} : ${on}/360 points sur le trait du logo`)
  }
  // Le noyau : plein au centre, vide entre lui et le premier cercle.
  assert.ok(alpha(LOGO_LOOP.core * 0.5, 0.3) > 100)
  for (let i = 0; i < 36; i++) assert.ok(alpha((LOGO_LOOP.core + Math.min(...LOGO_LOOP.circles)) / 2 + 0.03, (i / 36) * Math.PI * 2) < 40)
})

test('plus aucun anneau tiré au hasard : la même forme partout', () => {
  const orb = readFileSync(new URL('../src/components/JarisOrb.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(orb, /Math\.random/)
  assert.match(orb, /LOGO_LOOP/)
  const phone = readFileSync(new URL('../phone/app.js', import.meta.url), 'utf8')
  assert.doesNotMatch(phone.slice(phone.indexOf('var ORB_STYLES'), phone.indexOf('function setOrbEmotion')), /Math\.random/)
})

test('la page du téléphone a une copie identique de la forme du logo', () => {
  // CRLF sous la CI Windows : normaliser avant de chercher la fin du littéral par '\n  }\n'.
  const phone = readFileSync(new URL('../phone/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = phone.indexOf('var ORB_LOGO = ')
  assert.ok(start > 0)
  const literal = phone.slice(start + 'var ORB_LOGO = '.length, phone.indexOf('\n  }\n', start) + 4)
  const copy = vm.runInNewContext(`(${literal})`)
  assert.equal(JSON.stringify(copy), JSON.stringify({ ...LOGO_LOOP, terms: LOGO_LOOP.terms }))
})
