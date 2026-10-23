import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 346 : le menu « Micro utilisé » (Options → Voix) retrouve le micro par son NOM. Son numéro change dès qu'on
 * branche un casque : le menu montrait alors un AUTRE micro que celui réellement écouté par Jaris.
 */
const { selectedInputDevice } = loadTsModule('src/lib/inputDeviceChoice.ts')

const before = [
  { index: 1, name: 'Micro (Realtek)' },
  { index: 2, name: 'Micro USB' }
]
const afterHeadset = [
  { index: 1, name: 'Micro (Realtek)' },
  { index: 2, name: 'Casque (Hands-Free)' },
  { index: 3, name: 'Micro USB' }
]

test('le micro choisi est retrouvé par son nom même si son numéro a changé', () => {
  const profile = { audioInputDeviceIndex: 2, audioInputDeviceName: 'Micro USB' }
  assert.equal(selectedInputDevice(profile, before), '2')
  assert.equal(selectedInputDevice(profile, afterHeadset), '3')
})

test('micro choisi mais débranché : « par défaut », jamais un autre micro', () => {
  assert.equal(selectedInputDevice({ audioInputDeviceIndex: 2, audioInputDeviceName: 'Micro USB' }, [before[0]]), '')
  assert.equal(selectedInputDevice({ audioInputDeviceIndex: 5 }, before), '')
})

test('ancien profil sans nom : le numéro sert encore ; aucun choix : par défaut', () => {
  assert.equal(selectedInputDevice({ audioInputDeviceIndex: 1 }, before), '1')
  assert.equal(selectedInputDevice({ audioInputDeviceIndex: null }, before), '')
  assert.equal(selectedInputDevice(null, before), '')
})
