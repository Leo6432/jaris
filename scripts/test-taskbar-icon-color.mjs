// Étape 394 (Léo : « c'est pas possible que le logo en bas de Jaris change aussi de couleur ? ») : l'icône de la barre des
// tâches et celle près de l'horloge prennent la couleur de l'orbe. Régression : node --test scripts/test-taskbar-icon-color.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsModule } from './load-ts-module.mjs'

const { EMOTION_COLORS, tintPixels, isOrbEmotion, dotPixels } = loadTsModule('shared/emotionColors.ts')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('recolorer garde la transparence et l’intensité, change seulement la teinte', () => {
  // Pixels B-V-R-A : cyan plein du logo, cyan à moitié éteint (lueur), pixel transparent.
  const logo = new Uint8Array([253, 251, 50, 255, 126, 125, 25, 128, 0, 0, 0, 0])
  const out = tintPixels(logo, EMOTION_COLORS.thinking, true) // #ffb648 → B=0x48, V=0xb6, R=0xff
  assert.deepEqual([...out.slice(0, 4)], [Math.round(0x48 * 253 / 255), Math.round(0xb6 * 253 / 255), Math.round(0xff * 253 / 255), 255])
  assert.ok(out[4] < out[0] && out[6] < out[2], 'la lueur reste plus sombre que le trait')
  assert.equal(out[7], 128, 'transparence gardée')
  assert.deepEqual([...out.slice(8)], [0, 0, 0, 0])
  // Ordre R-V-B-A (macOS) : même couleur, dans l'autre ordre.
  const rgba = tintPixels(new Uint8Array([255, 255, 255, 255]), '#ffb648', false)
  assert.deepEqual([...rgba], [255, 182, 72, 255])
})

test('les émotions reconnues sont exactement celles de l’orbe', () => {
  assert.deepEqual(Object.keys(EMOTION_COLORS).sort(), ['happy', 'idle', 'listening', 'surprised', 'thinking'])
  assert.ok(isOrbEmotion('thinking'))
  assert.ok(!isOrbEmotion('toString'), 'une propriété héritée n’est pas une émotion')
  assert.ok(!isOrbEmotion(42))
  // L'orbe animée lit la même table (aucune couleur recopiée à la main).
  assert.match(read('src/components/JarisOrb.tsx'), /idle: \{ color: EMOTION_COLORS\.idle/)
})

test('seule la grande fenêtre change l’icône, et seulement pour une émotion connue', () => {
  const main = read('electron/main.ts')
  const start = main.indexOf('ipcMain.on(IPC_CHANNELS.setShownEmotion')
  assert.ok(start > 0)
  const handler = main.slice(start, main.indexOf('\n  })', start))
  assert.match(handler, /event\.sender !== fullWindow\.webContents\) return/)
  assert.match(handler, /!isOrbEmotion\(emotion\)/)
  assert.match(handler, /fullWindow\.setIcon\(appIconFor\(emotion\)\)/)
  assert.match(handler, /tray\?\.setImage\(trayIconFor\(emotion\)\)/)
  // Étape 395 : épinglé, Windows garde l'icône du raccourci — la pastille en coin s'affiche quand même, retirée au repos.
  assert.match(handler, /process\.platform === 'win32'\) fullWindow\.setOverlayIcon\(overlayIconFor\(emotion\), t\(`app\.status\.\$\{emotion\}`\)\)/)
  assert.match(read('electron/services/trayIcon.ts'), /if \(emotion === 'idle'\) return null/)
  // Au repos : les icônes d'origine, réduites proprement (étape 224), jamais une version recolorée.
  const tray = read('electron/services/trayIcon.ts')
  assert.match(tray, /emotion === 'idle' \? createAppIcon\(\)/)
  assert.match(tray, /emotion === 'idle' \? createTrayIcon\(\)/)
})

test('la pastille en coin : ronde, de la couleur de l’orbe, transparente hors du rond', () => {
  const size = 32
  const px = dotPixels(size, EMOTION_COLORS.thinking, true)
  const at = (x, y) => [...px.slice((y * size + x) * 4, (y * size + x) * 4 + 4)]
  assert.deepEqual(at(16, 16), [0x48, 0xb6, 0xff, 255], 'centre : couleur de l’orbe, opaque (B-V-R-A)')
  assert.equal(at(0, 0)[3], 0, 'coin transparent')
  assert.equal(at(31, 31)[3], 0)
  const edge = at(16, 0) // bord : anneau sombre
  assert.ok(edge[3] > 0 && edge[2] < 0xff, 'bord sombre et visible')
})
