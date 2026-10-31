// Étape 394 (Léo : « c'est pas possible que le logo en bas de Jaris change aussi de couleur ? ») : l'icône de la barre des
// tâches et celle près de l'horloge prennent la couleur de l'orbe. Régression : node --test scripts/test-taskbar-icon-color.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsModule } from './load-ts-module.mjs'

const { EMOTION_COLORS, tintPixels, isOrbEmotion } = loadTsModule('shared/emotionColors.ts')
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
  // Étape 397 (Léo : « enlève la pastille ») : plus aucune pastille en coin de l'icône.
  assert.doesNotMatch(main, /setOverlayIcon/)
  // Au repos : les icônes d'origine, réduites proprement (étape 224), jamais une version recolorée.
  const tray = read('electron/services/trayIcon.ts')
  assert.match(tray, /emotion === 'idle' \? createAppIcon\(\)/)
  assert.match(tray, /emotion === 'idle' \? createTrayIcon\(\)/)
})

// Étape 396 (Léo : « c'est même pas épinglé ») : la pastille marche, mais Windows ignore setIcon() pour le bouton de la
// barre des tâches. Essai : chaque couleur écrite en vrai .ico et déclarée à Windows (setAppDetails, comme Chrome).
test('un .ico lisible par Windows : en-tête, une entrée par taille, PNG à la bonne place', () => {
  const { encodeIco } = loadTsModule('shared/ico.ts')
  const png = (n, fill) => new Uint8Array(n).fill(fill)
  const ico = encodeIco([{ size: 16, png: png(10, 1) }, { size: 256, png: png(20, 2) }])
  const view = new DataView(ico.buffer)
  assert.equal(view.getUint16(0, true), 0)
  assert.equal(view.getUint16(2, true), 1, 'type icône')
  assert.equal(view.getUint16(4, true), 2, 'deux tailles')
  assert.equal(ico[6], 16)
  assert.equal(ico[6 + 16], 0, '256 s’écrit 0')
  assert.equal(view.getUint16(6 + 6, true), 32, '32 bits par pixel')
  const off1 = view.getUint32(6 + 12, true)
  const off2 = view.getUint32(6 + 16 + 12, true)
  assert.equal(off1, 6 + 32)
  assert.equal(view.getUint32(6 + 8, true), 10)
  assert.deepEqual([...ico.slice(off1, off1 + 10)], Array(10).fill(1))
  assert.deepEqual([...ico.slice(off2, off2 + 20)], Array(20).fill(2))
  assert.equal(ico.length, 6 + 32 + 30)
  assert.throws(() => encodeIco([{ size: 300, png: png(1, 0) }]))
})

test('la couleur part aussi vers Windows comme icône de fenêtre, avec l’identifiant du raccourci', () => {
  const main = read('electron/main.ts')
  const start = main.indexOf('ipcMain.on(IPC_CHANNELS.setShownEmotion')
  const handler = main.slice(start, main.indexOf('\n  })', start))
  assert.match(handler, /applyTaskbarIcon\(fullWindow, emotion\)/)
  assert.match(main, /appIconPath: taskbarIcons\[emotion\]/)
  const appId = read('electron-builder.yml').match(/^appId: (.+)$/m)[1].trim()
  assert.match(main, new RegExp(`TASKBAR_APP_ID = '${appId.replace(/\./g, '\\.')}'`), 'même identifiant que le raccourci de l’installeur')
  assert.match(main, /applyTaskbarIcon\(win, iconEmotion\)\n  return win/, 'une fenêtre recréée reprend la bonne couleur')
  assert.match(read('electron/services/trayIcon.ts'), /paths = \{ idle: windowsIconPath\(\) \}/, 'au repos : le .ico d’origine')
})
