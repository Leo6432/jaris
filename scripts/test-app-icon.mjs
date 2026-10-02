// Étape 224 (Léo : « le logo de l'application bug ») : l'icône Windows doit être un vrai .ico multi-tailles,
// tiré du logo actuel et réduit proprement à chaque taille, et réellement utilisé par les fenêtres.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { ICON_SIZES, buildIco, logoPath, readIconFrame } from './build-icon.mjs'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root))
// build/ n'est pas dans Git : l'icône est fabriquée au moment de `npm run dist`, exactement comme ici.
const ico = await buildIco(logoPath(), readIconFrame())

function entries() {
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icône')
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, i) => {
    const at = 6 + 16 * i
    const size = ico.readUInt8(at) || 256
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    return { size, data: ico.subarray(offset, offset + length) }
  })
}

test('le .ico contient chaque taille demandée par Windows, 256 px en PNG et les autres en bitmap', () => {
  const list = entries()
  assert.deepEqual(list.map((e) => e.size), ICON_SIZES)
  for (const { size, data } of list) {
    if (size === 256) {
      assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG')
    } else {
      assert.equal(data.readUInt32LE(0), 40, `${size} px : en-tête bitmap`)
      assert.equal(data.readInt32LE(4), size)
      assert.equal(data.readInt32LE(8), size * 2, `${size} px : hauteur doublée (image + masque)`)
      assert.equal(data.readUInt16LE(14), 32)
    }
  }
})

test('chaque taille est le VRAI logo réduit proprement (pas l’ancien rond, pas un motif bruité)', async () => {
  const sharp = require('sharp')
  const frame = readIconFrame()
  const square = await sharp(logoPath())
    .extract({ left: frame.left, top: frame.top, width: frame.width, height: frame.height })
    .png()
    .toBuffer()
  for (const { size, data } of entries().filter((e) => e.size < 256)) {
    const expected = await sharp(square).resize(size, size, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer()
    let worst = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = 40 + ((size - 1 - y) * size + x) * 4
        const q = (y * size + x) * 4
        worst = Math.max(
          worst,
          Math.abs(data[p] - expected[q + 2]),
          Math.abs(data[p + 1] - expected[q + 1]),
          Math.abs(data[p + 2] - expected[q]),
          Math.abs(data[p + 3] - expected[q + 3])
        )
      }
    }
    assert.ok(worst <= 3, `${size} px : écart maximal ${worst} avec le logo réduit`)
  }
})

test('les fenêtres utilisent ce .ico sous Windows, et l’installeur l’embarque hors de l’archive asar', () => {
  const tray = read('electron/services/trayIcon.ts').toString('utf8')
  assert.match(tray, /join\(resourcesRoot\(\), 'build', 'icon\.ico'\)/)
  assert.equal((tray.match(/createFromPath\(windowsIconPath\(\)\)/g) ?? []).length, 2, 'fenêtre ET zone de notification')
  const builder = read('electron-builder.yml').toString('utf8')
  assert.match(builder, /- from: build\/icon\.ico\s+to: build\/icon\.ico/)
  assert.match(builder, /icon: build\/icon\.ico/)
  const pkg = JSON.parse(read('package.json').toString('utf8'))
  assert.match(pkg.scripts.dist, /^node scripts\/build-icon\.mjs && /, 'icône fabriquée avant chaque installeur')
})
