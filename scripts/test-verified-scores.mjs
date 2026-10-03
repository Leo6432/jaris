import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Étape 166 : l'analyse des modèles est retirée de Jaris, scripts/verified-tool-scores.md devient la SEULE
 * source des scores. Deux garde-fous permanents :
 * - aucun score de conversation d'un AUTRE test que le test actuel (78 réponses) (l'ancien test à 6 questions coupait
 *   les consignes faute de place ; gardé, le 6/6 de G9v3-3B passait devant des modèles mesurés sur 17) ;
 * - plus aucun fichier de résultats local lu par l'application (il ne pourrait plus jamais être remis à jour).
 */
const scores = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function section(name) {
  const start = scores.indexOf(`## ${name}`)
  const end = scores.indexOf('\n## ', start + 1)
  return scores.slice(start, end === -1 ? undefined : end)
}

const rows = (text) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Modèle'))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean))

test('conversation : tous les scores viennent du test sur 78 réponses (test version 6)', () => {
  const conversation = rows(section('Conversation'))
  assert.ok(conversation.length >= 30, `seulement ${conversation.length} scores de conversation`)
  for (const [model, score] of conversation) assert.match(score, /^\d+\/78$/, `${model} : ${score}`)
})

test('vision sur 18 et code sur 3 (une mesure incomplète ne doit pas être recopiée)', () => {
  for (const [model, score] of rows(section('Vision'))) assert.match(score, /^\d+\/18$/, `Vision ${model} : ${score}`)
  for (const [model, score] of rows(section('Code'))) assert.match(score, /^\d\/3$/, `Code ${model} : ${score}`)
})

test('l’application ne lit plus aucun fichier de résultats local', () => {
  const hardwareScan = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(hardwareScan, /readFileSync\([^)]*benchmark-results/)
  assert.doesNotMatch(hardwareScan, /parseLocalBenchmark/)
  assert.match(hardwareScan, /verified-tool-scores\.md/)
})
