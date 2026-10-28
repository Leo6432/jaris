import assert from 'node:assert/strict'
import realFs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { importDuelVotes } from './import-duel-votes.mjs'

/**
 * Étape 369 : les votes de Léo livrés avec Jaris (scripts/shared-duel-votes.json) comptent pour tout le monde dans le
 * classement, sans jamais apparaître dans l'historique d'un autre PC, et sans la demande ni les réponses.
 */
const duel = loadTsModule('shared/duel.ts')
function load(dataRoot) {
  return loadTsModule('electron/services/duelStore.ts', {
    path,
    'fs/promises': realFs.promises,
    './atomicFile': loadTsModule('electron/services/atomicFile.ts', { fs: realFs, 'fs/promises': realFs.promises, path }),
    './dataLocation': { getDataRoot: () => dataRoot },
    '../../shared/duel': duel
  })
}
const vote = (id, at = 1) => ({ id, category: 'code', at, sessionId: 's', modelA: 'a:1b', modelB: 'b:2b', outcome: 'a', prompt: 'Un jeu' })

test('le fichier livré contient les votes de Léo, sans demande ni réponses, et donne un classement Code', () => {
  const votes = JSON.parse(readFileSync(new URL('./shared-duel-votes.json', import.meta.url), 'utf8'))
  const parsed = duel.parseDuelVotes(votes)
  assert.equal(parsed.length, votes.length)
  assert.ok(votes.length >= 3)
  for (const v of votes) assert.deepEqual(Object.keys(v).sort(), ['at', 'category', 'id', 'modelA', 'modelB', 'outcome', 'sessionId'])
  const ranking = duel.rankDuels(parsed.filter((v) => v.category === 'code'))
  assert.ok(ranking.has('qwen3.8:27b') && ranking.has('gemma4:26b'))
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /- shared-duel-votes\.json/)
})

test('classement = votes locaux + livrés, un même vote compté une fois ; historique local seul', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-shared-votes-'))
  try {
    const store = load(dataRoot)
    const file = join(dataRoot, 'shared.json')
    writeFileSync(file, JSON.stringify([vote('v1'), vote('partage', 2)]))
    await store.loadDuelVotes()
    await store.addDuelVote(vote('v1'))
    await store.loadSharedDuelVotes(file)
    assert.deepEqual(store.getRankingVotes().map((v) => v.id), ['v1', 'partage'])
    assert.deepEqual(store.getDuelVotes().map((v) => v.id), ['v1'], 'historique : seulement ce PC')
    assert.equal(store.getRankingVotes(), store.getRankingVotes(), 'même objet tant que rien ne change')
    const exported = JSON.parse((await store.buildDuelVotesExport('0', new Date(0))).json)
    assert.deepEqual(exported.votes.map((v) => v.id), ['v1'], 'export : seulement ce PC')
    assert.deepEqual(await store.loadSharedDuelVotes(join(dataRoot, 'absent.json')), [], 'fichier absent : rien')
    assert.deepEqual(store.getRankingVotes().map((v) => v.id), ['v1'])
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('import : garde les champs du classement, ignore les doublons, refuse un autre format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-import-votes-'))
  try {
    const shared = join(dir, 'shared.json')
    const exp = JSON.stringify({ format: 'jaris-duel-votes', version: 1, votes: [vote('b', 5), vote('a', 3)], apps: {} })
    assert.deepEqual(importDuelVotes(exp, shared), { added: 2, total: 2 })
    assert.deepEqual(importDuelVotes(exp, shared), { added: 0, total: 2 })
    const saved = JSON.parse(readFileSync(shared, 'utf8'))
    assert.deepEqual(saved.map((v) => v.id), ['a', 'b'])
    assert.equal(saved[0].prompt, undefined)
    assert.throws(() => importDuelVotes(JSON.stringify({ votes: [] }), shared), /jaris-duel-votes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
