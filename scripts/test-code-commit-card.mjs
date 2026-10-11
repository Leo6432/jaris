import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 302 (Léo : « pourquoi les boutons disparaissent quand je relance ») : le commit enregistré est attaché à la
 * carte du DERNIER travail, et gardé avec la conversation — il reste consultable après une relance.
 */
const { attachCommit } = loadTsModule('src/lib/codeConversations.ts', { './savedSetting': { readSaved: () => null, writeSaved: () => {} } })
const commit = { url: 'https://github.com/leo/projet/commit/abc', sha: 'abc' }
const card = (id) => ({ id, kind: 'changes', files: [{ path: 'README.md', kind: 'modified', added: 1, removed: 1 }] })

test('le commit va sur la carte du dernier travail, et seulement elle', () => {
  const turns = [card(1), { id: 2, kind: 'user', text: 'autre chose' }, card(3), { id: 4, kind: 'reply', text: 'Enregistré' }]
  const next = attachCommit(turns, commit)
  assert.equal(next[2].commit.url, commit.url)
  assert.equal(next[0].commit, undefined, 'une carte plus ancienne ne reçoit pas un commit qui n’est pas le sien')
  assert.equal(turns[2].commit, undefined, 'la conversation d’origine n’est pas modifiée en place')
})

test('aucune carte : la conversation est rendue telle quelle', () => {
  const turns = [{ id: 1, kind: 'user', text: 'x' }]
  assert.equal(attachCommit(turns, commit), turns)
})
