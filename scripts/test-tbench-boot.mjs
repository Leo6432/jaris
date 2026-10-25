import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Étape 352 : la borne de 250 réponses du modèle par essai (python/tbench_boot.py), testée en Python sur un faux
// Terminus 2 (scripts/test-tbench-boot.py). Python n'est pas garanti pendant `npm test` : le test est alors ignoré
// avec sa raison, jamais silencieusement vert (la CI le relance aussi après avoir installé Python 3.12).

function findPython() {
  for (const bin of ['python3', 'python']) {
    try {
      if (spawnSync(bin, ['--version']).status === 0) return bin
    } catch {
      continue
    }
  }
  return null
}

const python = findPython()

test(
  'Terminus 2 borné à 250 réponses du modèle, réponses trop longues comprises, sans récursion',
  { skip: python ? false : 'Python indisponible dans cet environnement' },
  () => {
    const run = spawnSync(python, [fileURLToPath(new URL('./test-tbench-boot.py', import.meta.url))], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 240_000
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, /Ran 5 tests/)
  }
)
