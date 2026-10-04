import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { VISION_TEST_CASES, VISION_TOTAL, isCorrectVisionAnswer, loadVisionImage } from './benchmark-vision.mjs'

/**
 * Étape 232 : test de vision version 2 (vraies captures d'écran). Pour chaque image, des réponses qu'un bon modèle
 * peut donner (avec ou sans phrase autour, chiffres ou lettres) doivent compter juste, et les réponses fausses
 * typiques (la valeur voisine, plusieurs valeurs à la fois) doivent compter faux.
 */
const ANSWERS = {
  'bloc-notes-courses.png': {
    good: ['6', 'Six.', 'Il faut acheter 6 œufs.', 'six oeufs'],
    bad: ['4', '2 bouteilles', 'Je ne sais pas.', '6 ou 4']
  },
  'erreur-disque.png': {
    good: ['Rapport annuel.docx', '« Rapport annuel.docx »', 'Le fichier Rapport annuel.docx'],
    bad: ['Le disque D: est plein.', 'Microsoft Word']
  },
  'meteo-villes.png': {
    good: ['14 °C', '14', 'Il fait 14 degrés à Rennes.', 'quatorze degrés'],
    bad: ['16 °C', '12', '14 ou 16 °C']
  },
  'premier-plan.png': {
    good: ['Spotify', 'Spotify Premium', "C'est Spotify."],
    bad: ['Discord', 'Spotify et Discord']
  },
  'tableau-prix.png': {
    good: ['49,90 €', '49.90', '49,9 euros', 'Le clavier coûte 49,90 €.'],
    bad: ['59,90 €', '19,90 €', '49 €']
  },
  'mails-non-lus.png': {
    good: ['4', 'Quatre.', 'Il y a 4 mails non lus.'],
    bad: ['3', '7', '4 sur 7']
  },
  'boutons-enregistrer.png': {
    good: ['Annuler', '« Annuler »', 'Le bouton Annuler.'],
    bad: ['Enregistrer', 'Ne pas enregistrer']
  },
  'horloge.png': {
    good: ['14:37', '14 h 37', '14h37', 'Il est 14 heures 37.', 'quatorze heures trente-sept'],
    bad: ['14:47', '18:50', '4 octobre 2026']
  },
  'youtube-resultats.png': {
    good: ['Apprendre la guitare en 10 minutes – Leçon 1', 'Apprendre la guitare en 10 minutes - Leçon 1'],
    bad: ['Les 5 accords faciles pour débuter', 'tuto guitare']
  },
  'notification-message.png': {
    good: ['Julie Martin', 'Julie', "C'est Julie Martin."],
    bad: ['Marc', 'Messages']
  }
}

test('chaque capture a ses réponses justes et fausses, et le total suit (10 captures × 2)', () => {
  assert.deepEqual(Object.keys(ANSWERS).sort(), VISION_TEST_CASES.map((c) => c.file).sort())
  assert.equal(VISION_TOTAL, 20)
})

for (const testCase of VISION_TEST_CASES) {
  test(`« ${testCase.file} » : réponses justes acceptées, fausses refusées`, () => {
    for (const a of ANSWERS[testCase.file].good) assert.equal(isCorrectVisionAnswer(testCase, a), true, `devait être juste : ${a}`)
    for (const a of ANSWERS[testCase.file].bad) assert.equal(isCorrectVisionAnswer(testCase, a), false, `devait être faux : ${a}`)
  })
}

test('les captures existent, en 1280x720 (la taille envoyée par look_at_screen), et partent avec l’installeur', () => {
  for (const testCase of VISION_TEST_CASES) {
    const png = Buffer.from(loadVisionImage(testCase), 'base64')
    assert.equal(png.subarray(1, 4).toString(), 'PNG', testCase.file)
    assert.equal(png.readUInt32BE(16), 1280, `${testCase.file} : largeur`)
    assert.equal(png.readUInt32BE(20), 720, `${testCase.file} : hauteur`)
  }
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  for (const file of ['benchmark-vision.mjs', 'benchmark-code.mjs', 'benchmark-browser.mjs', 'benchmark-scenarios.mjs', 'vision-tests/*.png']) {
    assert.ok(builder.includes(`- ${file}`), `${file} absent de electron-builder.yml`)
  }
  // Le script qui fabrique les captures produit exactement ces fichiers.
  const maker = readFileSync(new URL('./make-vision-tests.mjs', import.meta.url), 'utf8')
  for (const testCase of VISION_TEST_CASES) assert.ok(maker.includes(`'${testCase.file.replace('.png', '')}'`), testCase.file)
  assert.ok(existsSync(new URL('./vision-tests/', import.meta.url)))
})
