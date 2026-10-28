import assert from 'node:assert/strict'
import realFs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 355 : les votes des duels sur un VRAI dossier (duelStore.ts + atomicFile.ts) — ils s'ajoutent sans jamais en
 * perdre un, un vote n'est jamais compté deux fois, et un fichier abîmé est rangé de côté au lieu d'être écrasé.
 */
function load(dataRoot) {
  return loadTsModule('electron/services/duelStore.ts', {
    path,
    'fs/promises': realFs.promises,
    './atomicFile': loadTsModule('electron/services/atomicFile.ts', { fs: realFs, 'fs/promises': realFs.promises, path }),
    './dataLocation': { getDataRoot: () => dataRoot },
    '../../shared/duel': loadTsModule('shared/duel.ts')
  })
}

const vote = (id, outcome = 'a') => ({ id, category: 'code', at: 1, sessionId: 's', modelA: 'a:1b', modelB: 'b:2b', outcome, prompt: 'Un jeu' })

test('ajout : écrit d’un seul tenant, relu après un redémarrage, jamais deux fois le même vote', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-duel-store-'))
  try {
    const store = load(dataRoot)
    assert.deepEqual(await store.loadDuelVotes(), [], 'pas de fichier : aucun vote')
    // Deux votes envoyés en même temps : les deux restent (une écriture à la fois).
    await Promise.all([store.addDuelVote(vote('v1')), store.addDuelVote(vote('v2', 'bothBad'))])
    await store.addDuelVote(vote('v1'))
    assert.deepEqual(store.getDuelVotes().map((v) => v.id), ['v1', 'v2'])
    assert.deepEqual(readdirSync(dataRoot), ['duel-votes.json'], 'aucun fichier temporaire laissé')
    const restarted = load(dataRoot)
    assert.deepEqual((await restarted.loadDuelVotes()).map((v) => [v.id, v.outcome]), [['v1', 'a'], ['v2', 'bothBad']])
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('fichier abîmé : rangé de côté, jamais écrasé par une liste vide en silence', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-duel-store-'))
  try {
    writeFileSync(join(dataRoot, 'duel-votes.json'), '{ pas du json')
    const store = load(dataRoot)
    assert.deepEqual(await store.loadDuelVotes(), [])
    await store.addDuelVote(vote('nouveau'))
    const aside = readdirSync(join(dataRoot, 'fichiers-illisibles'))
    assert.equal(aside.length, 1)
    assert.equal(readFileSync(join(dataRoot, 'fichiers-illisibles', aside[0]), 'utf8'), '{ pas du json', 'l’original est gardé tel quel')
    assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'duel-votes.json'), 'utf8')).map((v) => v.id), ['nouveau'])
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('étape 362 : « Télécharger les votes » — toutes les sessions, réponses et applications Code comprises', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-duel-store-'))
  try {
    const store = load(dataRoot)
    await store.loadDuelVotes()
    const side = (text, app) => ({ text, actions: [], durationMs: 1200, error: null, app })
    const id = '11111111-2222-4333-8444-555555555555'
    await store.addDuelVote({ ...vote(id), at: 20, sessionId: 's2', sides: { a: side('réponse A', true), b: side('réponse B', false) } })
    await store.addDuelVote({ ...vote('ancien'), at: 10, sessionId: 's1', category: 'conversation' })
    await store.saveDuelApp(id, 'a', '<p>jeu</p>')
    const { json, count } = await store.buildDuelVotesExport('0.40.4', new Date(2026, 9, 28, 12))
    const data = JSON.parse(json)
    assert.equal(count, 2)
    assert.equal(data.format, 'jaris-duel-votes')
    assert.equal(data.appVersion, '0.40.4')
    assert.equal(data.sessions, 2)
    assert.equal(data.votes.map((v) => v.id).join(), `ancien,${id}`, 'du plus ancien au plus récent')
    assert.equal(data.votes[1].sides.a.text, 'réponse A')
    assert.equal(data.apps[`${id}-a`], '<p>jeu</p>')
    assert.equal(Object.keys(data.apps).length, 1)
    assert.equal(store.defaultDuelExportName(new Date(2026, 0, 5)), 'jaris-votes-2026-01-05.json')
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
