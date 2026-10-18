import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 328 : une entité numérique hors de l'Unicode (« &#99999999; ») faisait lever String.fromCodePoint, et toute
 * la lecture de la page échouait pour un seul caractère. Elle reste maintenant écrite telle quelle.
 */
const { readWebPage } = loadTsModule('electron/services/webPage.ts')

async function readWith(html) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  try {
    return await readWebPage('https://exemple.fr/page')
  } finally {
    globalThis.fetch = realFetch
  }
}

test('une entité hors de l’Unicode ne fait plus échouer la lecture de la page', async () => {
  const text = await readWith('<p>Prix&#160;: 12&#x20AC; &#99999999; &#xD800; &#x110000; fin</p>')
  assert.equal(text, 'Prix : 12€ &#99999999; &#xD800; &#x110000; fin')
})
