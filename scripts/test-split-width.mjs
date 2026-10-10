import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Poignée entre la conversation et l'aperçu du mode Code (étape 283, Léo : « pouvoir régler la taille de
 * l'aperçu »). Aucune des deux colonnes ne doit pouvoir disparaître sous la poignée.
 */
const { clampChatWidth, CHAT_MIN_WIDTH, PREVIEW_MIN_WIDTH } = loadTsModule('src/lib/splitWidth.ts')

test('la largeur suit la poignée entre les deux limites', () => {
  assert.equal(clampChatWidth(500, 1200), 500)
  assert.equal(clampChatWidth(120, 1200), CHAT_MIN_WIDTH, 'la conversation garde de quoi écrire')
  assert.equal(clampChatWidth(1100, 1200), 1200 - PREVIEW_MIN_WIDTH, "l'aperçu garde sa largeur minimale")
  assert.equal(clampChatWidth(433.6, 1200), 434)
})

test('zone trop étroite pour les deux minimums : la conversation garde son minimum', () => {
  assert.equal(clampChatWidth(500, 500), CHAT_MIN_WIDTH)
})
