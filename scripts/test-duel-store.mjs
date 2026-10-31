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

// Étape 398 (Léo : « dans l'historique, pouvoir supprimer des choses ou tout supprimer »).
test('étape 398 : supprimer un duel retire le vote, ses applications, et ne compte plus — même livré avec Jaris', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-duel-store-'))
  const sharedFile = join(dataRoot, 'livres.json')
  const id1 = '11111111-1111-4111-8111-111111111111'
  const id2 = '22222222-2222-4222-8222-222222222222'
  const id3 = '33333333-3333-4333-8333-333333333333'
  try {
    const store = load(dataRoot)
    await store.loadDuelVotes()
    await store.addDuelVote(vote(id1))
    await store.addDuelVote(vote(id2))
    await store.saveDuelApp(id1, 'a', '<p>a</p>')
    await store.saveDuelApp(id2, 'b', '<p>b</p>')
    // id1 a aussi été livré avec Jaris (étape 369), id3 seulement livré.
    writeFileSync(sharedFile, JSON.stringify([vote(id1), vote(id3)]))
    await store.loadSharedDuelVotes(sharedFile)
    const before = store.getRankingVotes()
    assert.deepEqual(before.map((v) => v.id).sort(), [id1, id2, id3])

    assert.equal(await store.deleteDuelVotes([id1]), 1)
    assert.deepEqual(store.getDuelVotes().map((v) => v.id), [id2])
    const after = store.getRankingVotes()
    assert.notEqual(after, before, 'nouvel objet : les calculs mis en cache par référence sont refaits')
    assert.deepEqual(after.map((v) => v.id).sort(), [id2, id3], 'la copie livrée du vote supprimé ne compte plus')
    assert.equal(await store.readDuelApp(id1, 'a'), null, 'son application est effacée')
    assert.equal(await store.readDuelApp(id2, 'b'), '<p>b</p>', 'celle d’un autre duel reste')

    // Après un redémarrage, et même si un disque rebranché ramène l'ancienne liste, il reste supprimé.
    const votesFile = join(dataRoot, 'duel-votes.json')
    writeFileSync(votesFile, JSON.stringify([vote(id1), vote(id2)]))
    const restarted = load(dataRoot)
    await restarted.loadSharedDuelVotes(sharedFile)
    assert.deepEqual((await restarted.loadDuelVotes()).map((v) => v.id), [id2])
    assert.deepEqual(restarted.getRankingVotes().map((v) => v.id).sort(), [id2, id3])

    // Tout supprimer : tous les votes de ce PC ; un vote seulement livré et jamais sur ce PC n'est pas touché.
    assert.equal(await restarted.deleteDuelVotes('all'), 1)
    assert.deepEqual(restarted.getDuelVotes(), [])
    assert.deepEqual(restarted.getRankingVotes().map((v) => v.id), [id3])
    assert.equal(await restarted.readDuelApp(id2, 'b'), null)
    assert.deepEqual(JSON.parse(readFileSync(votesFile, 'utf8')), [])
    assert.equal(await restarted.deleteDuelVotes('all'), 0, 'rien à supprimer : rien ne change')
    // Un nouveau vote après coup compte normalement.
    await restarted.addDuelVote(vote('44444444-4444-4444-8444-444444444444'))
    assert.equal(restarted.getDuelVotes().length, 1)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
