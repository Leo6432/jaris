import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { i18nModule } from './i18n-test-module.mjs'

/**
 * Les nombres affichés suivent la langue de Jaris. Jusqu'à la version 0.34.31 :
 * - l'Intelligence Index s'écrivait toujours à la française (« 13,1 », locale figée 'fr-FR'), même en anglais ;
 * - une VRAM ou une taille avec décimale passait par `String(x)` ou `toFixed(1)`, donc avec un point dans TOUTES les
 *   langues (« 5.8 Go » en français, « 5.8 GB » en allemand).
 * Désormais tout passe par formatDecimal (shared/i18n), sur la langue courante.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const catalog = (code) => JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${code}.json`), 'utf8'))

function inLanguage(code, run) {
  i18nModule.setLanguage(code, code === 'fr' ? undefined : catalog(code))
  try {
    return run()
  } finally {
    i18nModule.setLanguage('fr')
  }
}

const { formatIntelligenceIndex } = loadTsModule('src/lib/formatIntelligenceIndex.ts')
const imageModel = loadTsModule('shared/imageModel.ts')
const pilotModel = loadTsModule('shared/pilotModel.ts')
const videoModel = loadTsModule('shared/videoModel.ts')
const { formatBytes } = loadTsModule('shared/formatBytes.ts')
const { imageLabelFromFileName } = loadTsModule('shared/imageGallery.ts')

test('Intelligence Index : « 13,1 » en français et en allemand, « 13.1 » en anglais', () => {
  assert.equal(inLanguage('fr', () => formatIntelligenceIndex(13.1)), '13,1')
  assert.equal(inLanguage('de', () => formatIntelligenceIndex(13.1)), '13,1')
  assert.equal(inLanguage('en', () => formatIntelligenceIndex(13.1)), '13.1')
  assert.equal(inLanguage('en', () => formatIntelligenceIndex(7)), '7.0', 'toujours une décimale, comme les données du site')
})

test('formatDecimal : une décimale au plus, sans zéro inutile, à la façon de la langue', () => {
  const { formatDecimal } = i18nModule
  assert.equal(inLanguage('fr', () => formatDecimal(5.8)), '5,8')
  assert.equal(inLanguage('en', () => formatDecimal(5.8)), '5.8')
  assert.equal(inLanguage('fr', () => formatDecimal(8)), '8')
  assert.equal(inLanguage('fr', () => formatDecimal(8, 1)), '8,0')
  assert.equal(inLanguage('en', () => formatDecimal(75.04, 1)), '75.0')
})

test('carte graphique trop petite : « 4,8 Go » en français, « 4.8 GB » en anglais (image, vidéo, pilotage)', () => {
  // nvidia-smi donne la VRAM au dixième près (hardwareScan.ts) : une carte « 5 Go » est lue 4,8.
  const reasons = () => [imageModel.pickImageModel(4.8, 32).reason, pilotModel.pickPilotModel(4.8).reason, videoModel.availableVideoQualities(4.8, 32).reason]
  const fr = inLanguage('fr', reasons)
  const en = inLanguage('en', reasons)
  for (const reason of fr) {
    assert.match(reason ?? '', /4,8 Go/, String(reason))
    assert.doesNotMatch(reason ?? '', /4\.8/, String(reason))
  }
  for (const reason of en) {
    assert.match(reason ?? '', /4\.8 GB/, String(reason))
    assert.doesNotMatch(reason ?? '', /4,8/, String(reason))
  }
})

test('tailles de fichiers : « 1,5 Go » en français, « 1.5 GB » en anglais', () => {
  assert.equal(inLanguage('fr', () => formatBytes(1.5 * 1024 ** 3)), '1,5 Go')
  assert.equal(inLanguage('en', () => formatBytes(1.5 * 1024 ** 3)), '1.5 GB')
})

test('nom par défaut d’une création sans mot lisible : dans la langue de Jaris', () => {
  // Une demande en russe ou en grec ne laisse aucun mot dans le nom de fichier (a-z, 0-9 seulement).
  assert.equal(inLanguage('fr', () => imageLabelFromFileName('2026-09-28T17-22-15-video.webm')), 'Vidéo')
  assert.equal(inLanguage('en', () => imageLabelFromFileName('2026-09-28T17-22-15-video.webm')), catalog('en')['app.mode.video'])
  assert.equal(inLanguage('de', () => imageLabelFromFileName('2026-09-28T17-22-15-image.png')), catalog('de')['app.mode.image'])
  assert.equal(inLanguage('en', () => imageLabelFromFileName('2026-09-28T17-22-15-un-chat.png')), 'Un chat', 'les mots de Léo restent les siens')
})

/** Le code seul, sans ses commentaires (qui racontent justement l'ancien défaut). */
function codeOf(file) {
  return readFileSync(join(projectRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('aucun format de nombre figé en français ni de toFixed dans ce qui est affiché', () => {
  // Les fichiers corrigés : un retour de 'fr-FR' ou de toFixed() ici réintroduirait le défaut.
  for (const file of [
    'src/lib/formatIntelligenceIndex.ts',
    'shared/formatBytes.ts',
    'shared/imageModel.ts',
    'shared/pilotModel.ts',
    'shared/videoModel.ts',
    'src/components/MyModelPicks.tsx',
    'src/components/CapacityScan.tsx',
    'src/components/AllModelsOverview.tsx'
  ]) {
    assert.doesNotMatch(codeOf(file), /'fr-FR'|toFixed\(/, file)
  }
  for (const file of ['electron/services/ollama.ts', 'electron/services/codeGenerator.ts']) {
    assert.doesNotMatch(codeOf(file), /(tooLarge|diskFull)'[^\r\n]*toFixed\(/, `${file} : taille affichée avec toFixed`)
  }
})
