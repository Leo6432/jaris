import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { i18nModule } from './i18n-test-module.mjs'
import { loadPhoneModules } from './phone-test-loader.mjs'

/**
 * L'avancement d'un dessin vu depuis le téléphone, dans TOUTES les langues. Jusqu'à la version 0.34.31, la ligne du
 * journal était fabriquée avec la ponctuation de la langue (« Dessin : 2/4 », « Drawing: 2/4 ») mais reconnue en
 * cherchant « <mot> : », avec l'espace française avant les deux-points : hors français, le téléphone n'affichait
 * jamais l'avancement d'un dessin demandé dans la conversation. Désormais UNE seule source fabrique et reconnaît
 * la ligne (engineStepLine / engineStepFromLine, shared/imageGallery.ts).
 *
 * Ici, la ligne vient du VRAI runEngine (imageGenerator.ts), nourri avec la vraie sortie de sd-cli, et part dans le
 * VRAI phoneStatusFromLog (phoneAccess.ts) — les deux bouts de la chaîne, avec le même traducteur partagé.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const nodeRequire = createRequire(import.meta.url)
const catalog = (code) => JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${code}.json`), 'utf8'))

/** Sortie réelle de sd-cli (barres de progression du dessin, lignes copiées d'une génération réelle). */
const SD_OUTPUT = [
  '[INFO   ] image.cpp:524  - get_learned_condition completed, taking 17.34s',
  '  |#######################                           | 67/149 - 3.31GB/s',
  '  |============>                                     | 1/4 - 82.29s/it',
  '  |=========================>                        | 2/4 - 79.24s/it',
  '  |=====================================>            | 3/4 - 79.37s/it',
  '  |==================================================| 4/4 - 79.10s/it'
]

const imageGallery = loadTsModule('shared/imageGallery.ts')
const { phoneStatusFromLog } = loadPhoneModules().load('phoneAccess')

function loadRunEngine() {
  const fakeChildProcess = {
    execFile: (_file, _args, _opts, cb) => cb?.(null),
    spawn() {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => {}
      setImmediate(() => {
        for (const line of SD_OUTPUT) proc.stdout.emit('data', Buffer.from(`${line}\r`))
        proc.emit('close', 0)
      })
      return proc
    }
  }
  const generator = loadTsModule('electron/services/imageGenerator.ts', {
    child_process: fakeChildProcess,
    crypto: nodeRequire('crypto'),
    fs: nodeRequire('fs'),
    'fs/promises': nodeRequire('fs/promises'),
    path: nodeRequire('path'),
    './dataLocation': { getDataRoot: () => projectRoot },
    './download': { downloadToFile: async () => 0 },
    './ollama': { unloadOllamaModels: async () => [] },
    './hardwareScan': { detectGpu: async () => ({ name: null, vramGb: 8 }) },
    './systemResources': { detectRamGb: () => 32 },
    '../../shared/imageModel': loadTsModule('shared/imageModel.ts'),
    '../../shared/formatBytes': loadTsModule('shared/formatBytes.ts'),
    '../../shared/imageGallery': imageGallery
  })
  return generator.runEngine
}

const runEngine = loadRunEngine()

/** Le journal d'un vrai runEngine (sortie de sd-cli simulée) dans la langue `code`. */
async function engineLog(code, wording) {
  i18nModule.setLanguage(code, code === 'fr' ? undefined : catalog(code))
  try {
    const lines = []
    await runEngine('sd-cli.exe', [], (line) => lines.push(line), undefined, wording)
    return lines
  } finally {
    i18nModule.setLanguage('fr')
  }
}

async function phoneStatuses(code) {
  i18nModule.setLanguage(code, code === 'fr' ? undefined : catalog(code))
  try {
    const lines = []
    await runEngine('sd-cli.exe', [], (line) => lines.push(line))
    return { lines, statuses: lines.map((line) => phoneStatusFromLog(line)).filter((status) => status !== null) }
  } finally {
    i18nModule.setLanguage('fr')
  }
}

test('en français : le téléphone voit « Dessin : 1/4 » … « Dessin : 4/4 »', async () => {
  const { statuses } = await phoneStatuses('fr')
  assert.deepEqual(statuses, ['Dessin : 1/4', 'Dessin : 2/4', 'Dessin : 3/4', 'Dessin : 4/4'])
})

for (const [code, word] of [['en', 'Drawing'], ['de', 'Zeichnen'], ['ru', 'Рисование']]) {
  test(`en ${code} : la ligne fabriquée par runEngine est reconnue par le téléphone (« ${word}: 2/4 »)`, async () => {
    const { lines, statuses } = await phoneStatuses(code)
    assert.ok(lines.includes(`${word}: 2/4`), `runEngine écrit « ${word}: 2/4 » (journal : ${JSON.stringify(lines)})`)
    assert.deepEqual(statuses, [`${word}: 1/4`, `${word}: 2/4`, `${word}: 3/4`, `${word}: 4/4`])
  })
}

test('une autre ligne qui finit par « 2/4 » n’est jamais prise pour une étape du dessin', () => {
  i18nModule.setLanguage('en', catalog('en'))
  try {
    assert.equal(imageGallery.engineStepFromLine('Requested translation: « 2/4 »', 'engine.step.image'), null)
    assert.equal(imageGallery.engineStepFromLine('Video: 2/4', 'engine.step.image'), null, 'une étape de vidéo n’est pas un dessin')
    assert.equal(imageGallery.engineStepFromLine('Drawing: 5/4', 'engine.step.image'), null)
    assert.equal(phoneStatusFromLog('Something else: 2/4'), null)
  } finally {
    i18nModule.setLanguage('fr')
  }
})

test('vidéo : « Vidéo : 2/4 » en français, « Video: 2/4 » en anglais, et la barre du PC lit l’étape dans les deux', async () => {
  // Les mots de la vidéo (VIDEO_WORDING, videoGenerator.ts) : relus dans le source pour ne pas tester une copie.
  const source = readFileSync(join(projectRoot, 'electron/services/videoGenerator.ts'), 'utf8')
  const match = /^const VIDEO_WORDING: EngineWording = (\{[^}]*\})\r?$/m.exec(source)
  assert.ok(match, 'VIDEO_WORDING introuvable dans videoGenerator.ts')
  const wording = Function(`return (${match[1]})`)()
  assert.equal(wording.step, 'engine.step.video')

  const fr = await engineLog('fr', wording)
  const en = await engineLog('en', wording)
  assert.ok(fr.includes('Vidéo : 2/4'), JSON.stringify(fr))
  assert.ok(en.includes('Video: 2/4'), JSON.stringify(en))
  // L'onglet Vidéo du téléphone affiche ces lignes telles quelles : elles doivent être entièrement dans la langue.
  assert.ok(!en.some((line) => /Vidéo :|Dessin :/.test(line)), JSON.stringify(en))
  i18nModule.setLanguage('en', catalog('en'))
  try {
    assert.deepEqual({ ...imageGallery.engineStepFromLine('Video: 2/4', 'engine.step.video') }, { step: 2, total: 4 })
    assert.deepEqual({ ...imageGallery.imageStepFromLog('Video: 2/4') }, { step: 2, total: 4 })
  } finally {
    i18nModule.setLanguage('fr')
  }
})
