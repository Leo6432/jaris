import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Étape 346 : un pilote NVIDIA bloqué faisait attendre nvidia-smi sans fin. Relevé avant CHAQUE réponse (Chat et voix),
 * il bloquait alors tout Jaris. Chaque appel à nvidia-smi a maintenant un délai maximal.
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('chaque appel à nvidia-smi a un délai maximal', () => {
  let calls = 0
  for (const path of ['electron/services/hardwareScan.ts', 'electron/services/systemResources.ts']) {
    const source = read(path)
    for (const match of source.matchAll(/execAsync\('nvidia-smi[^']*'/g)) {
      calls++
      const options = source.slice(match.index, source.indexOf(')', match.index + match[0].length) + 1)
      assert.match(options, /timeout:/, `${path} : ${match[0]} sans délai`)
    }
  }
  assert.ok(calls >= 3, `les trois appels connus sont vérifiés (${calls})`)
})

test('Chat : « Arrêter » marche dès l’envoi, même pendant le relevé de la carte graphique', () => {
  const source = read('electron/services/chatSession.ts')
  const send = source.slice(source.indexOf('cancelMemoryExtraction()'))
  assert.ok(send.indexOf('this.running.add(controller)') < send.indexOf('await getLiveGpuStatus()'))
})
