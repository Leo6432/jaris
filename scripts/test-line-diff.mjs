import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Différence ligne à ligne (étape 277) : c'est ce que Léo lit avant d'enregistrer des changements sur GitHub.
 * Un diff faux, c'est un changement enregistré qu'il n'a jamais vu — d'où des cas exacts, pas des à-peu-près.
 */
const { diffLines, splitLines } = loadTsModule('shared/lineDiff.ts')

const lines = (diff) => diff.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`))

test('une ligne changée au milieu : retirée puis ajoutée, avec 3 lignes de contexte', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n') + '\n'
  const after = before.replace('e\n', 'E\n')
  const diff = diffLines(before, after)
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
  assert.deepEqual(lines(diff), [' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h'])
})

test('fichier créé et fichier supprimé', () => {
  const created = diffLines(null, 'un\ndeux\n')
  assert.deepEqual([created.added, created.removed], [2, 0])
  assert.deepEqual(lines(created), ['+un', '+deux'])
  const deleted = diffLines('un\ndeux\n', null)
  assert.deepEqual([deleted.added, deleted.removed], [0, 2])
})

test('deux changements éloignés donnent deux blocs séparés', () => {
  const base = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`)
  const changed = [...base]
  changed[2] = 'CHANGÉ 3'
  changed[26] = 'CHANGÉ 27'
  const diff = diffLines(base.join('\n'), changed.join('\n'))
  assert.equal(diff.hunks.length, 2)
  // Numéros de ligne exacts des deux côtés.
  const deleted = diff.hunks[1].lines.find((line) => line.kind === 'del')
  assert.equal(deleted.oldNo, 27)
  const added = diff.hunks[1].lines.find((line) => line.kind === 'add')
  assert.equal(added.newNo, 27)
})

test('insertion pure : rien de retiré, et le reste reconnu comme identique', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nb\nnouvelle\nc\n')
  assert.deepEqual([diff.added, diff.removed], [1, 0])
  assert.deepEqual(lines(diff), [' a', ' b', '+nouvelle', ' c'])
})

test('un fichier Windows (CRLF) identique ne paraît pas changé partout', () => {
  const diff = diffLines('a\r\nb\r\n', 'a\nb\n')
  assert.deepEqual([diff.added, diff.removed, diff.hunks.length], [0, 0, 0])
  assert.deepEqual(splitLines('x\r\ny'), ['x', 'y'])
})

test('identique : aucun bloc', () => {
  assert.equal(diffLines('a\nb', 'a\nb').hunks.length, 0)
})

test("un fichier réécrit de bout en bout ne gèle pas l'écran et reste juste", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `ancienne ${i}`).join('\n')
  const after = Array.from({ length: 3000 }, (_, i) => `nouvelle ${i}`).join('\n')
  const started = Date.now()
  const diff = diffLines(before, after)
  assert.ok(Date.now() - started < 2000, 'calcul trop long')
  assert.deepEqual([diff.added, diff.removed], [3000, 3000])
})
